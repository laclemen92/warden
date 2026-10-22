import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import type { CookieSerializeOptions } from '@fastify/cookie';
import {
  deleteExpiredSessions,
  deleteSession,
  insertSession,
  readSessionApiTokens,
  saveSessionApiTokens,
  touchSession,
  withSessionApiTokensLock,
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
  /** Tokens for the API audience login requested (`OIDC_AUDIENCE`). */
  apiTokens?: ApiTokens;
  /** From config's `actor` mapping. */
  userId?: string;
  actorMapping?: string;
}

/** An access token for the API audience, and the refresh token to renew it, if any. */
export interface ApiTokens {
  accessToken: string;
  refreshToken?: string;
  /** Seconds until `accessToken` expires, as the IdP reported it. */
  expiresIn?: number;
}

/**
 * The user must sign in again before Warden can call the API as them: there is no session or
 * access token, or it expired and couldn't be refreshed. A 401 if it reaches the error handler.
 */
export class SignInAgainError extends Error {
  readonly statusCode = 401;
  constructor() {
    super('Sign in again to continue');
    this.name = 'SignInAgainError';
  }
}

/**
 * Renews an access token with a refresh token at the IdP. Throws `RefreshRejectedError` when the
 * IdP refuses the refresh token (revoked, expired, user removed), anything else on failures that
 * might be transient.
 */
export type RefreshApiTokens = (refreshToken: string) => Promise<ApiTokens>;

export class RefreshRejectedError extends Error {
  constructor(readonly code: string) {
    super(`the IdP rejected the refresh token: ${code}`);
    this.name = 'RefreshRejectedError';
  }
}

/** An access token is refreshed when it has less than this left, so it can't expire in flight. */
export const ACCESS_TOKEN_MIN_VALIDITY_SECONDS = 60;

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
  /**
   * The request's user's access token for the API audience, refreshed first if it has less than
   * a minute left (once across concurrent callers). Refreshing extends neither session timeout.
   * Throws `SignInAgainError` when there is no usable token. Never send it to the browser or log
   * it.
   */
  accessTokenFor(req: FastifyRequest): Promise<string>;
}

// The cookie holds a random token; the database only ever sees its hash.
const hashToken = (token: string) => createHash('sha256').update(token).digest();

// The IdP's tokens are only needed while the browser presents the session token, so they are
// stored encrypted under a key derived from that token. A copy of the sessions table then holds
// neither usable session tokens nor IdP tokens. Each kind has its own key, so a stored value
// can't be moved to another column and used as something else.
const SEALED = 'v1';
export type SealedKind = 'id_token' | 'access_token' | 'refresh_token';
const sealingKey = (token: string, kind: SealedKind) =>
  Buffer.from(hkdfSync('sha256', token, '', `warden session ${kind}`, 32));

export function seal(token: string, kind: SealedKind, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', sealingKey(token, kind), iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [SEALED, iv, data, cipher.getAuthTag()]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

/** The value sealed under `token` as `kind`, or `undefined` if it wasn't (or was tampered with). */
export function unseal(token: string, kind: SealedKind, sealed: string): string | undefined {
  const [version, iv, data, tag, ...rest] = sealed.split('.');
  if (version !== SEALED || !iv || !data || !tag || rest.length > 0) return undefined;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      sealingKey(token, kind),
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

export const sealIdToken = (token: string, idToken: string) => seal(token, 'id_token', idToken);

/** The ID token sealed under `token`, or `undefined` if it wasn't (or was tampered with). */
export const openIdToken = (token: string, sealed: string) => unseal(token, 'id_token', sealed);

export function createSessions(
  db: Database,
  settings: AuthSettings,
  refresh?: RefreshApiTokens,
): Sessions {
  const secure = settings.publicUrl.protocol === 'https:';
  const timeouts: SessionTimeouts = {
    idleSeconds: settings.idleTimeoutSeconds,
    absoluteSeconds: settings.absoluteTimeoutSeconds,
  };
  // Per session, so concurrent requests on this instance share one refresh (and one connection).
  const refreshing = new Map<string, Promise<string>>();

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

  /** The stored access token if it has at least a minute left. */
  const freshAccessToken = async (token: string, tokenHash: Buffer) => {
    const stored = await readSessionApiTokens(
      db,
      tokenHash,
      timeouts,
      ACCESS_TOKEN_MIN_VALIDITY_SECONDS,
    );
    const accessToken =
      stored?.fresh && stored.accessToken
        ? unseal(token, 'access_token', stored.accessToken)
        : undefined;
    return { stored, accessToken };
  };

  /**
   * Refresh the session's access token under its lock, unless another request (or instance)
   * already did while this one waited. A refresh token the IdP rejects is cleared, so later calls
   * fail without asking it again.
   */
  const refreshUnderLock = (
    req: FastifyRequest,
    token: string,
    tokenHash: Buffer,
    refresh: RefreshApiTokens,
  ) =>
    withSessionApiTokensLock(db, tokenHash, async () => {
      const { stored, accessToken } = await freshAccessToken(token, tokenHash);
      if (accessToken) return accessToken;
      const refreshToken = stored?.refreshToken
        ? unseal(token, 'refresh_token', stored.refreshToken)
        : undefined;
      if (!refreshToken) throw new SignInAgainError();

      let next;
      try {
        next = await refresh(refreshToken);
      } catch (err) {
        // Only the error code: IdP errors can echo request details.
        if (err instanceof RefreshRejectedError) {
          req.log.warn({ error: err.code }, 'access token refresh rejected; sign-in required');
          await saveSessionApiTokens(db, tokenHash, timeouts, {
            accessToken: null,
            refreshToken: null,
          });
        } else {
          req.log.warn(
            { error: err instanceof Error ? err.name : 'unknown' },
            'access token refresh failed',
          );
        }
        throw new SignInAgainError();
      }
      // IdPs that don't rotate refresh tokens leave the old one valid.
      const saved = await saveSessionApiTokens(db, tokenHash, timeouts, {
        accessToken: seal(token, 'access_token', next.accessToken),
        refreshToken: seal(token, 'refresh_token', next.refreshToken ?? refreshToken),
        ...(next.expiresIn !== undefined ? { expiresIn: next.expiresIn } : {}),
      });
      // Signed out, or the session expired, while refreshing.
      if (!saved) throw new SignInAgainError();
      return next.accessToken;
    });

  return {
    cookie,

    async start(req, reply, user) {
      const previous = readToken(req);
      if (previous) await deleteSession(db, hashToken(previous));
      // Opportunistic cleanup; logins are rare enough that this stays cheap.
      await deleteExpiredSessions(db, timeouts);
      const token = randomBytes(32).toString('base64url');
      const { idToken, apiTokens, ...rest } = user;
      await insertSession(db, {
        tokenHash: hashToken(token),
        ...rest,
        ...(idToken ? { idToken: sealIdToken(token, idToken) } : {}),
        ...(apiTokens
          ? {
              accessToken: seal(token, 'access_token', apiTokens.accessToken),
              ...(apiTokens.refreshToken
                ? { refreshToken: seal(token, 'refresh_token', apiTokens.refreshToken) }
                : {}),
              ...(apiTokens.expiresIn !== undefined
                ? { accessTokenExpiresIn: apiTokens.expiresIn }
                : {}),
            }
          : {}),
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

    async accessTokenFor(req) {
      const token = readToken(req);
      if (!token) throw new SignInAgainError();
      const tokenHash = hashToken(token);
      const { stored, accessToken } = await freshAccessToken(token, tokenHash);
      if (accessToken) return accessToken;
      if (!stored?.refreshToken || !refresh) throw new SignInAgainError();

      const key = tokenHash.toString('hex');
      let pending = refreshing.get(key);
      if (!pending) {
        pending = refreshUnderLock(req, token, tokenHash, refresh).finally(() =>
          refreshing.delete(key),
        );
        refreshing.set(key, pending);
      }
      return pending;
    },
  };
}
