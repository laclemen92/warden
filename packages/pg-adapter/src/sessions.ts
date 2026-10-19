import { sql } from 'kysely';
import type { Database } from './database.js';
import { WARDEN_SCHEMA } from './introspect.js';

const SESSIONS = sql.id(WARDEN_SCHEMA, 'sessions');

export interface SessionTimeouts {
  /** Session ends after this long without a request. */
  idleSeconds: number;
  /** Session ends this long after login, however active. */
  absoluteSeconds: number;
}

export interface NewSession {
  tokenHash: Buffer;
  subject: string;
  email?: string;
  name?: string;
  /** ID token claims, kept for role resolution. */
  claims: Record<string, unknown>;
}

export interface Session {
  subject: string;
  email: string | null;
  name: string | null;
  claims: Record<string, unknown>;
  createdAt: string;
  lastSeenAt: string;
}

const live = ({ idleSeconds, absoluteSeconds }: SessionTimeouts) =>
  sql`created_at > now() - make_interval(secs => ${absoluteSeconds})
      and last_seen_at > now() - make_interval(secs => ${idleSeconds})`;

export async function insertSession(db: Database, session: NewSession): Promise<void> {
  await sql`
    insert into ${SESSIONS} (token_hash, subject, email, name, claims)
    values (${session.tokenHash}, ${session.subject}, ${session.email ?? null},
            ${session.name ?? null}, ${JSON.stringify(session.claims)}::jsonb)`.execute(db);
}

/** Return the session if it is still live and mark it as just used; otherwise `undefined`. */
export async function touchSession(
  db: Database,
  tokenHash: Buffer,
  timeouts: SessionTimeouts,
): Promise<Session | undefined> {
  const { rows } = await sql<Session>`
    update ${SESSIONS} set last_seen_at = now()
    where token_hash = ${tokenHash} and ${live(timeouts)}
    returning subject, email, name, claims,
              created_at as "createdAt", last_seen_at as "lastSeenAt"`.execute(db);
  return rows[0];
}

export async function deleteSession(db: Database, tokenHash: Buffer): Promise<void> {
  await sql`delete from ${SESSIONS} where token_hash = ${tokenHash}`.execute(db);
}

/** Remove sessions that can no longer be used. Returns how many were removed. */
export async function deleteExpiredSessions(
  db: Database,
  timeouts: SessionTimeouts,
): Promise<number> {
  const result = await sql`delete from ${SESSIONS} where not (${live(timeouts)})`.execute(db);
  return Number(result.numAffectedRows ?? 0);
}
