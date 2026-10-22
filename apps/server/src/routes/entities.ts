import {
  checkReason,
  decodeCursor,
  decodeRecordId,
  encodeCursor,
  encodeRecordId,
  isAllowed,
  MAX_REASON_LENGTH,
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
  type AuditStore,
} from '@wardenhq/core';
import {
  auditHook,
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
  type WriteOptions,
} from '@wardenhq/pg-adapter';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Views } from '../views.js';
import { NO_NUL } from './schemas.js';

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

/** Every write may say why; the reason is stored in the audit log. */
interface WriteBody {
  reason?: string;
}
interface CreateBody extends WriteBody {
  values: Record<string, unknown>;
}
interface UpdateBody extends WriteBody {
  version: string;
  values: Record<string, unknown>;
}
interface DeleteBody extends WriteBody {
  version?: string;
}

// Field values are validated against the entity by `validateRecord`; these only check the shape.
const valuesSchema = { type: 'object' } as const;
const versionSchema = { type: 'string', minLength: 1, maxLength: MAX_VERSION_LENGTH } as const;
const reasonSchema = { type: 'string', maxLength: MAX_REASON_LENGTH, pattern: NO_NUL } as const;
const createBodySchema = {
  type: 'object',
  required: ['values'],
  properties: { values: valuesSchema, reason: reasonSchema },
} as const;
const updateBodySchema = {
  type: 'object',
  required: ['version', 'values'],
  properties: { version: versionSchema, values: valuesSchema, reason: reasonSchema },
} as const;
// The body is optional: a bare DELETE neither checks the version nor gives a reason.
const deleteBodySchema = {
  type: ['object', 'null'],
  properties: { version: versionSchema, reason: reasonSchema },
} as const;

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

/**
 * A row as `entity` shows it: only its fields, so a row read or written in full is cut down to
 * what the caller may see. Rows with a primary key carry the version an update must quote.
 */
const toItem = (entity: Entity, row: Row) => {
  const id = encodeRecordId(entity, row);
  const values = Object.fromEntries(entity.fields.map((f) => [f.name, row[f.name] ?? null]));
  return { id, ...(id !== null ? { version: rowVersion(entity, row) } : {}), values };
};

export function registerEntityRoutes(
  app: FastifyInstance,
  schema: EffectiveSchema,
  db: Database,
  policy: Policy,
  views: Views,
  audit: AuditStore = { kind: 'warden' },
) {
  // Hidden entities aren't in the effective schema, so they 404 exactly like nonexistent ones.
  const entities = new Map(schema.entities.map((e) => [e.key, e]));

  /**
   * The entity in full, for writing (audit entries record every exposed field), and as the
   * caller sees it, for everything they send or get back: fields they can't read don't exist in
   * the view, and fields they can't write are read-only.
   */
  const lookup = (req: FastifyRequest, key: string) => {
    const entity = entities.get(key);
    const view = views(req.roles).entities.get(key);
    return entity && view ? { entity, view } : undefined;
  };

  // A write's response shows the row only to callers who could read it anyway.
  const written = (req: FastifyRequest, entity: Entity, row: Row) =>
    isAllowed(policy, req.roles ?? [], entity.key, 'read')
      ? toItem(entity, row)
      : { id: encodeRecordId(entity, row) };

  /** The reason `body` gives for `action` on `entity`, checked against what config requires. */
  const reasonFor = (entity: Entity, action: WriteAction, body: WriteBody | null | undefined) =>
    checkReason(
      body?.reason,
      entity.requireReason?.includes(action) ? (entity.reasonMinLength ?? 1) : undefined,
    );

  /** Records the write in the audit log, inside the write's transaction. */
  const audited = (req: FastifyRequest, reason: string | undefined): WriteOptions => {
    const session = req.session!;
    return {
      onWrite: auditHook({
        actor: {
          subject: session.subject,
          ...(session.email ? { email: session.email } : {}),
          roles: req.roles ?? [],
        },
        requestId: req.id,
        ...(reason ? { reason } : {}),
        store: audit,
      }),
    };
  };

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
      // Reads only ever touch the caller's view, so unreadable fields are never selected.
      const entity = lookup(req, req.params.entity)?.view;
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
      const entity = lookup(req, req.params.entity)?.view;
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
      const found = lookup(req, req.params.entity);
      if (!found) return notFound(reply);
      const { entity, view } = found;
      const reason = reasonFor(entity, 'create', req.body);
      if (!reason.ok) return badRequest(reply, reason.message);
      const record = validateRecord(view, req.body.values, 'create');
      if (!record.ok) return badRequest(reply, 'invalid record', record.errors);
      let row;
      try {
        row = await createRow(db, entity, record.values, audited(req, reason.reason));
      } catch (err) {
        return writeFailed(reply, view, 'create', err);
      }
      return reply.code(201).send(written(req, view, row));
    },
  );

  app.patch<{ Params: { entity: string; id: string }; Body: UpdateBody }>(
    '/api/entities/:entity/:id',
    { schema: { body: updateBodySchema } },
    async (req, reply) => {
      const found = lookup(req, req.params.entity);
      if (!found) return notFound(reply);
      const { entity, view } = found;
      // A malformed id 404s like a missing row, whether or not a reason was given.
      const decoded = decodeRecordId(view, req.params.id);
      if (!decoded.ok) return notFound(reply);
      const reason = reasonFor(entity, 'update', req.body);
      if (!reason.ok) return badRequest(reply, reason.message);
      const record = validateRecord(view, req.body.values, 'update');
      if (!record.ok) return badRequest(reply, 'invalid record', record.errors);
      if (Object.keys(record.values).length === 0) return badRequest(reply, 'no fields to update');
      let result;
      try {
        result = await updateRow(db, entity, decoded.filter, record.values, {
          version: req.body.version,
          versionEntity: view,
          ...audited(req, reason.reason),
        });
      } catch (err) {
        return writeFailed(reply, view, 'update', err);
      }
      if (!result.ok) return result.reason === 'conflict' ? conflict(reply) : notFound(reply);
      return written(req, view, result.row);
    },
  );

  app.delete<{ Params: { entity: string; id: string }; Body: DeleteBody | null | undefined }>(
    '/api/entities/:entity/:id',
    { schema: { body: deleteBodySchema } },
    async (req, reply) => {
      const found = lookup(req, req.params.entity);
      if (!found) return notFound(reply);
      const { entity, view } = found;
      // A malformed id 404s like a missing row, whether or not a reason was given.
      const decoded = decodeRecordId(view, req.params.id);
      if (!decoded.ok) return notFound(reply);
      const reason = reasonFor(entity, 'delete', req.body);
      if (!reason.ok) return badRequest(reply, reason.message);
      const version = req.body?.version;
      let result;
      try {
        result = await deleteRow(db, entity, decoded.filter, {
          ...(version !== undefined ? { version, versionEntity: view } : {}),
          ...audited(req, reason.reason),
        });
      } catch (err) {
        return writeFailed(reply, view, 'delete', err);
      }
      if (!result.ok) return result.reason === 'conflict' ? conflict(reply) : notFound(reply);
      return reply.code(204).send();
    },
  );
}
