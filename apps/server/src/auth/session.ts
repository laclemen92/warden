import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
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

// The ID token is only needed at logout, when the browser presents the session token, so it is
// stored encrypted under a key derived from that token. A copy of the sessions table then holds
// neither usable session tokens nor ID tokens.
const SEALED = 'v1';
const idTokenKey = (token: string) =>
  Buffer.from(hkdfSync('sha256', token, '', 'warden session id_token', 32));

export function sealIdToken(token: string, idToken: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', idTokenKey(token), iv);
  const data = Buffer.concat([cipher.update(idToken, 'utf8'), cipher.final()]);
  return [SEALED, iv, data, cipher.getAuthTag()]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

/** The ID token sealed under `token`, or `undefined` if it wasn't (or was tampered with). */
export function openIdToken(token: string, sealed: string): string | undefined {
  const [version, iv, data, tag, ...rest] = sealed.split('.');
  if (version !== SEALED || !iv || !data || !tag || rest.length > 0) return undefined;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      idTokenKey(token),
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return undefined;
  }
}

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
      const { idToken, ...rest } = user;
      await insertSession(db, {
        tokenHash: hashToken(token),
        ...rest,
        ...(idToken ? { idToken: sealIdToken(token, idToken) } : {}),
      });
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
      return token && ended?.idToken ? openIdToken(token, ended.idToken) : undefined;
    },
  };
}
