import { isAllowed, type Action, type Policy } from '@wardenhq/core';
import type { FastifyInstance } from 'fastify';
import type { Views } from '../views.js';

const ENTITY_ROUTE_PREFIX = '/api/entities/';
/** Restoring a soft-deleted row changes it, so it needs `update`, not `create`. */
export const RESTORE_ROUTE = '/api/entities/:entity/:id/restore';

/** Methods with no action here are denied, so a new kind of route can't slip past the policy. */
const METHOD_ACTIONS: Partial<Record<string, Action>> = {
  GET: 'read',
  HEAD: 'read',
  POST: 'create',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
};

/**
 * Apply the policy to every route under `/api/entities/:entity`, whenever it was registered. Runs
 * before validation, so a denied caller learns nothing from input errors or record lookups.
 */
export function registerPolicy(app: FastifyInstance, policy: Policy, views: Views) {
  app.addHook('preValidation', async (req, reply) => {
    // The matched route, not the raw URL: the router decodes `/%61pi/...` to `/api/...`.
    if (!(req.routeOptions.url ?? '').startsWith(ENTITY_ROUTE_PREFIX)) return;
    const { entity } = req.params as { entity?: unknown };
    // Hidden entities, and those the caller may do nothing with, aren't in their view, so they
    // 404 exactly like nonexistent ones.
    const roles = req.roles ?? [];
    if (typeof entity !== 'string' || !views(roles).entities.has(entity)) {
      return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Not Found' });
    }
    const action =
      req.routeOptions.url === RESTORE_ROUTE
        ? req.method === 'POST'
          ? 'update'
          : undefined
        : METHOD_ACTIONS[req.method];
    if (!action || !isAllowed(policy, roles, entity, action)) {
      req.log.info({ entity, action: action ?? req.method }, 'denied by policy');
      return reply.code(403).send({ statusCode: 403, error: 'Forbidden', message: 'Forbidden' });
    }
  });
}
