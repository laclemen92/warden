import { allowedActions, type Action, type Policy } from '@wardenhq/core';
import type { FastifyInstance } from 'fastify';
import type { Views } from '../views.js';

export interface Capabilities {
  /** Every entity in the current user's view (those they may do anything with), and what. */
  entities: Record<string, { actions: Action[] }>;
}

/**
 * What the current user may do, so the UI can hide controls they can't use. Advisory only:
 * every entity route enforces the same policy.
 */
export function registerCapabilityRoutes(app: FastifyInstance, policy: Policy, views: Views) {
  app.get('/api/capabilities', async (req): Promise<Capabilities> => {
    const roles = req.roles ?? [];
    return {
      entities: Object.fromEntries(
        views(roles).schema.entities.map((e) => [
          e.key,
          { actions: allowedActions(policy, roles, e.key) },
        ]),
      ),
    };
  });
}
