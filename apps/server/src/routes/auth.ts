import fastifyCookie from '@fastify/cookie';
import type { Session } from '@wardenhq/pg-adapter';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { LoginChecks, OidcClient } from '../auth/oidc.js';
import type { Sessions } from '../auth/session.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set on every /api request; requests without a live session never reach a handler. */
    session: Session | null;
  }
}

export interface AuthOptions {
  sessionSecret: string;
  sessions: Sessions;
  oidc: OidcClient;
}

const LOGIN_TTL_SECONDS = 600;
const LOGIN_FAILED = '/login?error=login_failed';

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

export async function registerAuth(
  app: FastifyInstance,
  { sessionSecret, sessions, oidc }: AuthOptions,
) {
  await app.register(fastifyCookie, { secret: sessionSecret });
  const login = sessions.cookie('warden_login', LOGIN_TTL_SECONDS);

  app.decorateRequest('session', null);
  app.addHook('onRequest', async (req, reply) => {
    if (!isApi(req)) return;
    const session = await sessions.load(req);
    if (!session) {
      return reply
        .code(401)
        .send({ statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' });
    }
    req.session = session;
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

    let claims;
    try {
      claims = await oidc.finish(callbackUrl, state);
    } catch (err) {
      req.log.warn({ err }, 'OIDC login failed');
      return reply.redirect(LOGIN_FAILED);
    }

    await sessions.start(reply, {
      subject: claims.sub,
      ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
      ...(typeof claims.name === 'string' ? { name: claims.name } : {}),
      claims: { ...claims },
    });
    req.log.info({ sub: claims.sub }, 'login');
    return reply.redirect(state.returnTo);
  });

  // POST only, and the cookie is SameSite=Lax, so other sites can't log users out.
  app.post('/auth/logout', async (req, reply) => {
    await sessions.end(req, reply);
    return reply.code(204).send();
  });

  app.get('/api/me', async (req) => {
    const session = req.session!;
    return {
      sub: session.subject,
      ...(session.email ? { email: session.email } : {}),
      ...(session.name ? { name: session.name } : {}),
    };
  });
}
