import type { WardenConfig } from '@wardenhq/config';
import { adminAreas, diffSchema, type AuditStore, type SchemaModel } from '@wardenhq/core';
import {
  acknowledgeSchemaSnapshot,
  ensureSchemaSnapshot,
  type Database,
  type SchemaSnapshot,
} from '@wardenhq/pg-adapter';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface SchemaDriftOptions {
  /** The schema as introspected at startup, which is what Warden is serving. */
  model: SchemaModel;
  config: WardenConfig;
  db: Database;
  /** Where changes are audited; `warden.audit_log` when absent. */
  audit?: AuditStore | undefined;
}

// Exactly what an unknown route returns, so the page can't be discovered by non-admins.
const notFound = (reply: FastifyReply) => {
  reply.callNotFound();
  return reply;
};

const conflict = (reply: FastifyReply) =>
  reply.code(409).send({
    statusCode: 409,
    error: 'Conflict',
    message: 'the baseline changed since this page was loaded; reload and review again',
  });

const baselineOf = ({ id, takenAt, takenBy }: SchemaSnapshot) => ({ id, takenAt, takenBy });

/**
 * The schema drift page's API. It names tables and columns that config hides, so only roles
 * with `admin: [schema]` can use it; to everyone else it is a route that doesn't exist.
 */
export function registerSchemaDriftRoutes(
  app: FastifyInstance,
  { model, config, db, audit }: SchemaDriftOptions,
) {
  const isSchemaAdmin = (req: FastifyRequest) =>
    adminAreas(config.roles, req.roles ?? []).includes('schema');

  app.get('/api/admin/schema-drift', async (req, reply) => {
    if (!isSchemaAdmin(req)) return notFound(reply);
    // Another replica may have acknowledged since startup, so read the baseline every time.
    const baseline = await ensureSchemaSnapshot(db, model);
    return { baseline: baselineOf(baseline), drift: diffSchema(baseline.model, model, config) };
  });

  app.post<{ Body: { baselineId: string } }>(
    '/api/admin/schema-drift/acknowledge',
    {
      schema: {
        body: {
          type: 'object',
          required: ['baselineId'],
          additionalProperties: false,
          properties: { baselineId: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' } },
        },
      },
      // Check before the body is parsed, so non-admins can't tell the route exists.
      onRequest: async (req, reply) => {
        if (!isSchemaAdmin(req)) return notFound(reply);
      },
    },
    async (req, reply) => {
      const baseline = await ensureSchemaSnapshot(db, model);
      if (baseline.id !== req.body.baselineId) return conflict(reply);
      const session = req.session!;
      // Re-checked under a lock, in case another admin acknowledges in between.
      const acknowledged = await acknowledgeSchemaSnapshot(db, {
        model,
        expectedId: baseline.id,
        actor: {
          subject: session.subject,
          ...(session.email ? { email: session.email } : {}),
          roles: req.roles!,
          requestId: req.id,
          ...(audit ? { store: audit } : {}),
        },
        // What the admin saw and accepted, for the audit log.
        drift: diffSchema(baseline.model, model, config),
      });
      if (!acknowledged) return conflict(reply);
      return {
        baseline: baselineOf(acknowledged),
        drift: diffSchema(acknowledged.model, model, config),
      };
    },
  );
}
