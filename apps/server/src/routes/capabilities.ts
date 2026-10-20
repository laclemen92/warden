import {
  allowedActions,
  runnableActions,
  type Action,
  type ActionPolicy,
  type Policy,
} from '@wardenhq/core';
import type { FastifyInstance } from 'fastify';
import type { Views } from '../views.js';

export interface Capabilities {
  /**
   * Every entity in the current user's view (those they may do anything with), what they may do
   * with it, and the custom actions on it they may run.
   */
  entities: Record<string, { actions: Action[]; customActions: string[] }>;
}

/**
 * What the current user may do, so the UI can hide controls they can't use. Advisory only:
 * every entity route enforces the same policy.
 */
export function registerCapabilityRoutes(
  app: FastifyInstance,
  policy: Policy,
  views: Views,
  actionPolicy?: ActionPolicy,
) {
  app.get('/api/capabilities', async (req): Promise<Capabilities> => {
    const roles = req.roles ?? [];
    const runnable = actionPolicy ? runnableActions(actionPolicy, policy, roles) : [];
    return {
      entities: Object.fromEntries(
        views(roles).schema.entities.map((e) => [
          e.key,
          {
            actions: allowedActions(policy, roles, e.key),
            customActions: runnable.filter((a) => a.on === e.key).map((a) => a.name),
          },
        ]),
      ),
    };
  });
}
