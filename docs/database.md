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

## The audit log

`warden.audit_log` is append-only. Besides the grants above, triggers reject every `update`, `delete`, and `truncate`, including from the table owner. Removing an entry means dropping those triggers first, a deliberate step the runtime role can't take. If the role Warden runs as owns `warden.audit_log` (as it does when it ran the migrations itself) or is a superuser, it could disable the triggers, so Warden logs a warning at startup.

Every create, update, and delete made through Warden inserts its entry in the same transaction as the change, so a write that can't be audited (for example, because the insert fails) is rolled back and the request fails with a 500. Rows are recorded as the API shows them: hidden columns are never stored. Rows that foreign key cascades or triggers change in other tables aren't recorded; see [cascades](config.md#cascades).

An [export](config.md#csv-export) inserts its entry, with `record_id` null and what was exported in `details`, before any row is sent; if that insert fails, the export fails with a 500 and sends nothing.

| Column          | Type          | Description                                                                                                                                                                                     |
| --------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | `bigint`      | Increasing entry id.                                                                                                                                                                            |
| `occurred_at`   | `timestamptz` | When the write's transaction started.                                                                                                                                                           |
| `request_id`    | `text`        | The request's id (a UUID), logged as `reqId` by the server.                                                                                                                                     |
| `actor_subject` | `text`        | OIDC subject of the user who made the change.                                                                                                                                                   |
| `actor_email`   | `text`        | Their email at the time.                                                                                                                                                                        |
| `actor_roles`   | `text[]`      | The Warden roles they held.                                                                                                                                                                     |
| `action`        | `text`        | `create`, `update`, `delete`, `export`, or a custom action's name.                                                                                                                              |
| `entity`        | `text`        | Entity key, as in `/api/entities/:entity`.                                                                                                                                                      |
| `record_id`     | `text`        | The API's record id (after an update that changes the key, the new one; null without a primary key).                                                                                            |
| `primary_key`   | `jsonb`       | The row's primary key columns and values.                                                                                                                                                       |
| `before`        | `jsonb`       | The row before the change (null for `create`).                                                                                                                                                  |
| `after`         | `jsonb`       | The row after the change (null for `delete`).                                                                                                                                                   |
| `diff`          | `jsonb`       | `{ field: { from, to } }` for each changed field; every field for `create` and `delete`.                                                                                                        |
| `reason`        | `text`        | The reason sent with the write (`reason` in the request body), if any.                                                                                                                          |
| `parent_id`     | `bigint`      | For rows changed by a custom action, the action's parent entry.                                                                                                                                 |
| `details`       | `jsonb`       | For actions that change no row: an `export`'s `rowCount`, `columns`, and `filter`, `q` (with the `searchFields` it ran over), and `sort`; the number of `sessions` a `revoke_sessions` deleted. |
| `written`       | `text[]`      | For `create` and `update`, the fields the request set. Other changed fields in `diff` were set by the database (defaults, triggers, generated columns).                                         |

## Schema snapshots

`warden.schema_snapshots` holds copies of the introspected schema. The newest row is the baseline the [schema drift page](config.md#schema-drift) compares against. Warden records the first one when it starts against a database that has none, and adds one each time an admin acknowledges drift. Older rows are kept as history.

## Role assignments

`warden.role_assignments` holds the roles admins give users on the [roles page](config.md#role-assignments), one row per email and role: `email` (lowercased), `role`, `assigned_by` (the admin's OIDC subject), and `assigned_at`. Each assignment and removal also writes an audit log entry, with `action` `assign` or `unassign`, `entity` `warden.role_assignments`, and the email and role in `primary_key`.

Signing a user out everywhere from the roles page deletes their rows from `warden.sessions` and writes an audit log entry with `action` `revoke_sessions`, `entity` `warden.sessions`, their OIDC subject in `primary_key`, and the number of sessions deleted in `details`. Nothing is recorded when they had no sessions.

## Saved views

`warden.saved_views` holds the grid views users save (see [saved views](config.md#saved-views)): the table's entity key, the view's name, the OIDC subject of its owner, whether it is shared, and its state (filter, search, sort, and columns) as `jsonb`. Names are unique per owner and table, ignoring case.
