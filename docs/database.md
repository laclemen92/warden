# Database setup

Warden keeps its own metadata (sessions, the audit log, schema snapshots, role assignments, saved views) in a `warden` schema inside the database it manages. It never introspects or exposes that schema.

## Migrations

By default Warden migrates the `warden` schema on startup: it creates the schema if needed and applies any pending migrations in one transaction, under an advisory lock so replicas starting together don't race. Applied versions are recorded in `warden.schema_migrations`.

That needs a database role allowed to create tables. To run Warden as a restricted role instead, migrate separately as the schema owner and turn startup migrations off:

| Variable         | Default | Description                                                                                                                            |
| ---------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `WARDEN_MIGRATE` | `true`  | Set to `false` to skip migrations on startup. Warden then checks the schema is current and refuses to start if a migration is missing. |

Run the migrations with the same image, connected as the owner role:

```sh
docker run --rm -e DATABASE_URL=postgres://warden_owner:...@db/app <warden-image> node dist/migrate.js
```

(`pnpm --filter @wardenhq/server migrate` does the same from a checkout, after `pnpm build`.) Run it before rolling out each new Warden version, then re-run the grants below.

## Restricting the runtime role

The role Warden runs as only needs to append to and read the audit log and the schema snapshots, and to manage sessions, role assignments, and saved views. Postgres doesn't apply grants to a table's owner, so the runtime role must **not** be the role that ran the migrations.

Run this as the owner of the `warden` schema, replacing `warden_app` with your runtime role. It is safe to re-run after every upgrade:

<!-- runtime-grants -->

```sql
revoke all on all tables in schema warden from warden_app;
grant usage on schema warden to warden_app;
grant select on warden.schema_migrations to warden_app;
grant select, insert, update, delete on warden.sessions to warden_app;
grant select, insert on warden.audit_log to warden_app;
grant select, insert on warden.schema_snapshots to warden_app;
grant select, insert, delete on warden.role_assignments to warden_app;
grant select, insert, update, delete on warden.saved_views to warden_app;
```

The runtime role also needs whatever access your configuration grants on your application tables (at least `select`, plus `insert`/`update`/`delete` where roles may write).

## Timeouts, exports and actions

Warden limits how long its database work can run or wait, so a slow query or a stalled client can't tie up connections or hold back vacuum on your database.

- **Statements** time out after 15 seconds.
- **Idle transactions:** every connection sets `idle_in_transaction_session_timeout`, so Postgres ends a session that has a transaction open but has run nothing for 60 seconds. Warden's own transactions don't wait on clients, so this is a backstop: an open transaction keeps a snapshot, and while it does, vacuum can't clean up rows deleted or updated after it began.
- **Exports** read a consistent snapshot: each runs in a read-only, repeatable-read transaction with a cursor, so the row count in the audit entry and the rows in the file agree however the data changes meanwhile. That transaction stays open for the whole download, and the cursor fetches more rows only as the client reads them. Warden ends an export, rolls back its transaction, and aborts the download (so it fails instead of looking complete) when the client stops reading for 30 seconds, or 15 minutes after the export started, whichever comes first.
- **Export connections** come from a pool of their own, sized to how many exports may run at once (4 by default; at most 2 per user). Further exports get a `429` until one finishes, and however many are running, the main pool (10 connections) stays free for every other request.
- **Action connections** likewise come from a pool of their own (4 by default; at most 2 per user), and a run or preview is rolled back and its connection closed after 60 seconds. See [Actions: limits](actions.md#limits).

So each Warden server opens at most 18 connections by default, and each replica counts its exports and actions separately.

| Variable                                | Default | Description                                                                                                                                     |
| --------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `WARDEN_DB_IDLE_IN_TRANSACTION_TIMEOUT` | `60s`   | Postgres ends a session idle in a transaction this long (`30s`, `5m`, or seconds).                                                              |
| `WARDEN_EXPORT_IDLE_TIMEOUT`            | `30s`   | An export ends when its client hasn't read for this long. Must be shorter than `WARDEN_DB_IDLE_IN_TRANSACTION_TIMEOUT`, which would cut it off. |
| `WARDEN_EXPORT_DEADLINE`                | `15m`   | An export ends this long after it started, however it is going.                                                                                 |
| `WARDEN_EXPORT_MAX_CONCURRENT`          | `4`     | Exports one server runs at once, and the size of the export pool (1 to 100).                                                                    |
| `WARDEN_EXPORT_MAX_PER_USER`            | `2`     | Exports one user may run at once on a server.                                                                                                   |
| `WARDEN_ACTION_DEADLINE`                | `60s`   | A custom action's run or preview is rolled back this long after it started, unless the action sets `deadlineMs`.                                |
| `WARDEN_ACTION_MAX_CONCURRENT`          | `4`     | Action runs and previews one server runs at once, and the size of the action pool (1 to 100).                                                   |
| `WARDEN_ACTION_MAX_PER_USER`            | `2`     | Action runs and previews one user may have going at once on a server.                                                                           |

To refuse exports over the 100,000-row limit cheaply, Warden counts at most 100,001 matching rows.

## The audit log

`warden.audit_log` is append-only. (To write the audit log to a table you own instead, see [below](#writing-the-audit-log-to-your-own-table).) Besides the grants above, triggers reject every `update`, `delete`, and `truncate`, including from the table owner. Removing an entry means dropping those triggers first, a deliberate step the runtime role can't take. If the role Warden runs as owns `warden.audit_log` (as it does when it ran the migrations itself), the `warden` schema (which lets it drop the table), or the `warden.audit_log_append_only()` trigger function (which `create or replace` could turn into a no-op), or is a superuser, it could get around the triggers, so Warden logs a warning at startup.

Every create, update, and delete made through Warden inserts its entry in the same transaction as the change, so a write that can't be audited (for example, because the insert fails) is rolled back and the request fails with a 500. Rows are recorded as the API shows them: hidden columns are never stored. Rows that foreign key cascades or triggers change in other tables aren't recorded; see [cascades](config.md#cascades).

An [export](config.md#csv-export) inserts its entry, with `record_id` null and what was exported in `details`, before any row is sent; if that insert fails, the export fails with a 500 and sends nothing.

| Column          | Type          | Description                                                                                                                                                                                                                                                                                                                       |
| --------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | `bigint`      | Increasing entry id.                                                                                                                                                                                                                                                                                                              |
| `occurred_at`   | `timestamptz` | When the write's transaction started.                                                                                                                                                                                                                                                                                             |
| `request_id`    | `text`        | The request's id (a UUID), logged as `reqId` by the server.                                                                                                                                                                                                                                                                       |
| `actor_subject` | `text`        | OIDC subject of the user who made the change.                                                                                                                                                                                                                                                                                     |
| `actor_email`   | `text`        | Their verified email at the time, or null. Entries written by builds before v1.0.0-rc.1 may hold an unverified one.                                                                                                                                                                                                               |
| `actor_roles`   | `text[]`      | The Warden roles they held.                                                                                                                                                                                                                                                                                                       |
| `action`        | `text`        | `create`, `update`, `delete`, `export`, or a custom action's name.                                                                                                                                                                                                                                                                |
| `entity`        | `text`        | Entity key, as in `/api/entities/:entity`.                                                                                                                                                                                                                                                                                        |
| `record_id`     | `text`        | The API's record id (after an update that changes the key, the new one; null without a primary key).                                                                                                                                                                                                                              |
| `primary_key`   | `jsonb`       | The row's primary key columns and values.                                                                                                                                                                                                                                                                                         |
| `before`        | `jsonb`       | The row before the change (null for `create`).                                                                                                                                                                                                                                                                                    |
| `after`         | `jsonb`       | The row after the change (null for `delete`).                                                                                                                                                                                                                                                                                     |
| `diff`          | `jsonb`       | `{ field: { from, to } }` for each changed field; every field for `create` and `delete`.                                                                                                                                                                                                                                          |
| `reason`        | `text`        | The reason sent with the write (`reason` in the request body; the UI's internal note), if any.                                                                                                                                                                                                                                    |
| `parent_id`     | `bigint`      | For rows changed by a custom action, the action's parent entry.                                                                                                                                                                                                                                                                   |
| `details`       | `jsonb`       | For actions that change no row: an `export`'s `rowCount`, `columns`, and `filter`, `q` (with the `searchFields` it ran over), and `sort`; the number of `sessions` a `revoke_sessions` deleted, and whose (`email`); a custom action's `input`, target `records`, and `refs` (which input fields picked records of which entity). |
| `written`       | `text[]`      | For `create` and `update`, the fields the request set. Other changed fields in `diff` were set by the database (defaults, triggers, generated columns).                                                                                                                                                                           |

## Writing the audit log to your own table

With [`audit.store: table`](config.md#audit), Warden writes every entry to a table you own instead of `warden.audit_log` (the `warden` schema is still used for sessions and the rest). Entries are inserted in the same transaction as the change, as before, and nothing else about them changes.

The simplest table has `warden.audit_log`'s columns, so `audit.columns` can be left out. Add a source column if your application writes its own entries there too:

```sql
create table public.change_log (
  id            bigint generated always as identity primary key,
  occurred_at   timestamptz not null default now(),
  request_id    text,
  actor_subject text not null,
  actor_email   text,
  actor_roles   text[] not null default '{}',
  action        text not null,
  entity        text not null,
  record_id     text,
  primary_key   jsonb,
  before        jsonb,
  after         jsonb,
  diff          jsonb,
  details       jsonb,
  reason        text,
  written       text[],
  parent_id     bigint references public.change_log (id),
  source        text not null default 'app'
);
create index on public.change_log (entity, record_id, id desc);
create index on public.change_log (occurred_at);
```

```yaml
audit:
  store: table
  table: public.change_log
  source: { column: source, value: warden }
```

The same table as a TypeORM entity, if your application defines its schema there:

```ts
@Entity({ name: 'change_log' })
@Index(['entity', 'recordId', 'id'])
export class ChangeLog {
  @PrimaryGeneratedColumn('identity', { type: 'bigint', generatedIdentity: 'ALWAYS' })
  id!: string;
  @CreateDateColumn({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;
  @Column({ name: 'request_id', type: 'text', nullable: true })
  requestId!: string | null;
  @Column({ name: 'actor_subject', type: 'text' })
  actorSubject!: string;
  @Column({ name: 'actor_email', type: 'text', nullable: true })
  actorEmail!: string | null;
  @Column({ name: 'actor_roles', type: 'text', array: true, default: () => "'{}'" })
  actorRoles!: string[];
  @Column({ type: 'text' })
  action!: string;
  @Column({ type: 'text' })
  entity!: string;
  @Column({ name: 'record_id', type: 'text', nullable: true })
  recordId!: string | null;
  @Column({ name: 'primary_key', type: 'jsonb', nullable: true })
  primaryKey!: object | null;
  @Column({ type: 'jsonb', nullable: true })
  before!: object | null;
  @Column({ type: 'jsonb', nullable: true })
  after!: object | null;
  @Column({ type: 'jsonb', nullable: true })
  diff!: object | null;
  @Column({ type: 'jsonb', nullable: true })
  details!: object | null;
  @Column({ type: 'text', nullable: true })
  reason!: string | null;
  @Column({ type: 'text', array: true, nullable: true })
  written!: string[] | null;
  @Column({ name: 'parent_id', type: 'bigint', nullable: true })
  parentId!: string | null;
  @Column({ type: 'text', default: 'app' })
  source!: string;
}
```

An existing table with other names and fewer columns works too, through `audit.columns`; [config.md](config.md#audit) lists each field, the types it accepts, and which are required. Other columns are left to their defaults.

- **Ids and parent links.** The id column must be an integer the database generates in increasing order; Warden reads it back to page through entries. A custom action's entry links to the rows it changed through `parentId`, which holds the action entry's id. Without a `parentId` column the rows are still recorded, just not linked.
- **Grants.** The runtime role needs `select` and `insert` on the table, and `usage` on its sequence if the id uses one. Warden checks both at startup and refuses changes without them.
- **Append-only is up to you.** Warden only ever inserts, but it can't protect a table it doesn't own the way it protects `warden.audit_log`. Don't grant the runtime role `update`, `delete`, or `truncate` on it, and don't let it own the table; if it can do any of those, Warden logs a warning at startup. A trigger like `warden.audit_log`'s (see [Migrations](#migrations)) makes the table append-only even for its owner.
- **Your own entries.** Rows your application writes show in History and the audit log too, filed under their `entity` and `record_id`, so use Warden's entity key and record id where you can. JSON columns that don't hold objects are shown as empty.
- **Mismatches.** If the table or a column is missing or has the wrong type, Warden logs why at startup and refuses every audited change with a `503` until it is fixed and Warden restarted. Reads of your data keep working.

## Schema snapshots

`warden.schema_snapshots` holds copies of the introspected schema. The newest row is the baseline the [schema drift page](config.md#schema-drift) compares against. Warden records the first one when it starts against a database that has none, and adds one each time an admin acknowledges drift. Older rows are kept as history.

## Role assignments

`warden.role_assignments` holds the roles admins give users on the [roles page](config.md#role-assignments), one row per email and role: `email` (lowercased), `role`, `assigned_by` (the admin's OIDC subject), and `assigned_at`. Each assignment and removal also writes an audit log entry, with `action` `assign` or `unassign`, `entity` `warden.role_assignments`, and the email and role in `primary_key`.

Signing a user out everywhere from the roles page deletes their rows from `warden.sessions` and writes an audit log entry with `action` `revoke_sessions`, `entity` `warden.sessions`, their OIDC subject in `primary_key`, and the number of sessions deleted (`sessions`) and their email, when a session had one (`email`), in `details`. Nothing is recorded when they had no sessions.

## Saved views

`warden.saved_views` holds the grid views users save (see [saved views](config.md#saved-views)): the table's entity key, the view's name, the OIDC subject of its owner, whether it is shared, and its state (filter, search, sort, and columns) as `jsonb`. Names are unique per owner and table, ignoring case.
