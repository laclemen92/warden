import type { WardenConfig } from '@wardenhq/config';
import {
  adminAreas,
  checkTimestamp,
  decodeRecordId,
  isAllowed,
  runnableActions,
  type ActionPolicy,
  type Policy,
  type AuditStore,
} from '@wardenhq/core';
import { listAuditEntries, type AuditQuery, type Database } from '@wardenhq/pg-adapter';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Views } from '../views.js';
import { NO_NUL } from './schemas.js';

export const DEFAULT_AUDIT_LIMIT = 50;
export const MAX_AUDIT_LIMIT = 200;

export interface AuditRouteOptions {
  db: Database;
  policy: Policy;
  views: Views;
  /** Config `roles`, for the `audit` admin area. */
  roles: WardenConfig['roles'];
  /** Custom actions, if any; a record's History shows an action's own entry to who may run it. */
  actionPolicy?: ActionPolicy | undefined;
  /** Where entries are read from; `warden.audit_log` when absent. */
  audit?: AuditStore | undefined;
}

interface PageQuery {
  /** The previous page's `nextCursor`. */
  cursor?: string;
  limit: number;
}

interface SearchQuery extends PageQuery {
  entity?: string;
  actor?: string;
  action?: string;
  from?: string;
  to?: string;
  parent?: string;
  source?: string;
}

const pageProperties = {
  // An entry id, small enough to always fit a bigint.
  cursor: { type: 'string', pattern: '^[1-9][0-9]{0,17}$' },
  limit: { type: 'integer', minimum: 1, maximum: MAX_AUDIT_LIMIT, default: DEFAULT_AUDIT_LIMIT },
} as const;

const searchQuerySchema = {
  type: 'object',
  properties: {
    ...pageProperties,
    entity: { type: 'string', minLength: 1, maxLength: 200, pattern: NO_NUL },
    actor: { type: 'string', minLength: 1, maxLength: 200, pattern: NO_NUL },
    action: { type: 'string', minLength: 1, maxLength: 100, pattern: NO_NUL },
    /** Inclusive. */
    from: { type: 'string', format: 'date-time' },
    /** Exclusive. */
    to: { type: 'string', format: 'date-time' },
    /** A custom action's entry: the rows it changed. */
    parent: pageProperties.cursor,
    /** Who wrote the entry, with an audit table that tags Warden's (`audit.source`). */
    source: { type: 'string', minLength: 1, maxLength: 200, pattern: NO_NUL },
  },
} as const;

const notFound = (reply: FastifyReply) =>
  reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Not Found' });

/**
 * Reading the audit log: a record's history for anyone who may read the record, and a search
 * across every entity for roles with `admin: [audit]`. Either way an entity's entry only shows
 * what the caller could read today, on entities they may read. The search also lists role
 * assignments and session revocations.
 */
export function registerAuditRoutes(
  app: FastifyInstance,
  { db, policy, views, roles: roleConfig, actionPolicy, audit }: AuditRouteOptions,
) {
  /**
   * Entity key → fields the caller can read, for every entity they may read, and the entities
   * where that is every field (no `readableBy` rule leaves one out).
   */
  const visibleTo = (req: FastifyRequest): Pick<AuditQuery, 'visible' | 'complete'> => {
    const roles = req.roles ?? [];
    const visible = Object.fromEntries(
      views(roles)
        .schema.entities.filter((e) => isAllowed(policy, roles, e.key, 'read'))
        .map((e) => [e.key, e.fields.map((f) => f.name)]),
    );
    const complete = new Set(
      Object.entries(visible)
        .filter(([key, fields]) =>
          [...(policy.fields.get(key) ?? [])].every(
            ([field, rule]) => !rule.readableBy || fields.includes(field),
          ),
        )
        .map(([key]) => key),
    );
    return { visible, complete };
  };

  const isAuditAdmin = (req: FastifyRequest) =>
    adminAreas(roleConfig, req.roles ?? []).includes('audit');

  const page = async (query: AuditQuery, { withRoles = true } = {}) => {
    const { entries, hasMore } = await listAuditEntries(db, query, audit);
    const items = withRoles
      ? entries
      : entries.map((entry) => ({
          ...entry,
          actor: {
            subject: entry.actor.subject,
            email: entry.actor.email,
            ...(entry.actor.userId !== undefined ? { userId: entry.actor.userId } : {}),
          },
        }));
    return { items, nextCursor: hasMore ? (entries.at(-1)?.id ?? null) : null };
  };

  // Under /api/entities/:entity, so the policy hook requires `read` on the entity first.
  app.get<{ Params: { entity: string; id: string }; Querystring: PageQuery }>(
    '/api/entities/:entity/:id/history',
    { schema: { querystring: { type: 'object', properties: pageProperties } } },
    async (req, reply) => {
      const entity = views(req.roles).entities.get(req.params.entity);
      if (!entity) return notFound(reply);
      // Only a well-formed id can match an entry. The record itself may since have been deleted.
      if (!decodeRecordId(entity, req.params.id).ok) return notFound(reply);
      const { cursor, limit } = req.query;
      const auditAdmin = isAuditAdmin(req);
      const roles = req.roles ?? [];
      // Anyone who may read the record sees who changed it, but which roles people hold (who
      // is an admin, who is in HR) is for audit admins. A custom action's own entry (its input
      // and reason) is for those who could run it; to anyone else an action they aren't granted
      // doesn't exist, and its input may name fields and records they can't read.
      return page(
        {
          // Every readable entity, for action inputs that pick their records; the entity filter
          // keeps the entries to this one.
          ...visibleTo(req),
          ...(auditAdmin
            ? {}
            : {
                actions: actionPolicy
                  ? runnableActions(actionPolicy, policy, roles).map((a) => a.name)
                  : [],
              }),
          entity: entity.key,
          recordId: req.params.id,
          limit,
          ...(cursor !== undefined ? { before: cursor } : {}),
        },
        { withRoles: auditAdmin },
      );
    },
  );

  app.get<{ Querystring: SearchQuery }>(
    '/api/audit',
    {
      schema: { querystring: searchQuerySchema },
      // Before the query is validated, so other users can't tell the route exists.
      onRequest: async (req, reply) => {
        if (!isAuditAdmin(req)) {
          reply.callNotFound();
          return reply;
        }
      },
    },
    async (req, reply) => {
      const { entity, actor, action, from, to, parent, source, cursor, limit } = req.query;
      const { visible, complete } = visibleTo(req);
      // Hidden and unreadable entities are rejected exactly like nonexistent ones.
      if (entity !== undefined && !Object.hasOwn(visible, entity)) {
        return reply
          .code(400)
          .send({ statusCode: 400, error: 'Bad Request', message: 'unknown entity' });
      }
      // The schema's date-time format allows dates Postgres doesn't, such as year 0.
      for (const [name, value] of [
        ['from', from],
        ['to', to],
      ] as const) {
        if (value !== undefined && checkTimestamp(value)) {
          return reply.code(400).send({
            statusCode: 400,
            error: 'Bad Request',
            message: `querystring/${name} is not a valid date-time`,
          });
        }
      }
      return page({
        visible,
        ...(complete ? { complete } : {}),
        // The route is only open to the audit area, which also covers who was given access.
        includeAccessEntries: true,
        limit,
        ...(entity !== undefined ? { entity } : {}),
        ...(actor !== undefined ? { actor } : {}),
        ...(action !== undefined ? { action } : {}),
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        ...(parent !== undefined ? { parentId: parent } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(cursor !== undefined ? { before: cursor } : {}),
      });
    },
  );
}
