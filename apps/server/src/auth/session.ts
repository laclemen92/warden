import { createHash, randomBytes } from 'node:crypto';
import type { CookieSerializeOptions } from '@fastify/cookie';
import {
  deleteExpiredSessions,
  deleteSession,
  insertSession,
  touchSession,
  type Database,
  type Session,
  type SessionTimeouts,
} from '@wardenhq/pg-adapter';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthSettings } from './settings.js';

export interface SessionUser {
  subject: string;
  email?: string;
  name?: string;
  claims: Record<string, unknown>;
  idToken?: string;
}

export interface Sessions {
  /**
   * Create a session for a freshly authenticated user and set its cookie, revoking the session
   * the browser already held, so a copy of the old token stops working.
   */
  start(req: FastifyRequest, reply: FastifyReply, user: SessionUser): Promise<void>;
  /** The request's live session, refreshing its idle timer; `undefined` if absent or expired. */
  load(req: FastifyRequest): Promise<Session | undefined>;
  /**
   * Revoke the request's session (if any) and clear its cookie. Returns the session's ID token,
   * if it had one, for logging out at the IdP.
   */
  end(req: FastifyRequest, reply: FastifyReply): Promise<string | undefined>;
  /** Options for other short-lived auth cookies, matching the session cookie's security. */
  cookie(name: string, maxAgeSeconds: number): { name: string; options: CookieSerializeOptions };
}

// The cookie holds a random token; the database only ever sees its hash.
const hashToken = (token: string) => createHash('sha256').update(token).digest();

export function createSessions(db: Database, settings: AuthSettings): Sessions {
  const secure = settings.publicUrl.protocol === 'https:';
  const timeouts: SessionTimeouts = {
    idleSeconds: settings.idleTimeoutSeconds,
    absoluteSeconds: settings.absoluteTimeoutSeconds,
  };

  const cookie = (name: string, maxAgeSeconds: number) => ({
    // `__Host-` makes browsers refuse the cookie unless it is Secure, host-only, and Path=/.
    name: secure ? `__Host-${name}` : name,
    options: {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      signed: true,
      maxAge: maxAgeSeconds,
    } satisfies CookieSerializeOptions,
  });
  const session = cookie('warden_session', settings.absoluteTimeoutSeconds);

  const readToken = (req: FastifyRequest) => {
    const raw = req.cookies[session.name];
    if (!raw) return undefined;
    const { valid, value } = req.unsignCookie(raw);
    return valid && value ? value : undefined;
  };

  return {
    cookie,

    async start(req, reply, user) {
      const previous = readToken(req);
      if (previous) await deleteSession(db, hashToken(previous));
      // Opportunistic cleanup; logins are rare enough that this stays cheap.
      await deleteExpiredSessions(db, timeouts);
      const token = randomBytes(32).toString('base64url');
      await insertSession(db, { tokenHash: hashToken(token), ...user });
      reply.setCookie(session.name, token, session.options);
    },

    async load(req) {
      const token = readToken(req);
      return token ? touchSession(db, hashToken(token), timeouts) : undefined;
    },

    async end(req, reply) {
      const token = readToken(req);
      const ended = token ? await deleteSession(db, hashToken(token)) : undefined;
      reply.clearCookie(session.name, { ...session.options, maxAge: 0 });
      return ended?.idToken ?? undefined;
    },
  };
}
