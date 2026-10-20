# RFC 0001: `defineAction`

| Status    | Implemented (see [Implementation notes](#implementation-notes))                                                      |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| Issue     | [#44](https://github.com/laclemen92/warden/issues/44), part of [#43](https://github.com/laclemen92/warden/issues/43) |
| Implement | [#45](https://github.com/laclemen92/warden/issues/45) (blocked by this RFC and #34)                                  |

## Summary

Custom actions are typed, multi-step operations that run in one transaction and produce one parent audit entry linking every row they change. A deployment writes them in TypeScript or JavaScript with `defineAction`, points Warden at the module, and grants them to roles in config. Warden renders a form from the action's zod input, can preview the change set without committing it, and shows the action on the entity pages where it applies.

```ts
defineAction({
  name: 'move-user',
  label: 'Move to company',
  on: 'users',
  target: 'one',
  permissions: { users: ['update'], orders: ['delete'] },
  input: z.object({
    company: ref('companies').meta({ label: 'New company' }),
    deleteOldOrders: z.boolean().default(false),
  }),
  async run({ tx, record: user, input }) {
    await tx.update('users', user, { company_id: input.company.values.id });
    if (input.deleteOldOrders && user.values.company_id !== null) {
      await tx.deleteMany('orders', {
        field: 'company_id',
        op: 'eq',
        value: user.values.company_id,
      });
    }
    return { message: `Moved ${user.label} to ${input.company.label}` };
  },
});
```

## Goals

- Atomic: all of an action's writes commit together or none do.
- Audited like every other write. Each changed row gets its usual before/after/diff entry, and all of them hang off one parent entry that records who ran which action with what input.
- Permissions live in config, like the rest of Warden. Code says what an action _can_ touch; config says who may run it.
- Users can preview exactly which rows will change before they commit.
- No codegen and no build step inside Warden. The existing image runs the module as-is.
- The core rules in `CLAUDE.md` still hold: hidden means absent, a table `deny` beats every grant, identifiers come from the `EffectiveSchema`, and client values are bind parameters.

## Non-goals (v1)

- Actions not attached to an entity (a global "Actions" page). See [Future work](#future-work).
- Raw SQL inside actions. See [Why no raw SQL](#why-no-raw-sql).
- Background or long-running jobs. An action is one request and one transaction.
- Typed entity rows generated from the database. Rows are `Record<string, unknown>`, like the rest of the API.

## Authoring

### The module

A deployment provides one ES module whose default export is a function that returns its actions:

```ts
// actions/index.ts
import type { ActionsModule } from '@wardenhq/actions';

export default (({ defineAction, z, ref }) => [
  defineAction({ name: 'move-user' /* ... */ }),
  defineAction({ name: 'refund-order' /* ... */ }),
]) satisfies ActionsModule;
```

Warden calls the function with its own `defineAction`, `z` and `ref`. The module imports only types, so at runtime it needs no packages at all, which matters because a file mounted into the container can't resolve anything from Warden's `node_modules`. It also guarantees a single zod instance: Warden reads the input schemas (to build forms and JSON Schema), and zod schemas from a second copy of zod don't interoperate reliably.

`@wardenhq/actions` is a new, published, types-first package: `ActionsModule`, `ActionDefinition`, the `tx` API, and the error classes. Its version tracks Warden's; the injected API carries `apiVersion`, and Warden refuses to load a module built against a newer major version.

Modules may import other local files and npm packages if the deployment bundles them (for example `esbuild actions/index.ts --bundle --platform=node --format=esm --external:@wardenhq/actions`). A `.ts` module works without compiling when it uses only erasable syntax, because the image's Node 22 strips types natively. Anything else (enums, decorators, path aliases) needs a build first.

### Loading

| Variable         | Default | Description                                                                |
| ---------------- | ------- | -------------------------------------------------------------------------- |
| `WARDEN_ACTIONS` | none    | Path to the actions module, relative to the working directory. Must exist. |

It's an environment variable rather than a config key because it points at code, the same way `WARDEN_CONFIG` points at config. Like the config, the module is loaded once at startup, after config, introspection and `resolveSchema`, and before routes are registered. In Docker, mount it next to the config:

```sh
docker run -v ./actions:/actions:ro -e WARDEN_ACTIONS=/actions/index.js ...
```

The startup rules follow the existing config rules:

| Problem                                                                                                                                                          | Result                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Module missing, throws on import, default export isn't a function, or returns something other than actions                                                       | Startup fails (`ActionsError`)       |
| Invalid definition: duplicate or malformed `name`, unknown `permissions` action, `target` without `on`, unsupported input type (see [Input forms](#input-forms)) | Startup fails, listing every problem |
| `on`, `permissions` or a `ref()` names a table that doesn't exist or is hidden                                                                                   | Warning; that action is disabled     |
| `permissions` includes an action that a table `deny` forbids                                                                                                     | Warning; that action is disabled     |
| Config grants or configures an action name the module doesn't define                                                                                             | Warning                              |

Mistakes in code fail fast, as invalid config does. A mismatch with the database, such as a dropped table, only disables the affected action, so it can't take Warden down.

### `defineAction`

```ts
interface ActionDefinition<I extends z.ZodObject, T extends Target> {
  /** Stable id: grants, URLs and the audit log refer to it. `^[a-z][a-z0-9-]*$`, unique. */
  name: string;
  label: string;
  description?: string;
  /** Entity the action belongs to: a config-style table key (`users`, `billing.invoices`). */
  on: string;
  /** What the action runs against. Default `one`. */
  target?: 'one' | 'many' | 'none';
  /** Upper bound on what `run` may write. Checked at startup, at every write, and shown to admins. */
  permissions: Partial<Record<string, ('create' | 'update' | 'delete')[]>>;
  /** Root must be `z.object`. Omit for actions without input. */
  input?: I;
  /** Prefill the form, e.g. from the target record. */
  defaults?: (ctx: { record?: RecordRef; actor: Actor }) => Partial<z.input<I>> | Promise<...>;
  /** `preview` (default): the user sees the change set before running. `confirm`: a plain confirmation. */
  confirm?: 'preview' | 'confirm';
  /** Styles the button and confirmation as destructive. */
  destructive?: boolean;
  /** Require a reason, as configurable writes do (#35). Config can also turn this on. */
  requireReason?: boolean;
  /** Max rows `run` may change; exceeding it fails the action. Default 1000. */
  maxAffectedRows?: number;
  /** Statement timeout for the transaction. Default: the server's (15 s). */
  timeoutMs?: number;
  run: (ctx: RunContext<z.output<I>, T>) => Promise<ActionResult | void>;
}
```

`target` decides where the action appears and what `run` receives:

| `target` | Shown on                                   | `run` gets                     | Request carries     |
| -------- | ------------------------------------------ | ------------------------------ | ------------------- |
| `one`    | Detail page and the grid's row menu        | `record: RecordRef`            | one record id       |
| `many`   | Grid bulk-action bar for selected rows     | `records: RecordRef[]` (≤ 500) | 1 to 500 record ids |
| `none`   | Grid toolbar (e.g. "Recalculate balances") | nothing extra                  | no record ids       |

`target: 'one'` on an entity without a primary key fails startup, because its rows have no record ids.

```ts
interface RunContext<I, T> {
  input: I;
  record: RecordRef; // target: 'one'
  records: RecordRef[]; // target: 'many'
  tx: ActionTx;
  actor: Actor; // { subject, email, name, roles }
  reason?: string;
  /** Runs after the commit; skipped in preview and on rollback. Its errors are logged, not returned. */
  afterCommit(fn: () => Promise<void>): void;
  log: Logger; // request-scoped pino logger
}

interface RecordRef {
  entity: string;
  id: string; // the API's opaque record id
  label: string; // the row's displayField value
  values: Record<string, unknown>; // visible fields only
}

interface ActionResult {
  /** Shown in a toast. */
  message?: string;
  /** Where the UI goes next, e.g. the record the action created. */
  redirect?: { entity: string; id: string };
}
```

Target records are loaded and locked (`select ... for update`) inside the action's transaction before `run` starts, so `record.values` can't change under it.

### The `tx` API

`run` touches data only through `tx`, which goes through the same paths as the CRUD endpoints:

```ts
interface ActionTx {
  get(entity: string, id: string | RecordRef): Promise<RecordRef | null>;
  list(
    entity: string,
    opts?: { filter?: Filter; sort?: string; limit?: number },
  ): Promise<RecordRef[]>;
  create(entity: string, values: Record<string, unknown>): Promise<RecordRef>;
  update(
    entity: string,
    target: string | RecordRef,
    values: Record<string, unknown>,
  ): Promise<RecordRef>;
  delete(entity: string, target: string | RecordRef): Promise<void>;
  updateMany(entity: string, filter: Filter, values: Record<string, unknown>): Promise<number>;
  deleteMany(entity: string, filter: Filter): Promise<number>;
}
```

- Entities, fields and filters are resolved against the `EffectiveSchema` and checked by `core` (`validateFilter`, `validateRecord`), exactly as for client input. A hidden table or column is absent: using one throws the same error as a nonexistent one. Read-only fields can't be written, even by an action.
- Each write must be covered by `permissions`. Writing outside them throws `ActionPermissionError`, which rolls back. That keeps the declaration honest, so reviewers and admins can trust it as the action's blast radius.
- Every write reads the affected rows first (`for update`), writes, and appends a child audit entry per row (see [Audit linking](#audit-linking)). `updateMany` and `deleteMany` compile their filter with `compileFilter`, the same way the grid does.
- Once the action has changed more than `maxAffectedRows` rows in total, the next write throws and the action rolls back.
- Writes don't cascade audit. Rows that Postgres changes through `on delete cascade` or triggers aren't recorded, the same limitation as the CRUD endpoints. An action that should audit them deletes them explicitly first.

Reads don't require a `read` grant, because the action, not the user, is reading. What the action reads is still limited to visible fields, and the user only sees what `run` returns.

### Why no raw SQL

A `tx.sql` escape hatch would lose per-row audit entries, preview, the permissions check and hidden-column enforcement all at once. The `tx` API above covers multi-row moves and deletes, which are the cases in the epic. If real deployments need more, a later RFC can add `tx.sql` with an explicit config opt-in that records the statement text in the parent audit entry.

### Errors

| Thrown from `run`                                            | Response | Body                                                   |
| ------------------------------------------------------------ | -------- | ------------------------------------------------------ |
| `ActionError(message, { field? })` (the author's own checks) | 400      | the message, attached to the field when given          |
| `tx` validation failure (bad value, unknown field)           | 400      | field errors, same shape as CRUD writes                |
| Constraint violation                                         | 400/409  | mapped by `mapWriteError`, same as CRUD writes         |
| `ActionPermissionError`, row cap exceeded                    | 500      | generic; details logged. These are bugs in the action. |
| Anything else                                                | 500      | generic; details logged                                |

Every error rolls the transaction back, including the parent audit entry. Only `ActionError` messages reach the client, because only the action author writes them.

## Permissions

Running an action is a write, so it is denied unless config grants it. Roles get a new `actions` list next to `grants`:

```yaml
roles:
  ops:
    grants:
      users: [read, update]
    actions: [move-user, refund-order] # or ['*']

actions:
  refund-order:
    requireReason: true
  legacy-cleanup:
    disabled: true
```

A user may run an action when all of these hold:

1. The action loaded, isn't `disabled` in config, and wasn't disabled by a warning at startup.
2. One of the user's roles lists it, or lists `*`.
3. No table `deny` covers anything in its `permissions`. Startup already disables such actions; the request path checks again.
4. The user may `read` the action's `on` entity, and every entity a `ref()` input points at, since the form shows those rows.

The user does **not** need the table grants in `permissions`. Granting an action is a deliberate, narrow escalation: ops may "move a user and delete the old company's orders" without being able to delete arbitrary orders. That's what actions are for. A table `deny` still beats it, as it beats every grant. (Requiring both would turn actions into a convenience wrapper, with no way to let someone do X only in the shape of the action.)

To everyone else, an action is absent. An action that is unknown, disabled, ungranted, or attached to a hidden entity gets the same 404, and it doesn't appear in `/api/actions` or the capabilities response (#31).

The pure parts go in `core`: `resolveActionPolicy(actions, schema, policy, config)` returns the enabled actions and the warnings, and `canRunAction(...)` runs the check above. The server calls `canRunAction` on every request, for preview as well as run.

This adds `roles.<role>.actions` and a top-level `actions` map (`disabled`, `requireReason`, `label`) to `packages/config/src/schema.ts`. Like the rest of the config, both are strict, and names that match nothing are warnings.

## Input forms

The action's `input` is the only definition of the form. At startup Warden converts it with `z.toJSONSchema()` (zod 4) and serves it in the action descriptor. The UI renders it with the form generator from #25.

Supported in v1, since each maps to an existing form control:

| zod                                                  | Control                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| `z.string()`, with `.max()`, `.regex()`              | text input (`meta({ widget: 'textarea' })` for multi-line) |
| `z.number()`, `z.int()`                              | number input                                               |
| `z.boolean()`                                        | checkbox                                                   |
| `z.enum([...])`                                      | select                                                     |
| `z.iso.date()`, `z.iso.datetime()`                   | date / date-time picker                                    |
| `z.array(<one of the above>)`                        | repeatable field / multi-select                            |
| `ref('companies')`, `z.array(ref(...))`              | FK picker for that entity                                  |
| `.optional()`, `.nullable()`, `.default()`           | not required / prefilled                                   |
| `.meta({ label, description, placeholder, widget })` | label, help text, placeholder                              |

Anything else at the top level (nested objects, unions, transforms the JSON Schema can't express) fails startup, because a form can't be rendered for it. Refinements (`.refine`, `.superRefine`) are fine: they run on the server only.

`ref(entity)` is a Warden schema: on the wire it's a record id, and `run` receives the loaded `RecordRef`. The server decodes the id with `decodeRecordId` and loads the row. An id that doesn't decode, or that names a missing row, fails validation with the same message either way. Because the picker lists rows, `ref` requires `read` on its entity.

Validation is server-side only, because the UI can't run the author's zod. The UI uses the JSON Schema for required fields, types, enums and lengths. Preview (or Run, with `confirm: 'confirm'`) returns field errors in the same `FieldError[]` shape as CRUD writes (`toFieldErrors`), and the form shows them inline.

`defaults` prefills the form. The UI calls it through `GET /api/actions/:name/defaults?record=<id>` when the dialog opens.

## Dry-run and preview

Preview runs the action for real and rolls it back:

1. Open a transaction, take the same locks, insert the parent audit entry, and call `run` with the same context. `afterCommit` callbacks are collected but never called.
2. Record the change set: every child audit entry that would be written (operation, entity, record id, before, after, diff), plus the `ActionResult`.
3. `rollback`.

`run` has no way to tell it's being previewed. That's deliberate: an action that behaves differently in preview makes the preview meaningless. The one rule for authors is that **side effects outside the database go in `afterCommit`**, which preview never runs. Documentation and the `RunContext` type both say this. Preview can't stop an action from calling an external API directly in `run`.

The UI shows the change set grouped by entity: counts, then expandable per-row diffs (the History tab's diff component from #36). Long sets are truncated in the response with the total count included (first 200 rows).

### Preview tokens

Data can change between preview and run. Preview returns a `previewToken`: an HMAC (keyed by the session secret) over the action name, input, target ids and a canonical form of the change set. Run accepts the token. When it's present, the server compares the token for the change set it's about to commit, and on a mismatch it rolls back and returns `409 { error: 'preview_stale' }`, so the UI can show "This changed since you previewed it" and preview again.

For the comparison, `create` rows ignore columns filled by defaults or identity, because sequences aren't transactional and a rolled-back preview consumes ids. Updates and deletes compare record ids and diffs.

With `confirm: 'preview'` the UI always sends the token. Run without a token is still allowed for API clients and `confirm: 'confirm'` actions.

Preview costs as much as a run and holds row locks while it executes. It shares `timeoutMs` and `maxAffectedRows` with the real run.

## Audit linking

The `warden.audit_log` table from #66 already has `parent_id`, and its `action` column is free text, so actions need no migration.

**Parent entry.** Inserted first in the action's transaction, so its `id` is available for the children:

| Column                        | Value                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `action`                      | the action's `name`                                                                            |
| `entity`                      | the `on` entity                                                                                |
| `record_id`, `primary_key`    | the target record for `target: 'one'`; null otherwise                                          |
| `before`                      | null                                                                                           |
| `after`                       | `{ "input": <input as sent, ref ids not rows>, "records": [<ids>], "result": <ActionResult> }` |
| `diff`                        | null                                                                                           |
| `reason`, `request_id`, actor | as for any write                                                                               |

**Children.** One per row the action changed, written by `tx` in the same way and with the same shape as a CRUD write (#34): `action` is `create`/`update`/`delete`, with `before`, `after` and `diff`, and `parent_id` set to the parent. The actor, roles, reason and request id are copied from the parent, so a child read on its own (for example in a record's History tab) is still complete.

**Writing.** Children are inserted as each `tx` write happens, not batched at the end, so a failed audit insert fails the write that caused it. Any error rolls everything back, parent included. Preview inserts the same rows and rolls them back with everything else.

**Sensitive input.** An input field marked `.meta({ sensitive: true })` is stored as `"[redacted]"` in the parent's `after.input`. It's still passed to `run` and still counts toward the preview token (through its hash).

**Reading.** A record's History tab (#36) shows child entries like any other, with an "as part of _Move to company_" link to the parent. The parent's view lists its children through `audit_log_parent_idx`. Failed actions leave no audit entry, because they rolled back; they're logged with the request id. Recording failed attempts is [future work](#future-work).

## UI exposure

- `GET /api/actions` returns descriptors for the actions this user may run: `name`, `label`, `description`, `on`, `target`, `confirm`, `destructive`, `requireReason`, `inputSchema` (JSON Schema), and `permissions` (shown in the confirmation step as "Can change: Users (update), Orders (delete)"). The capabilities endpoint (#31) lists action names per entity, so pages can show buttons without fetching every descriptor.
- **Detail page:** `target: 'one'` actions in an "Actions" menu in the header.
- **Grid:** `target: 'one'` in each row's menu, `target: 'many'` in a bulk bar that appears when rows are selected, `target: 'none'` in the toolbar.
- **Dialog:** form, then Preview (the change set) or Confirm, then Run. Destructive actions use the destructive button style. A required reason is a field in the dialog.
- **After run:** toast with `message`, invalidate queries for every entity in the change set, and follow `redirect` if one was returned.

The UI only hides what the user can't run. The server checks permission on every request.

## HTTP API

All routes are under `/api/`, so the session guard covers them.

| Method & path                     | Body / query                                            | Response                                              |
| --------------------------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| `GET /api/actions`                |                                                         | `{ actions: ActionDescriptor[] }`                     |
| `GET /api/actions/:name/defaults` | `?record=<id>` (target `one`)                           | `{ values }`                                          |
| `POST /api/actions/:name/preview` | `{ records?: string[], input, reason? }`                | `{ changes, total, truncated, result, previewToken }` |
| `POST /api/actions/:name/run`     | `{ records?: string[], input, reason?, previewToken? }` | `{ auditId, result }`                                 |

`records` must match the action's `target` (exactly one id, 1 to 500 ids, or none). An unknown or not-permitted action returns 404. Invalid input, invalid record ids or a missing required reason return 400 with field errors. A missing target record returns 404, with the same message for a nonexistent row and an undecodable id.

## Where the code goes

| Package               | Adds                                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `packages/actions`    | New, published. Types, `ActionsModule`, error classes. No runtime dependencies.                                             |
| `packages/config`     | `roles.<role>.actions`, top-level `actions`; docs in `docs/config.md` and the example config.                               |
| `packages/core`       | Definition validation, the zod-to-form subset check, `resolveActionPolicy`, `canRunAction`, preview-token canonicalization. |
| `packages/pg-adapter` | `ActionTx` over Kysely: locked reads, writes and audit inserts (shared with #34's CRUD write path).                         |
| `apps/server`         | Loading `WARDEN_ACTIONS`, the routes above, transaction, timeout and preview orchestration.                                 |
| `apps/web`            | Menus, bulk bar, action dialog, change-set preview.                                                                         |
| `examples/basic`      | `move-user` from the summary, wired into compose, and used by E2E tests.                                                    |

The `tx` write path should be the same code the CRUD endpoints use (#24, #34), with the parent id and the permission check added. Two separate implementations would eventually disagree about auditing.

## Testing

Beyond the happy path, #45 needs tests for:

- Rollback: an error after some writes leaves no rows changed and no audit entries, parent included. So does a failed audit insert.
- Permissions: ungranted, disabled and deny-covered actions all return the same 404. A write outside `permissions` rolls back. Hidden tables and columns can't be read or written through `tx`. Read-only fields reject writes.
- Input: `ref` ids that are tampered, hidden or nonexistent fail identically; unknown input keys are rejected.
- Preview: no rows or audit entries persist; `afterCommit` doesn't run; a stale token returns 409 and commits nothing.
- Audit: one parent, one child per changed row, correct `parent_id`, sensitive input redacted.
- Loading: each startup failure and warning in the table under [Loading](#loading).

A `@wardenhq/actions/testing` helper that runs an action against a test database, for deployments' own tests, is future work.

## Alternatives considered

- **Declarative actions in YAML** (a list of steps with templated values). Fits "config-driven", but every real example needs conditionals or lookups, and it would grow into a poor programming language. Code with a narrow `tx` API is clearer and type-checked.
- **Postgres functions** (an action calls `select app.move_user($1, $2)`). Fully transactional and already in the database, but Warden can't see which rows changed, so it loses per-row audit and preview. Could be added later as a `tx.call` with a coarse audit entry.
- **Webhooks** (Warden POSTs to the deployer's service). Easy to host, but it can't share Warden's transaction, so the action and its audit entry can't commit atomically.
- **Code-level permissions** (`permissions: (actor) => boolean`). Hides who can do what in code that admins can't see in the config. The code declares the blast radius, and config decides who gets it.
- **Requiring both the action grant and the table grants.** Discussed under [Permissions](#permissions).

## Open questions

1. **Bulk targets and the row cap.** Is 500 selected records and 1000 changed rows right? Should config be able to raise `maxAffectedRows` per action?
2. **Isolation level.** Default `read committed` with locked target rows, plus an opt-in `isolation: 'serializable'`? Serialization failures could be retried automatically, since `afterCommit` makes a retry side-effect safe.
3. **Idempotency.** Is the preview token plus a disabled button enough, or should run accept an `Idempotency-Key`?
4. **Failed attempts.** Should denied or failed runs be recorded in a separate, non-rolled-back audit entry? Useful for security review, but it adds a second write path to the audit log.

## Future work

- Global actions (no `on`) on their own page.
- `tx.sql` with a config opt-in, audited as one coarse entry.
- `@wardenhq/actions/testing`.
- Optional generated row types (`warden types > warden-types.d.ts`) for typed `values`, as an opt-in for authors, not something Warden needs at runtime.

## Implementation notes

Where [#45](https://github.com/laclemen92/warden/issues/45) differs from the design above:

- **The parent entry stores its request in `details`, not `after`.** `after` holds row values and is cut down to the reader's visible fields like any other entry, which would drop the input. `details` is `{ input, records }`.
- **The parent doesn't record the result.** It is inserted before `run` (children need its id), and `warden.audit_log` is append-only, so it can't be updated with the outcome. The result is in the response and the server log.
- **Field errors from `tx` writes aren't attached to form fields.** They name the written entity's fields, which can collide with the action's input fields, so they are sent as messages naming the field (`email: is already in use`) under an `invalid <entity> ...` message, rather than with `field`.
- **The UI shows the result in the dialog** instead of a toast (Warden has no toast component yet), with a link for `redirect`.
