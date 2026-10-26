# RFC 0002: Where Warden keeps its metadata

| Status    | Accepted                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------ |
| Issue     | [#161](https://github.com/laclemen92/warden/issues/161), part of [#158](https://github.com/laclemen92/warden/issues/158) |
| Implement | [#165](https://github.com/laclemen92/warden/issues/165)                                                                  |

## Summary

Warden gets an optional separate metadata database (`WARDEN_METADATA_DATABASE_URL`). When it's set, Warden's own state (sessions, role assignments, saved views, schema snapshots, migrations) lives there, and nothing Warden-owned is added to the application database. Writes to application data stay possible only when their audit entries go to a table in the application database ([`audit.store: table`](../config.md#audit)), so each write and its audit entry still commit in one transaction. Without that, split mode is read-only. A configurable schema name is not pursued.

## Problem

Today everything Warden stores about itself is in a `warden` schema inside the database it browses (`DATABASE_URL`):

| Table                      | Holds                                                 |
| -------------------------- | ----------------------------------------------------- |
| `warden.sessions`          | Sessions, with the sealed ID token and API tokens     |
| `warden.role_assignments`  | Roles assigned in the app                             |
| `warden.saved_views`       | Personal and UI-shared grid views                     |
| `warden.schema_snapshots`  | Baselines for the schema drift page                   |
| `warden.schema_migrations` | Warden's own schema version                           |
| `warden.audit_log`         | The audit trail, unless `audit.store: table` moves it |

That causes two problems:

- **Adoption.** Operators have to add a schema, and grants for it, to a production database.
- **No replicas.** Signing in writes a session row, so Warden can't browse a read-only hot standby. That rules out the safest way to pilot it against production.

## Invariant that doesn't move

**Every audit entry commits in the same database transaction as the thing it records.** A write that can't be audited doesn't happen. Two databases can't share a transaction, and an outbox or a two-phase commit would add a window where data changed with no audit entry. So the question is never "can audit go elsewhere", but "which transaction is each entry part of".

## Decision

Each audit entry is written in the database where the change it records happens:

| Event                                                                          | Changes data in                                  | Audited in                                                                                                      |
| ------------------------------------------------------------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Create, update, delete, soft delete and restore; `tx` writes in custom actions | Application database                             | The `audit.store: table` table, in the same transaction                                                         |
| Role assign or unassign, sign-out-everywhere, drift acknowledgement            | Metadata database                                | `warden.audit_log` in the metadata database, in the same transaction                                            |
| CSV export (a read)                                                            | Nothing                                          | The application-database audit table when there is one, otherwise the metadata database, before any row is sent |
| HTTP action attempt and outcome                                                | Nothing in Warden (the API changes its own data) | Same as exports                                                                                                 |

That gives four modes:

| Mode                                            | Metadata                            | Data audit                       | Writes to app data                                                                                                                     |
| ----------------------------------------------- | ----------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Default (no metadata URL)                       | `warden` schema in the app database | `warden.audit_log` or your table | Allowed                                                                                                                                |
| Split + `audit.store: table`                    | Metadata database                   | Your table in the app database   | Allowed                                                                                                                                |
| Split, no app-database audit table              | Metadata database                   | n/a                              | **Refused at startup**: a `ConfigError` names every role grant of `create`/`update`/`delete` and every action that writes through `tx` |
| `DATABASE_URL` is a hot standby (must be split) | Metadata database                   | n/a                              | Refused, as above. `audit.store: table` on a standby is a startup error, since the table can't be written                              |

HTTP actions stay available in the read-only modes. They don't write application data through Warden, and their entries are recorded before and after the call either way. So a replica-backed Warden can still trigger operations that the application performs on its primary.

## Consequences

- **The audit log page and History read both stores in split mode.** They merge by `occurred_at`. Entries keep their store-local ids, so links carry the store (`?store=meta|app`) and `parent_id` links stay within one store. Custom actions are audited entirely in the app store, because their parent entry is written in the same transaction as their rows.
- **Startup checks:**
  - Detect a standby with `pg_is_in_recovery()` or `transaction_read_only`.
  - Single-database mode against a standby fails with a message naming `WARDEN_METADATA_DATABASE_URL`.
  - Split mode checks the metadata database is writable.
- **Migrations** run against the metadata database. `WARDEN_MIGRATE=false` and the owner/runtime role split apply there unchanged. The app database needs no Warden migrations in split mode. The `audit.store: table` table is the operator's, as today.
- **Actor id and session settings** ([`actor`](../config.md#actor)) keep working. The lookup reads the app database, and `warden.actor_*` settings are set in app-database write transactions.
- **Separate pools** for the two databases, each with its own timeouts. Exports on a standby can be cancelled by replication conflicts (`max_standby_streaming_delay`), which needs a clear error. Replication lag is documented.
- **Least privilege:** a `SELECT`-only role is enough on a standby. On a writable app database in split mode, the runtime role needs the table grants config uses, plus `INSERT` on the audit table.

## Alternatives considered

- **Audit everything to the metadata database.** It's simple, but data writes wouldn't be atomic with their audit entries. Rejected because of the invariant above.
- **Outbox in the app database, shipped to the metadata database.** It's still a Warden-owned table in the app database, and the shipped copy lags. `audit.store: table` already covers "audit lives with the data".
- **Configurable schema name (`WARDEN_SCHEMA`).** It's cheap and helps with naming policies, but it still adds a schema and solves neither problem above. Not pursued unless someone needs it for naming alone.
- **Status quo plus documentation.** It doesn't unblock replicas.

## Rollout

[#165](https://github.com/laclemen92/warden/issues/165) implements this. Single-database deployments don't change.
