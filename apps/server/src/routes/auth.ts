import fastifyCookie from '@fastify/cookie';
import type { AccessConfig, WardenConfig } from '@wardenhq/config';
import {
  actorEmail,
  adminAreas,
  assignmentEmail,
  resolveRoles,
  sessionEmail,
} from '@wardenhq/core';
import type { ActorLookup, Session } from '@wardenhq/pg-adapter';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { LoginChecks, OidcClient } from '../auth/oidc.js';
import type { Sessions } from '../auth/session.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set on every /api request; requests without a live session never reach a handler. */
    session: Session | null;
    /** The session user's roles from config `access` rules and in-app assignments. */
    roles: readonly string[] | null;
  }
}

export interface AuthOptions {
  sessionSecret: string;
  sessions: Sessions;
  oidc: OidcClient;
  /** Config `access` rules; without them nobody can sign in. */
  access?: AccessConfig;
  /** Config `roles`: which admin areas each grants, and which assigned roles still exist. */
  roles?: WardenConfig['roles'];
  /** Roles assigned in the app to a (lowercased) email; without it, only config gives roles. */
  assignedRoles?: (email: string) => Promise<string[]>;
  /**
   * Config `actor`: `lookup` finds a (lowercased, verified) email's internal user id; it is
   * absent when the mapping doesn't match the database. With `required`, users without an id
   * can't sign in or use their session. `mapping` (`actorMappingKey`) is stored with the id, and
   * a session's id is only trusted while it matches.
   */
  actor?: {
    required: boolean;
    lookup?: (email: string) => Promise<ActorLookup>;
    mapping?: string;
  };
}

const LOGIN_TTL_SECONDS = 600;
const LOGIN_FAILED = '/login?error=login_failed';
const ACCESS_DENIED = '/login?error=access_denied';

/**
 * Only same-origin paths may be a post-login destination, so a crafted `?returnTo=` can't
 * bounce the user to another site.
 */
export function safeReturnTo(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\p{Cc}]/u.test(value)
  ) {
    return '/';
  }
  return value;
}

interface LoginState extends LoginChecks {
  returnTo: string;
}

function parseLoginState(value: string): LoginState | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { state, nonce, codeVerifier, returnTo } = parsed as Record<string, unknown>;
    if (
      typeof state !== 'string' ||
      typeof nonce !== 'string' ||
      typeof codeVerifier !== 'string'
    ) {
      return undefined;
    }
    return { state, nonce, codeVerifier, returnTo: safeReturnTo(returnTo) };
  } catch {
    return undefined;
  }
}

const isApi = (req: FastifyRequest) =>
  req.url.startsWith('/api/') || (req.routeOptions.url ?? '').startsWith('/api/');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Logout isn't under /api, but a forged one still signs the user out.
const LOGOUT = '/auth/logout';
const needsJson = (req: FastifyRequest) =>
  req.method === 'POST' && (isApi(req) || req.routeOptions.url === LOGOUT);

/**
 * Why a state-changing request must be refused as a possible cross-site request forgery, if it
 * must. Warden sends no CORS headers, so a cross-origin page can only make "simple" requests: a
 * POST with a form or text/plain body. Requiring JSON on every /api POST and on logout forces a
 * preflight that fails, even from a sibling subdomain that SameSite=Lax cookies don't stop, and
 * in browsers too old to send Sec-Fetch-Site. Browsers that send it get the same answer up front,
 * for every unsafe method and path.
 */
function csrfRejection(req: FastifyRequest): { status: number; message: string } | undefined {
  if (SAFE_METHODS.has(req.method)) return undefined;
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') {
    return { status: 403, message: 'cross-site requests are not allowed' };
  }
  const mime = req.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (needsJson(req) && mime !== 'application/json') {
    return { status: 415, message: 'expected an application/json body' };
  }
  return undefined;
}

export async function registerAuth(
  app: FastifyInstance,
  {
    sessionSecret,
    sessions,
    oidc,
    access,
    roles: roleConfig = {},
    assignedRoles,
    actor,
  }: AuthOptions,
) {
  await app.register(fastifyCookie, { secret: sessionSecret });

  const rolesFor = async (claims: Record<string, unknown>) => {
    const email = assignedRoles ? assignmentEmail(access, claims) : undefined;
    // Config defines roles; assignments of roles it no longer defines are ignored.
    const assigned = email
      ? (await assignedRoles!(email)).filter((role) => Object.hasOwn(roleConfig, role))
      : [];
    return resolveRoles(access, claims, assigned);
  };
  /**
   * The user's internal id, looked up by their verified email like role assignments, so nobody
   * can claim another user's row by setting an unverified address at the IdP.
   */
  const userIdFor = async (req: FastifyRequest, claims: Record<string, unknown>) => {
    const email = actor?.lookup ? actorEmail(claims) : undefined;
    if (!email) return undefined;
    try {
      const found = await actor!.lookup!(email);
      if (found.userId === undefined && found.matches === 'many') {
        req.log.warn({ sub: claims.sub }, 'actor: several users match the email; no user id');
      }
      return found.userId;
    } catch (err) {
      // E.g. the table or a column was dropped since startup.
      req.log.warn({ err }, 'actor: could not look up the user id');
      return undefined;
    }
  };
  const login = sessions.cookie('warden_login', LOGIN_TTL_SECONDS);

  app.decorateRequest('session', null);
  app.decorateRequest('roles', null);
  app.addHook('onRequest', async (req, reply) => {
    if (isApi(req)) {
      const session = await sessions.load(req);
      // Roles are re-resolved from the stored claims and current assignments, so a restart with
      // stricter rules or a removed assignment applies to existing sessions too.
      const roles = session ? await rolesFor(session.claims) : undefined;
      // An id stored under another mapping, or before it was removed or broke, isn't trusted.
      const userId =
        actor?.mapping !== undefined && session?.actorMapping === actor.mapping
          ? session.userId
          : null;
      if (!session || !roles || (actor?.required && userId === null)) {
        return reply
          .code(401)
          .send({ statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' });
      }
      // Same for the email, which every audit entry attributes the request to.
      req.session = { ...session, email: sessionEmail(access, session.claims) ?? null, userId };
      req.roles = roles;
    }
    const rejection = csrfRejection(req);
    if (rejection) {
      return reply.code(rejection.status).send({
        statusCode: rejection.status,
        error: rejection.status === 403 ? 'Forbidden' : 'Unsupported Media Type',
        message: rejection.message,
      });
    }
  });

  app.get<{ Querystring: { returnTo?: string } }>('/auth/login', async (req, reply) => {
    let begun;
    try {
      begun = await oidc.begin();
    } catch (err) {
      req.log.error({ err }, 'could not start OIDC login');
      return reply.redirect(LOGIN_FAILED);
    }
    const state: LoginState = { ...begun.checks, returnTo: safeReturnTo(req.query.returnTo) };
    reply.setCookie(login.name, JSON.stringify(state), login.options);
    return reply.redirect(begun.url.href);
  });

  app.get('/auth/callback', async (req, reply) => {
    const raw = req.cookies[login.name];
    reply.clearCookie(login.name, { ...login.options, maxAge: 0 });
    const unsigned = raw ? req.unsignCookie(raw) : undefined;
    const state = unsigned?.valid && unsigned.value ? parseLoginState(unsigned.value) : undefined;
    if (!state) {
      req.log.warn('OIDC callback without a valid login cookie');
      return reply.redirect(LOGIN_FAILED);
    }

    // Built from the configured redirect URI, never the Host header.
    const callbackUrl = new URL(oidc.redirectUri);
    callbackUrl.search = new URL(req.url, callbackUrl).search;

    let claims, idToken;
    try {
      ({ claims, idToken } = await oidc.finish(callbackUrl, state));
    } catch (err) {
      req.log.warn({ err }, 'OIDC login failed');
      return reply.redirect(LOGIN_FAILED);
    }

    if (!(await rolesFor(claims))) {
      req.log.warn({ sub: claims.sub }, 'login denied: no access rule matches');
      return reply.redirect(ACCESS_DENIED);
    }

    const userId = await userIdFor(req, claims);
    if (actor?.required && userId === undefined) {
      req.log.warn({ sub: claims.sub }, 'login denied: no user matches actor mapping');
      return reply.redirect(ACCESS_DENIED);
    }

    const email = sessionEmail(access, claims);
    await sessions.start(req, reply, {
      subject: claims.sub,
      ...(email ? { email } : {}),
      ...(userId !== undefined && actor?.mapping !== undefined
        ? { userId, actorMapping: actor.mapping }
        : {}),
      ...(typeof claims.name === 'string' ? { name: claims.name } : {}),
      claims: { ...claims },
      idToken,
    });
    req.log.info({ sub: claims.sub }, 'login');
    return reply.redirect(state.returnTo);
  });

  // A JSON POST (see csrfRejection), so other sites can't log users out. When the IdP
  // supports RP-initiated logout, the browser goes there next to end the IdP's session too;
  // otherwise the next sign-in on a shared machine would silently reuse it.
  app.post(LOGOUT, async (req, reply) => {
    const idToken = await sessions.end(req, reply);
    let redirectTo;
    try {
      redirectTo = await oidc.endSessionUrl(idToken);
    } catch (err) {
      // Warden's session is gone either way; the IdP's may outlive it.
      req.log.warn({ err }, 'could not build the IdP logout URL');
    }
    return redirectTo ? { redirectTo: redirectTo.href } : reply.code(204).send();
  });

  app.get('/api/me', async (req) => {
    const session = req.session!;
    return {
      sub: session.subject,
      ...(session.email ? { email: session.email } : {}),
      ...(session.name ? { name: session.name } : {}),
      roles: req.roles!,
      admin: adminAreas(roleConfig, req.roles!),
    };
  });
}
