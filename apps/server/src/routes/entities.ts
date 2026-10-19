import {
  decodeCursor,
  decodeRecordId,
  encodeCursor,
  encodeRecordId,
  resolveSort,
  searchFilter,
  validateFilter,
  type EffectiveSchema,
  type Entity,
  type Filter,
  type FilterError,
} from '@wardenhq/core';
import { getRow, listRows, type Database, type Row } from '@wardenhq/pg-adapter';
import type { FastifyInstance, FastifyReply } from 'fastify';

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

const badRequest = (reply: FastifyReply, message: string, details?: FilterError[]) =>
  reply
    .code(400)
    .send({ statusCode: 400, error: 'Bad Request', message, ...(details ? { details } : {}) });

const notFound = (reply: FastifyReply) =>
  reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Not Found' });

const toItem = (entity: Entity, row: Row) => ({ id: encodeRecordId(entity, row), values: row });

export function registerEntityRoutes(app: FastifyInstance, schema: EffectiveSchema, db: Database) {
  // Hidden entities aren't in the effective schema, so they 404 exactly like nonexistent ones.
  const entities = new Map(schema.entities.map((e) => [e.key, e]));

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
}
