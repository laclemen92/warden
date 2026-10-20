import { allowedActions, type Action, type EffectiveSchema, type Policy } from '@wardenhq/core';
import type { FastifyInstance } from 'fastify';

export interface Capabilities {
  /** Every exposed entity, with what the current user may do to it. */
  entities: Record<string, { actions: Action[] }>;
}

/**
 * What the current user may do, so the UI can hide controls they can't use. Advisory only:
 * every entity route enforces the same policy.
 */
export function registerCapabilityRoutes(
  app: FastifyInstance,
  schema: EffectiveSchema,
  policy: Policy,
) {
  app.get('/api/capabilities', async (req): Promise<Capabilities> => {
    const roles = req.roles ?? [];
    return {
      entities: Object.fromEntries(
        schema.entities.map((e) => [e.key, { actions: allowedActions(policy, roles, e.key) }]),
      ),
    };
  });
}
