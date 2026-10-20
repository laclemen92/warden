import type { WardenConfig } from '@wardenhq/config';
import { adminAreas, parseEmail } from '@wardenhq/core';
import {
  assignRole,
  listRoleAssignments,
  unassignRole,
  type Database,
  type RoleAssignment,
} from '@wardenhq/pg-adapter';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface RoleRoutesOptions {
  config: WardenConfig;
  db: Database;
}

interface AssignmentBody {
  email: string;
  role: string;
}

// Exactly what an unknown route returns, so the page can't be discovered by non-admins.
const notFound = (reply: FastifyReply) => {
  reply.callNotFound();
  return reply;
};

const badRequest = (reply: FastifyReply, message: string) =>
  reply.code(400).send({ statusCode: 400, error: 'Bad Request', message });

const assignmentSchema = {
  body: {
    type: 'object',
    required: ['email', 'role'],
    additionalProperties: false,
    properties: {
      email: { type: 'string', minLength: 1, maxLength: 320 },
      role: { type: 'string', minLength: 1, maxLength: 200 },
    },
  },
};

/**
 * The roles page's API: config's roles and access rules (read-only, since config defines roles)
 * and the roles assigned to users in the app. Assigning a role can give someone any access that
 * role has, so only roles with `admin: [roles]` can use it; to everyone else it is a route that
 * doesn't exist.
 */
export function registerRoleRoutes(app: FastifyInstance, { config, db }: RoleRoutesOptions) {
  const defined = (role: string) => Object.hasOwn(config.roles, role);

  // Checked before the body is parsed, so non-admins can't tell the routes exist.
  const onRequest = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!adminAreas(config.roles, req.roles ?? []).includes('roles')) return notFound(reply);
  };

  const actorOf = (req: FastifyRequest) => {
    const session = req.session!;
    return {
      subject: session.subject,
      ...(session.email ? { email: session.email } : {}),
      roles: req.roles!,
      requestId: req.id,
    };
  };

  const withDefined = (assignment: RoleAssignment) => ({
    ...assignment,
    defined: defined(assignment.role),
  });

  app.get('/api/admin/roles', { onRequest }, async () => ({
    roles: Object.entries(config.roles).map(([name, { grants, admin }]) => ({
      name,
      grants,
      admin,
    })),
    access: config.access
      ? {
          groups: config.access.groups,
          emailDomains: config.access.emailDomains,
          allowAll: config.access.allowAll,
        }
      : null,
    assignments: (await listRoleAssignments(db)).map(withDefined),
  }));

  app.post<{ Body: AssignmentBody }>(
    '/api/admin/roles/assignments',
    { onRequest, schema: assignmentSchema },
    async (req, reply) => {
      const email = parseEmail(req.body.email);
      if (!email) return badRequest(reply, 'email must be an email address');
      const { role } = req.body;
      if (!defined(role)) return badRequest(reply, `role "${role}" is not defined in config`);

      const assignment = await assignRole(db, { email, role, actor: actorOf(req) });
      if (!assignment) {
        return reply.code(409).send({
          statusCode: 409,
          error: 'Conflict',
          message: `${email} already has role "${role}"`,
        });
      }
      return reply.code(201).send(withDefined(assignment));
    },
  );

  // Roles config no longer defines can still be unassigned, to clean them up.
  app.delete<{ Body: AssignmentBody }>(
    '/api/admin/roles/assignments',
    { onRequest, schema: assignmentSchema },
    async (req, reply) => {
      const email = parseEmail(req.body.email);
      const removed = email
        ? await unassignRole(db, { email, role: req.body.role, actor: actorOf(req) })
        : undefined;
      if (!removed) {
        return reply
          .code(404)
          .send({ statusCode: 404, error: 'Not Found', message: 'no such assignment' });
      }
      return reply.code(204).send();
    },
  );
}
