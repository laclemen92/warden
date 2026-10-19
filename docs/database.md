# Database setup

Warden keeps its own metadata (sessions, the audit log) in a `warden` schema inside the database it manages. It never introspects or exposes that schema.

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

The role Warden runs as only needs to append to and read the audit log. Postgres doesn't apply grants to a table's owner, so the runtime role must **not** be the role that ran the migrations.

Run this as the owner of the `warden` schema, replacing `warden_app` with your runtime role. It is safe to re-run after every upgrade:

<!-- runtime-grants -->

```sql
revoke all on all tables in schema warden from warden_app;
grant usage on schema warden to warden_app;
grant select on warden.schema_migrations to warden_app;
grant select, insert, update, delete on warden.sessions to warden_app;
grant select, insert on warden.audit_log to warden_app;
```

The runtime role also needs whatever access your configuration grants on your application tables (at least `select`, plus `insert`/`update`/`delete` where roles may write).

## The audit log

`warden.audit_log` is append-only. Besides the grants above, triggers reject every `update`, `delete`, and `truncate`, including from the table owner. Removing an entry means dropping those triggers first, a deliberate step the runtime role can't take.

| Column          | Type          | Description                                                     |
| --------------- | ------------- | --------------------------------------------------------------- |
| `id`            | `bigint`      | Increasing entry id.                                            |
| `occurred_at`   | `timestamptz` | When the write's transaction started.                           |
| `request_id`    | `text`        | Request id, to correlate with server logs.                      |
| `actor_subject` | `text`        | OIDC subject of the user who made the change.                   |
| `actor_email`   | `text`        | Their email at the time.                                        |
| `actor_roles`   | `text[]`      | The Warden roles they held.                                     |
| `action`        | `text`        | `create`, `update`, `delete`, or a custom action's name.        |
| `entity`        | `text`        | Entity name.                                                    |
| `record_id`     | `text`        | The record id the API uses for the row.                         |
| `primary_key`   | `jsonb`       | The row's primary key columns and values.                       |
| `before`        | `jsonb`       | The row before the change (null for `create`).                  |
| `after`         | `jsonb`       | The row after the change (null for `delete`).                   |
| `diff`          | `jsonb`       | The fields that changed.                                        |
| `reason`        | `text`        | The reason the user gave, if any.                               |
| `parent_id`     | `bigint`      | For rows changed by a custom action, the action's parent entry. |
