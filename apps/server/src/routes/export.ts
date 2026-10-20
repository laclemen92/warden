import { Readable } from 'node:stream';
import {
  csvHeader,
  csvRow,
  filterFields,
  isAllowed,
  resolveSort,
  searchFilter,
  validateViewState,
  type Filter,
  type FilterError,
  type Policy,
} from '@wardenhq/core';
import { openExport, recordExport, type Database } from '@wardenhq/pg-adapter';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Views } from '../views.js';

/** Larger exports are refused rather than cut short, so a file is never silently incomplete. */
export const MAX_EXPORT_ROWS = 100_000;

export interface ExportRouteOptions {
  db: Database;
  policy: Policy;
  views: Views;
}

interface ExportQuery {
  filter?: string;
  q?: string;
  sort?: string;
  /** Comma-separated; every visible column when absent. */
  columns?: string;
}

const exportQuerySchema = {
  type: 'object',
  properties: {
    filter: { type: 'string', maxLength: 20_000 },
    q: { type: 'string', maxLength: 1000 },
    sort: { type: 'string', maxLength: 1000 },
    columns: { type: 'string', maxLength: 20_000 },
  },
} as const;

// Excel reads UTF-8 CSV as the local code page unless it starts with a byte order mark.
const BOM = '﻿';

const notFound = (reply: FastifyReply) =>
  reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Not Found' });

const badRequest = (reply: FastifyReply, message: string, details?: FilterError[]) =>
  reply
    .code(400)
    .send({ statusCode: 400, error: 'Bad Request', message, ...(details ? { details } : {}) });

/**
 * CSV export of a grid: the same filter, search, and sort as the list endpoint, over every
 * matching row. It needs the `export` action, only ever includes fields the caller can read, and
 * is audited before the first row is sent.
 */
export function registerExportRoutes(
  app: FastifyInstance,
  { db, policy, views }: ExportRouteOptions,
) {
  app.get<{ Params: { entity: string }; Querystring: ExportQuery }>(
    '/api/export/:entity',
    { schema: { querystring: exportQuerySchema } },
    async (req, reply) => {
      const roles = req.roles ?? [];
      // Outside /api/entities, so the policy hook doesn't run; these are its checks.
      const entity = views(roles).entities.get(req.params.entity);
      if (!entity || !policy.entities.has(entity.key)) return notFound(reply);
      if (!isAllowed(policy, roles, entity.key, 'export')) {
        req.log.info({ entity: entity.key, action: 'export' }, 'denied by policy');
        return reply.code(403).send({ statusCode: 403, error: 'Forbidden', message: 'Forbidden' });
      }

      let filter: unknown;
      if (req.query.filter !== undefined) {
        try {
          filter = JSON.parse(req.query.filter);
        } catch {
          return badRequest(reply, 'filter must be valid JSON');
        }
      }
      const columns = req.query.columns?.split(',').map((c) => c.trim());
      const state = validateViewState(entity, {
        ...(filter !== undefined ? { filter } : {}),
        ...(req.query.q !== undefined ? { q: req.query.q } : {}),
        ...(req.query.sort !== undefined ? { sort: req.query.sort } : {}),
        ...(columns ? { columns } : {}),
      });
      if (!state.ok) return badRequest(reply, 'invalid export', state.errors);
      const { filter: validFilter, q, sort: sortInput } = state.state;

      const filters: Filter[] = validFilter ? [validFilter] : [];
      const search = q === undefined ? undefined : searchFilter(entity, q);
      if (search) filters.push(search);
      const combined = filters.length > 1 ? { and: filters } : filters[0];
      const sort = resolveSort(entity, sortInput);
      if (!sort.ok) return badRequest(reply, sort.message);
      // Entity order, like the grid.
      const fields = state.state.columns
        ? entity.fields.filter((f) => state.state.columns!.includes(f.name))
        : entity.fields;

      const rows = await openExport(db, entity, {
        sort: sort.sort,
        ...(combined ? { filter: combined } : {}),
      });
      try {
        if (rows.total > MAX_EXPORT_ROWS) {
          await rows.close();
          return badRequest(
            reply,
            `exports are limited to ${MAX_EXPORT_ROWS.toLocaleString('en-US')} rows; ` +
              `this one has ${rows.total.toLocaleString('en-US')}, so narrow the filter`,
          );
        }
        const session = req.session!;
        await recordExport(db, {
          actor: {
            subject: session.subject,
            ...(session.email ? { email: session.email } : {}),
            roles,
          },
          requestId: req.id,
          entity,
          details: {
            rowCount: rows.total,
            columns: fields.map((f) => f.name),
            ...(validFilter ? { filter: validFilter } : {}),
            // With the fields it was matched against, so readers who can't see one of them are
            // shown neither the search text nor the count.
            ...(q ? { q, searchFields: search ? filterFields(search) : [] } : {}),
            ...(sortInput ? { sort: sortInput } : {}),
          },
        });
      } catch (err) {
        await rows.close();
        throw err;
      }

      // A client that goes away before the stream starts never runs the generator's cleanup.
      reply.raw.once('close', () => {
        rows.close().catch((err: unknown) => req.log.warn({ err }, 'could not end export'));
      });
      async function* lines() {
        try {
          yield BOM + csvHeader(fields);
          for await (const batch of rows.batches()) {
            yield batch.map((row) => csvRow(fields, row)).join('');
          }
        } finally {
          await rows.close();
        }
      }
      const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
      const filename = `${entity.key.replaceAll(/[^\w.-]/g, '_')}-${stamp}.csv`;
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .send(Readable.from(lines()));
    },
  );
}
