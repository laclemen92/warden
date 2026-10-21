# Custom actions

A custom action is a typed, multi-step operation, such as "move this user to another company and cancel their pending orders", that runs in one transaction and is audited as one entry linking every row it changes. You write actions in JavaScript or TypeScript, point Warden at the module, and grant them to roles in [config](config.md#actions). Warden builds each action's form from its input schema, can preview exactly what it would change, and offers it on the pages where it applies. The design is in [RFC 0001](rfcs/0001-define-action.md).

- [Writing a module](#writing-a-module)
- [Loading it](#loading-it)
- [`defineAction`](#defineaction)
- [The `tx` API](#the-tx-api)
- [Input forms](#input-forms)
- [Preview](#preview)
- [Errors](#errors)
- [Audit log](#audit-log)
- [HTTP API](#http-api)

## Writing a module

The module's default export is a function. Warden calls it with its own `defineAction`, `z` (zod 4), `ref` and `ActionError`, and it returns a list of actions:

```js
/** @type {import('@wardenhq/actions').ActionsModule} */
export default ({ defineAction, z, ref, ActionError }) => [
  defineAction({
    name: 'move-user',
    label: 'Move to company',
    on: 'users',
    target: 'one',
    permissions: { users: ['update'], orders: ['update'] },
    input: z.object({
      company: ref('companies').meta({ label: 'New company' }),
      cancelPendingOrders: z.boolean().default(false),
    }),
    async run({ tx, record: user, input }) {
      if (input.company.values.id === user.values.company_id) {
        throw new ActionError(`${user.label} is already there`, { field: 'company' });
      }
      await tx.update('users', user, { company_id: input.company.values.id });
      if (input.cancelPendingOrders) {
        await tx.updateMany(
          'orders',
          {
            and: [
              { field: 'user_id', op: 'eq', value: user.values.id },
              { field: 'status', op: 'eq', value: 'pending' },
            ],
          },
          { status: 'cancelled' },
        );
      }
      return { message: `Moved ${user.label} to ${input.company.label}` };
    },
  }),
];
```

Use the `z` Warden passes in rather than your own copy, so Warden can read your input schemas. Since everything arrives as arguments, the module needs no packages at runtime, which matters in Docker, where a mounted file can't resolve anything from Warden's `node_modules`. Import only types from [`@wardenhq/actions`](../packages/actions) (`ActionsModule`, `ActionDefinition`, `ActionTx`, `RecordRef`, ...).

A module may import its own local files. To use npm packages, bundle it first, for example `esbuild actions/index.ts --bundle --platform=node --format=esm --external:@wardenhq/actions`. A `.ts` file runs without a build if your Node strips types and the file uses only erasable syntax (no enums, decorators or path aliases).

[`examples/basic/actions/index.js`](../examples/basic/actions/index.js) has a one-record, a many-record and a no-record action against the example schema.

## Loading it

| Variable         | Default | Description                                                                |
| ---------------- | ------- | -------------------------------------------------------------------------- |
| `WARDEN_ACTIONS` | none    | Path to the actions module, relative to the working directory. Must exist. |

The module is loaded once at startup, after the config and the database schema. In Docker, mount it next to the config:

```sh
docker run -v ./actions:/actions:ro -e WARDEN_ACTIONS=/actions/index.js ...
```

As with config, mistakes in code fail startup and mismatches with the database only warn:

| Problem                                                                                                                                                  | Result                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| The module is missing, throws on import, its default export isn't a function or doesn't return a list, or it exports an `apiVersion` newer than Warden's | Startup fails (`ActionsError`)       |
| A definition is invalid: duplicate or malformed `name`, unknown key, unknown `permissions` write, unsupported input field                                | Startup fails, listing every problem |
| `target: 'one'` or `'many'` on a table without a primary key                                                                                             | Startup fails                        |
| `on`, `permissions` or a `ref()` names a table that is hidden or doesn't exist                                                                           | Warning; the action is disabled      |
| `permissions` includes a write that a table `deny` forbids                                                                                               | Warning; the action is disabled      |
| Config grants or configures an action the module doesn't define                                                                                          | Warning                              |

## `defineAction`

| Key               | Type                                       | Default    | Description                                                                                                  |
| ----------------- | ------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `name`            | string, `^[a-z][a-z0-9-]*$`                | required   | Stable id. Config grants, URLs and the audit log use it.                                                     |
| `label`           | string                                     | required   | Shown on buttons and the dialog. Config can override it.                                                     |
| `description`     | string                                     | none       | Shown in the dialog.                                                                                         |
| `on`              | table key (`users`, `billing.invoices`)    | required   | The entity whose pages offer the action.                                                                     |
| `target`          | `one`, `many`, `none`                      | `one`      | What it runs against (below).                                                                                |
| `permissions`     | map of table key to writes                 | required   | Everything `run` may write. Checked at startup and at every write, and shown to the user before they run it. |
| `input`           | `z.object({...})`                          | no input   | The form. See [Input forms](#input-forms).                                                                   |
| `defaults`        | `({ record, actor }) => values`            | none       | Prefills the form when the dialog opens.                                                                     |
| `confirm`         | `preview`, `confirm`                       | `preview`  | `preview` shows the change set before running; `confirm` asks for a plain confirmation.                      |
| `destructive`     | boolean                                    | `false`    | Styles the button and confirmation as destructive.                                                           |
| `requireReason`   | boolean                                    | `false`    | Running it must say why. Config can also turn this on.                                                       |
| `maxAffectedRows` | positive integer                           | `1000`     | Changing more rows than this fails the action.                                                               |
| `timeoutMs`       | positive integer                           | the pool's | Statement timeout for the action's transaction.                                                              |
| `run`             | `async (ctx) => ({ message?, redirect? })` | required   | Does the work.                                                                                               |

| `target` | Offered on                               | `run` gets              | The request carries |
| -------- | ---------------------------------------- | ----------------------- | ------------------- |
| `one`    | the detail page and each grid row's menu | `record`                | one record id       |
| `many`   | the grid's bar for selected rows         | `records` (at most 500) | 1 to 500 record ids |
| `none`   | the grid's toolbar                       | neither                 | no record ids       |

`run` also gets `input` (validated, with picked records loaded), `tx`, `actor` (`{ subject, email, name, roles }`), `reason`, `log` (a logger for the request), and `afterCommit(fn)`. The target records are loaded and locked (`select ... for update`) before `run` starts. A record is a `RecordRef`: `{ entity, id, label, values }`, where `label` is its display field and `values` holds its exposed fields.

`run` may return `{ message }`, shown when it finishes, and `{ redirect: { entity, id } }`, a record the UI offers to open.

## The `tx` API

`run` reads and writes data only through `tx`, which goes through the same validation and write path as the CRUD routes:

```ts
tx.get(entity, id | record)                     // RecordRef | null
tx.list(entity, { filter?, sort?, limit? })     // RecordRef[], limit 1 to 1000 (default 100)
tx.create(entity, values)                       // RecordRef
tx.update(entity, id | record, values)          // RecordRef
tx.delete(entity, id | record)
tx.updateMany(entity, filter, values)           // number of rows changed
tx.deleteMany(entity, filter)                   // number of rows deleted
```

- Entities are config-style table keys. Fields, values and [filters](../packages/core/src/filter.ts) are checked exactly as client input is, against the schema config exposes: a hidden table or column is indistinguishable from one that doesn't exist, and read-only fields can't be written.
- Every write must be covered by `permissions`, or it throws and the action rolls back. That keeps the declaration honest, so whoever reviews or grants an action can trust it as the action's blast radius.
- Every write locks the rows it changes, writes them, and records an audit entry for each. `updateMany` and `deleteMany` work row by row, so each row gets its own before and after.
- Reads don't need a `read` grant: the action reads, not the user. They still see only exposed fields, and the user sees only what `run` returns. Field-level `readableBy` rules don't apply to actions.
- Rows that Postgres changes through `on delete cascade` or triggers aren't recorded, as with the CRUD routes. Delete dependent rows explicitly first if they should be audited.

There is no raw SQL: it would bypass the audit entries, preview, the permissions check and hidden columns all at once.

## Input forms

The action's `input` is the form. Each field becomes a control:

| zod                                                  | Control                                                     |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| `z.string()`, with `.max()`, `.regex()`, ...         | text input (`.meta({ widget: 'textarea' })` for multi-line) |
| `z.number()`, `z.int()`                              | number input                                                |
| `z.boolean()`                                        | checkbox                                                    |
| `z.enum([...])`                                      | select                                                      |
| `z.iso.date()`, `z.iso.datetime()`                   | date / date-time picker                                     |
| `z.array(<one of the above>)`                        | a list of them                                              |
| `ref('companies')`, `z.array(ref(...))`              | a record picker for that table                              |
| `.optional()`, `.nullable()`, `.default()`           | not required / prefilled                                    |
| `.meta({ label, description, placeholder, widget })` | label, help text, placeholder                               |
| `.meta({ sensitive: true })`                         | redacted in the audit log, also on a list's items           |

Anything else at the top level (nested objects, unions, transforms) fails startup, because no form can be rendered for it. Refinements (`.refine`, `.superRefine`) are fine; they run on the server. Unknown input keys are rejected.

A `ref` field is a record id on the wire, and `run` receives the loaded `RecordRef`. An id that doesn't decode and one that names no row get the same error. Because the picker lists rows, users need `read` on the picked table to run the action.

## Preview

Preview runs the action for real and rolls it back: it takes the same locks, writes the same rows and audit entries, and calls `run` with the same context, then reports every row that would change and undoes it all. `run` can't tell that it's being previewed, which is what makes the preview trustworthy, so **put side effects outside the database (emails, webhooks) in `afterCommit`**, which only runs after a real run commits. Its errors are logged, not returned.

A preview returns a token that signs what it would change. Running with the token checks that the run would change exactly the same thing; if the data changed in between, the run rolls back with `409` (`error: "preview_stale"`) and the UI asks to preview again. Creates are compared by the values `run` gave, since a rolled-back preview still uses up sequence values.

The preview shows each user only what they may read: rows of tables they can't read appear without their record ids or values, and fields a [field-level rule](config.md#field-level-rules) keeps from them are left out.

## Errors

Every error rolls the whole action back, its audit entries included.

| Thrown in `run`                                          | Response                                               |
| -------------------------------------------------------- | ------------------------------------------------------ |
| `new ActionError(message, { field? })`                   | `400` with the message, attached to the field if given |
| An invalid `tx` call (unknown table or field, bad value) | `400` with the problems                                |
| A constraint violation                                   | `400` or `409`, as for CRUD writes                     |
| A write outside `permissions`, too many rows             | `500`, details in the log: bugs in the action          |
| Anything else                                            | `500`, details in the log                              |

Only `ActionError` messages are written for users, so only they and Warden's own validation messages are sent.

## Audit log

A run writes one entry for the action itself (its `action` is the action's name, with the input and target record ids, sensitive fields redacted, and the actor, roles, reason and request id) and one entry per changed row, exactly like a CRUD write, linked to it by `parent_id`. The action's entry is written before `run` and records what was asked; the log is append-only, so the result isn't added afterwards (it is in the response and the server log). A record's History shows its rows' entries "as part of" the action, and the action's own entry when the action targeted that record; on the audit log page, an action's entry links to the rows it changed (`/api/audit?parent=<id>`). History shows the action's own entry (its input and reason) only to users who could run the action now and to audit admins; to everyone else it, and the action's name on the rows it changed, doesn't exist. Input that picks records from a table the user can't read is left out for everyone. See [Audit log](config.md#audit-log). Failed runs leave no entry, since they roll back; they are logged with the request id.

## HTTP API

All routes require a session. An action the user may not run gets the same `404` as one that doesn't exist, before the request is validated.

| Method & path                     | Body / query                                   | Response                                              |
| --------------------------------- | ---------------------------------------------- | ----------------------------------------------------- |
| `GET /api/actions`                |                                                | `{ actions: [...] }`: the actions the user may run    |
| `GET /api/actions/:name/defaults` | `?record=<id>` (`target: 'one'`)               | `{ values }`                                          |
| `POST /api/actions/:name/preview` | `{ records?, input?, reason? }`                | `{ changes, total, truncated, result, previewToken }` |
| `POST /api/actions/:name/run`     | `{ records?, input?, reason?, previewToken? }` | `{ auditId, result }`                                 |

Each descriptor in `GET /api/actions` has `name`, `label`, `description`, `on`, `target`, `confirm`, `destructive`, `requireReason`, `hasDefaults`, `inputSchema` (JSON Schema) and `permissions`. `GET /api/capabilities` lists, per entity, the names of the actions the user may run on it (`customActions`). Preview returns at most 200 changes, with `total` counting them all.
