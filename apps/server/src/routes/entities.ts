import {
  decodeCursor,
  decodeRecordId,
  encodeCursor,
  encodeRecordId,
  isAllowed,
  resolveSort,
  searchFilter,
  validateFilter,
  validateRecord,
  type EffectiveSchema,
  type Entity,
  type FieldError,
  type Filter,
  type FilterError,
  type Policy,
} from '@wardenhq/core';
import {
  createRow,
  deleteRow,
  getRow,
  listRows,
  mapWriteError,
  rowVersion,
  updateRow,
  type Database,
  type Row,
  type WriteAction,
} from '@wardenhq/pg-adapter';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;
export const MAX_OFFSET = 100_000;

interface ListQuery {
  filter?: string;
  q?: string;
  sort?: string;
  limit: number;
  offset?: number;
  cursor?: string;
  count: boolean;
}

const listQuerySchema = {
  type: 'object',
  properties: {
    /** JSON-encoded filter AST. */
    filter: { type: 'string', maxLength: 20_000 },
    q: { type: 'string', maxLength: 1000 },
    /** Comma-separated fields, `-` prefix for descending. */
    sort: { type: 'string', maxLength: 1000 },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
    offset: { type: 'integer', minimum: 0, maximum: MAX_OFFSET },
    cursor: { type: 'string', maxLength: 10_000 },
    count: { type: 'boolean', default: false },
  },
} as const;

const MAX_VERSION_LENGTH = 100;

interface CreateBody {
  values: Record<string, unknown>;
}
interface UpdateBody {
  version: string;
  values: Record<string, unknown>;
}
interface DeleteQuery {
  version?: string;
}

// Field values are validated against the entity by `validateRecord`; these only check the shape.
const valuesSchema = { type: 'object' } as const;
const versionSchema = { type: 'string', minLength: 1, maxLength: MAX_VERSION_LENGTH } as const;
const createBodySchema = {
  type: 'object',
  required: ['values'],
  properties: { values: valuesSchema },
} as const;
const updateBodySchema = {
  type: 'object',
  required: ['version', 'values'],
  properties: { version: versionSchema, values: valuesSchema },
} as const;
const deleteQuerySchema = { type: 'object', properties: { version: versionSchema } } as const;

const badRequest = (reply: FastifyReply, message: string, details?: FilterError[] | FieldError[]) =>
  reply
    .code(400)
    .send({ statusCode: 400, error: 'Bad Request', message, ...(details ? { details } : {}) });

const notFound = (reply: FastifyReply) =>
  reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Not Found' });

const conflict = (reply: FastifyReply) =>
  reply.code(409).send({
    statusCode: 409,
    error: 'Conflict',
    message: 'the record has changed since it was read',
  });

/** Rows with a primary key carry the version an update must quote. */
const toItem = (entity: Entity, row: Row) => {
  const id = encodeRecordId(entity, row);
  return { id, ...(id !== null ? { version: rowVersion(entity, row) } : {}), values: row };
};

export function registerEntityRoutes(
  app: FastifyInstance,
  schema: EffectiveSchema,
  db: Database,
  policy: Policy,
) {
  // Hidden entities aren't in the effective schema, so they 404 exactly like nonexistent ones.
  const entities = new Map(schema.entities.map((e) => [e.key, e]));

  // A write's response shows the row only to callers who could read it anyway.
  const written = (req: FastifyRequest, entity: Entity, row: Row) =>
    isAllowed(policy, req.roles ?? [], entity.key, 'read')
      ? toItem(entity, row)
      : { id: encodeRecordId(entity, row) };

  /** Constraint and data errors become 400/409 with field details; anything else is a 500. */
  const writeFailed = async (
    reply: FastifyReply,
    entity: Entity,
    action: WriteAction,
    err: unknown,
  ) => {
    const mapped = await mapWriteError(db, entity, err, action);
    if (!mapped) throw err;
    const error = mapped.status === 409 ? 'Conflict' : 'Bad Request';
    return reply.code(mapped.status).send({
      statusCode: mapped.status,
      error,
      message: mapped.status === 409 ? 'conflicts with existing records' : 'invalid record',
      details: mapped.errors,
    });
  };

  app.get<{ Params: { entity: string }; Querystring: ListQuery }>(
    '/api/entities/:entity',
    { schema: { querystring: listQuerySchema } },
    async (req, reply) => {
      const entity = entities.get(req.params.entity);
      if (!entity) return notFound(reply);
      const { q, limit, offset, cursor, count } = req.query;

      if (cursor !== undefined && offset !== undefined) {
        return badRequest(reply, 'use either cursor or offset, not both');
      }

      const filters: Filter[] = [];
      if (req.query.filter !== undefined) {
        let input: unknown;
        try {
          input = JSON.parse(req.query.filter);
        } catch {
          return badRequest(reply, 'filter must be valid JSON');
        }
        const result = validateFilter(entity, input);
        if (!result.ok) return badRequest(reply, 'invalid filter', result.errors);
        filters.push(result.filter);
      }
      const search = q === undefined ? undefined : searchFilter(entity, q);
      if (search) filters.push(search);

      const sort = resolveSort(entity, req.query.sort);
      if (!sort.ok) return badRequest(reply, sort.message);

      let after;
      if (cursor !== undefined) {
        if (entity.primaryKey.length === 0) {
          return badRequest(reply, `${entity.label} has no primary key; use offset pagination`);
        }
        const decoded = decodeCursor(entity, sort.sort, cursor);
        if (!decoded.ok) return badRequest(reply, decoded.message);
        after = decoded.values;
      }

      const filter = filters.length > 1 ? { and: filters } : filters[0];
      const result = await listRows(db, entity, {
        sort: sort.sort,
        limit,
        count,
        ...(filter ? { filter } : {}),
        ...(offset !== undefined ? { offset } : {}),
        ...(after ? { after } : {}),
      });

      const last = result.rows.at(-1);
      return {
        items: result.rows.map((row) => toItem(entity, row)),
        nextCursor:
          result.hasMore && last && entity.primaryKey.length > 0
            ? encodeCursor(sort.sort, last)
            : null,
        hasMore: result.hasMore,
        ...(result.total !== undefined ? { total: result.total } : {}),
      };
    },
  );

  app.get<{ Params: { entity: string; id: string } }>(
    '/api/entities/:entity/:id',
    async (req, reply) => {
      const entity = entities.get(req.params.entity);
      if (!entity) return notFound(reply);
      const decoded = decodeRecordId(entity, req.params.id);
      if (!decoded.ok) return notFound(reply);
      const row = await getRow(db, entity, decoded.filter);
      return row ? toItem(entity, row) : notFound(reply);
    },
  );

  app.post<{ Params: { entity: string }; Body: CreateBody }>(
    '/api/entities/:entity',
    { schema: { body: createBodySchema } },
    async (req, reply) => {
      const entity = entities.get(req.params.entity);
      if (!entity) return notFound(reply);
      const record = validateRecord(entity, req.body.values, 'create');
      if (!record.ok) return badRequest(reply, 'invalid record', record.errors);
      let row;
      try {
        row = await createRow(db, entity, record.values);
      } catch (err) {
        return writeFailed(reply, entity, 'create', err);
      }
      return reply.code(201).send(written(req, entity, row));
    },
  );

  app.patch<{ Params: { entity: string; id: string }; Body: UpdateBody }>(
    '/api/entities/:entity/:id',
    { schema: { body: updateBodySchema } },
    async (req, reply) => {
      const entity = entities.get(req.params.entity);
      if (!entity) return notFound(reply);
      const decoded = decodeRecordId(entity, req.params.id);
      if (!decoded.ok) return notFound(reply);
      const record = validateRecord(entity, req.body.values, 'update');
      if (!record.ok) return badRequest(reply, 'invalid record', record.errors);
      if (Object.keys(record.values).length === 0) return badRequest(reply, 'no fields to update');
      let result;
      try {
        result = await updateRow(db, entity, decoded.filter, record.values, {
          version: req.body.version,
        });
      } catch (err) {
        return writeFailed(reply, entity, 'update', err);
      }
      if (!result.ok) return result.reason === 'conflict' ? conflict(reply) : notFound(reply);
      return written(req, entity, result.row);
    },
  );

  app.delete<{ Params: { entity: string; id: string }; Querystring: DeleteQuery }>(
    '/api/entities/:entity/:id',
    { schema: { querystring: deleteQuerySchema } },
    async (req, reply) => {
      const entity = entities.get(req.params.entity);
      if (!entity) return notFound(reply);
      const decoded = decodeRecordId(entity, req.params.id);
      if (!decoded.ok) return notFound(reply);
      const { version } = req.query;
      let result;
      try {
        result = await deleteRow(db, entity, decoded.filter, {
          ...(version !== undefined ? { version } : {}),
        });
      } catch (err) {
        return writeFailed(reply, entity, 'delete', err);
      }
      if (!result.ok) return result.reason === 'conflict' ? conflict(reply) : notFound(reply);
      return reply.code(204).send();
    },
  );
}
