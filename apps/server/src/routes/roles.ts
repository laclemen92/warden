import type { WardenConfig } from '@wardenhq/config';
import { adminAreas, lastHolderRoles, parseEmail } from '@wardenhq/core';
import {
  assignRole,
  deleteSessionsForSubject,
  LastHolderError,
  listRoleAssignments,
  listSignedInUsers,
  unassignRole,
  type Database,
  type RoleAssignment,
  type SessionTimeouts,
} from '@wardenhq/pg-adapter';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { NO_NUL } from './schemas.js';

export interface RoleRoutesOptions {
  config: WardenConfig;
  db: Database;
  /** Which sessions count as signed in, for the list of signed-in users. */
  sessionTimeouts: SessionTimeouts;
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

const revokeSchema = {
  body: {
    type: 'object',
    required: ['subject'],
    additionalProperties: false,
    properties: { subject: { type: 'string', minLength: 1, maxLength: 1000, pattern: NO_NUL } },
  },
};

const assignmentSchema = {
  body: {
    type: 'object',
    required: ['email', 'role'],
    additionalProperties: false,
    properties: {
      email: { type: 'string', minLength: 1, maxLength: 320, pattern: NO_NUL },
      role: { type: 'string', minLength: 1, maxLength: 200, pattern: NO_NUL },
    },
  },
};

/**
 * The roles page's API: config's roles and access rules (read-only, since config defines roles),
 * the roles assigned to users in the app, and who is signed in, so their sessions can be revoked.
 * Assigning a role can give someone any access that role has, so only roles with
 * `admin: [roles]` can use it; to everyone else it is a route that doesn't exist.
 */
export function registerRoleRoutes(
  app: FastifyInstance,
  { config, db, sessionTimeouts }: RoleRoutesOptions,
) {
  const defined = (role: string) => Object.hasOwn(config.roles, role);
  const protect = lastHolderRoles(config.roles, config.access);

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
    signedIn: await listSignedInUsers(db, sessionTimeouts),
  }));

  app.post<{ Body: AssignmentBody }>(
    '/api/admin/roles/assignments',
    { onRequest, schema: assignmentSchema },
    async (req, reply) => {
      const email = parseEmail(req.body.email);
      if (!email) return badRequest(reply, 'email must be an ASCII email address');
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
      // Assignments stored before non-ASCII emails were refused can still be removed, by their
      // exact stored email; nothing is folded, so a look-alike can't remove someone else's.
      const email = parseEmail(req.body.email) ?? req.body.email;
      let removed;
      try {
        removed = await unassignRole(db, {
          email,
          role: req.body.role,
          actor: actorOf(req),
          protect,
        });
      } catch (err) {
        if (!(err instanceof LastHolderError)) throw err;
        return reply.code(409).send({
          statusCode: 409,
          error: 'Conflict',
          message:
            `${email} is the last person assigned a role that can manage roles; ` +
            'assign one to someone else first, or grant one through an access rule in config',
        });
      }
      if (!removed) {
        return reply
          .code(404)
          .send({ statusCode: 404, error: 'Not Found', message: 'no such assignment' });
      }
      return reply.code(204).send();
    },
  );

  // Claims (and so IdP groups) are only read at sign-in; this makes someone sign in again.
  app.delete<{ Body: { subject: string } }>(
    '/api/admin/roles/sessions',
    { onRequest, schema: revokeSchema },
    async (req) => ({
      revoked: await deleteSessionsForSubject(db, {
        subject: req.body.subject,
        actor: actorOf(req),
      }),
    }),
  );
}
