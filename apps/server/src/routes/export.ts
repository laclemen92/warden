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
import { openExport, recordExport, type Database, type RowExport } from '@wardenhq/pg-adapter';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { createSlots } from '../slots.js';
import type { Views } from '../views.js';

/** Larger exports are refused rather than cut short, so a file is never silently incomplete. */
export const MAX_EXPORT_ROWS = 100_000;

export interface ExportLimits {
  /** Exports running at once on this server, across all users. */
  maxConcurrent: number;
  /** Exports one user may run at once. */
  maxPerUser: number;
  /** An export whose client stops reading for this long is ended. */
  idleTimeoutMs: number;
  /** An export still running this long after it started is ended. */
  deadlineMs: number;
}

export const DEFAULT_EXPORT_LIMITS: ExportLimits = {
  maxConcurrent: 4,
  maxPerUser: 2,
  idleTimeoutMs: 30_000,
  deadlineMs: 15 * 60_000,
};

export interface ExportRouteOptions {
  db: Database;
  policy: Policy;
  views: Views;
  /** Where exports read from; `db` when absent. A pool of their own can't starve other requests. */
  exportDb?: Database;
  limits?: Partial<ExportLimits>;
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

const tooMany = (reply: FastifyReply) =>
  reply.code(429).send({
    statusCode: 429,
    error: 'Too Many Requests',
    message: 'too many exports are running; try again when one finishes',
  });

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
  { db, policy, views, exportDb = db, limits }: ExportRouteOptions,
) {
  const { idleTimeoutMs, deadlineMs, ...caps } = { ...DEFAULT_EXPORT_LIMITS, ...limits };
  // Counts running exports, so they can never hold every database connection.
  const acquire = createSlots(caps);

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

      const session = req.session!;
      // A client that left before now (e.g. during the session lookup) has already fired 'close'.
      if (reply.raw.destroyed) return;
      const release = acquire(session.subject);
      if (!release) return tooMany(reply);

      const opening = openExport(exportDb, entity, {
        sort: sort.sort,
        ...(combined ? { filter: combined } : {}),
        maxRows: MAX_EXPORT_ROWS,
        deadlineMs,
        idleTimeoutMs,
        onTimeout: (reason) => {
          req.log.warn({ entity: entity.key, reason }, 'export timed out');
          // Abort rather than end the response, so the download fails instead of looking complete.
          reply.raw.destroy();
        },
      });
      // Every path out ends here, once. The slot is freed only after the export's connection is
      // back in the pool, so a client that leaves mid-count can't free its slot early and pile
      // exports up waiting for a connection: the export pool is sized to the slots.
      let ended: Promise<void> | undefined;
      const end = () =>
        (ended ??= opening
          .then(
            (rows) => rows.close(),
            () => {},
          )
          .catch((err: unknown) => req.log.warn({ err }, 'could not end export'))
          .finally(release));
      // Every way the response ends closes it, including a client that goes away.
      reply.raw.once('close', () => void end());

      let rows: RowExport;
      try {
        rows = await opening;
      } catch (err) {
        await end();
        throw err;
      }
      // The client left while the export was opening; 'close' has already ended it.
      if (reply.raw.destroyed) return;
      try {
        if (rows.total > MAX_EXPORT_ROWS) {
          await end();
          return badRequest(
            reply,
            `exports are limited to ${MAX_EXPORT_ROWS.toLocaleString('en-US')} rows; ` +
              'this one has more, so narrow the filter',
          );
        }
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
        await end();
        throw err;
      }

      async function* lines() {
        try {
          yield BOM + csvHeader(fields);
          for await (const batch of rows.batches()) {
            yield batch.map((row) => csvRow(fields, row)).join('');
          }
        } finally {
          await end();
        }
      }
      const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
      const filename = `${entity.key.replaceAll(/[^\w.-]/g, '_')}-${stamp}.csv`;
      // Read one batch ahead of the socket rather than the default 16, so a slow client holds
      // little memory and a stalled one parks the cursor (and trips the idle timeout) quickly.
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .send(Readable.from(lines(), { highWaterMark: 1 }));
    },
  );
}
