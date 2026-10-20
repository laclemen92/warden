import { sql } from 'kysely';
import type { Database } from './database.js';
import { WARDEN_SCHEMA } from './introspect.js';
import type { AssignmentActor } from './role-assignments.js';

const SESSIONS = sql.id(WARDEN_SCHEMA, 'sessions');
const AUDIT_LOG = sql.id(WARDEN_SCHEMA, 'audit_log');

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
  /** The raw ID token, for `id_token_hint` at logout. */
  idToken?: string;
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
    insert into ${SESSIONS} (token_hash, subject, email, name, claims, id_token)
    values (${session.tokenHash}, ${session.subject}, ${session.email ?? null},
            ${session.name ?? null}, ${JSON.stringify(session.claims)}::jsonb,
            ${session.idToken ?? null})`.execute(db);
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

/**
 * Delete a session, live or expired. Returns what logout needs from it, or `undefined` if there
 * was no such session.
 */
export async function deleteSession(
  db: Database,
  tokenHash: Buffer,
): Promise<{ idToken: string | null } | undefined> {
  const { rows } = await sql<{ idToken: string | null }>`
    delete from ${SESSIONS} where token_hash = ${tokenHash}
    returning id_token as "idToken"`.execute(db);
  return rows[0];
}

/** Remove sessions that can no longer be used. Returns how many were removed. */
export async function deleteExpiredSessions(
  db: Database,
  timeouts: SessionTimeouts,
): Promise<number> {
  const result = await sql`delete from ${SESSIONS} where not (${live(timeouts)})`.execute(db);
  return Number(result.numAffectedRows ?? 0);
}

/** Someone signed in, summarized over their live sessions (one per browser or device). */
export interface SignedInUser {
  subject: string;
  /** From their most recent session. */
  email: string | null;
  name: string | null;
  sessions: number;
  lastSeenAt: string;
}

export async function listSignedInUsers(
  db: Database,
  timeouts: SessionTimeouts,
): Promise<SignedInUser[]> {
  const { rows } = await sql<SignedInUser>`
    select subject,
           (array_agg(email order by last_seen_at desc))[1] as email,
           (array_agg(name order by last_seen_at desc))[1] as name,
           count(*)::int as sessions,
           max(last_seen_at) as "lastSeenAt"
    from ${SESSIONS}
    where ${live(timeouts)}
    group by subject
    order by max(last_seen_at) desc, subject`.execute(db);
  return rows;
}

/**
 * Sign `subject` out everywhere: delete all their sessions, expired or not, and audit it in the
 * same transaction. Returns how many were deleted; nothing is audited when there were none.
 */
export async function deleteSessionsForSubject(
  db: Database,
  { subject, actor }: { subject: string; actor: AssignmentActor },
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const { rows } = await sql<{ email: string | null }>`
      delete from ${SESSIONS} where subject = ${subject} returning email`.execute(trx);
    const count = rows.length;
    // Recorded so the audit log can say whose sessions they were.
    const email = rows.find((r) => r.email)?.email;
    if (count > 0) {
      await sql`
        insert into ${AUDIT_LOG}
          (request_id, actor_subject, actor_email, actor_roles, action, entity, primary_key,
           details)
        values (${actor.requestId ?? null}, ${actor.subject}, ${actor.email ?? null},
                ${[...actor.roles]}, 'revoke_sessions', 'warden.sessions',
                ${JSON.stringify({ subject })}::jsonb,
                ${JSON.stringify({ sessions: count, ...(email ? { email } : {}) })}::jsonb)`.execute(
        trx,
      );
    }
    return count;
  });
}
