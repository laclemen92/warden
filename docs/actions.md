# Custom actions

A custom action is a typed, multi-step operation, such as "move this user to another company and cancel their pending orders", that runs in one transaction and is audited as one entry linking every row it changes. You write actions in JavaScript or TypeScript, point Warden at the module, and grant them to roles in [config](config.md#actions). Warden builds each action's form from its input schema, can preview exactly what it would change, and offers it on the pages where it applies. The design is in [RFC 0001](rfcs/0001-define-action.md).

- [Writing a module](#writing-a-module)
- [Loading it](#loading-it)
- [Trust model](#trust-model)
- [`defineAction`](#defineaction)
- [The `tx` API](#the-tx-api)
- [Concurrency](#concurrency)
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
| `permissions` includes a write that a table `deny` forbids, or a table whose `deny` includes `read`                                                      | Warning; the action is disabled      |
| Config grants or configures an action the module doesn't define                                                                                          | Warning                              |

## Trust model

An actions module is server code, not a plugin in a sandbox. Warden `import()`s it into its own process, so it runs with everything the server has:

- **Secrets.** It can read `process.env`, including `DATABASE_URL`, `WARDEN_SESSION_SECRET` and `OIDC_CLIENT_SECRET`. With the session secret it could forge sessions.
- **The database.** It can open its own connections with Warden's role and run any SQL that role may, bypassing everything `tx` enforces: `permissions`, table `deny`, hidden columns, the audit log and preview.
- **The network and filesystem**, like any Node code.

`tx` keeps well-meaning code honest and makes what an action does reviewable; it doesn't contain hostile code. So:

- **Review modules like server code.** Whoever can change the module can do anything Warden can. Keep it in version control, review changes, and deploy it like the server itself.
- **Mount it read-only** (`-v ./actions:/actions:ro`), and don't let anything Warden runs alongside write to it.
- **Give Warden a least-privilege database role** (see [Restricting the runtime role](database.md#restricting-the-runtime-role)): no DDL, not the owner of the `warden` schema or your tables, so neither Warden nor a module can alter the audit log, its grants or triggers, and only the table access your config actually needs.
- **Treat secrets in the environment as visible to the module.** Pass a module its own credentials for the services it calls, scoped to what it needs.

Within `tx`, a few things deliberately differ from what a user could do through the CRUD routes:

- An action reads and writes with config's view of a table, not the user's: field-level rules (`readableBy`, `writableBy`) don't apply, and the user needs no table grants for what `permissions` declares. Granting an action is the escalation (see [config](config.md#actions)). Table `deny` still applies, including `deny: [read]`, which makes a table as absent to `tx` as a hidden one. So does [hard delete](config.md#hard-delete): an action whose `permissions` include `delete` on a table that doesn't allow it is disabled at startup, so `tx.delete` and `tx.deleteMany` only ever reach tables with `allowDelete` (or `defaults.delete: granted`).
- `defaults` and `run` see values the user may not be allowed to read, and what they return (`defaults` values, `run`'s `message`) is sent to the user as-is. Don't copy restricted fields into them.
- `confirm: 'preview'` is how the UI asks before running; the API doesn't require a preview first. A run that sends the preview's token is checked against it (see [Preview](#preview)); one that doesn't simply runs. Who may run an action is decided by roles, not by the preview.

## `defineAction`

| Key               | Type                                       | Default      | Description                                                                                                                                                                               |
| ----------------- | ------------------------------------------ | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`            | string, `^[a-z][a-z0-9-]*$`                | required     | Stable id. Config grants, URLs and the audit log use it. Not `create`, `update`, `delete`, `export`, `assign`, `unassign` or `acknowledge`: the audit log uses those for its own entries. |
| `label`           | string                                     | required     | Shown on buttons and the dialog. Config can override it.                                                                                                                                  |
| `description`     | string                                     | none         | Shown in the dialog.                                                                                                                                                                      |
| `on`              | table key (`users`, `billing.invoices`)    | required     | The entity whose pages offer the action.                                                                                                                                                  |
| `target`          | `one`, `many`, `none`                      | `one`        | What it runs against (below).                                                                                                                                                             |
| `permissions`     | map of table key to writes                 | required     | Everything `run` may write. Checked at startup and at every write, and shown to the user before they run it.                                                                              |
| `input`           | `z.object({...})`                          | no input     | The form. See [Input forms](#input-forms).                                                                                                                                                |
| `defaults`        | `({ record, actor }) => values`            | none         | Prefills the form when the dialog opens.                                                                                                                                                  |
| `confirm`         | `preview`, `confirm`                       | `preview`    | `preview` shows the change set before running; `confirm` asks for a plain confirmation.                                                                                                   |
| `destructive`     | boolean                                    | `false`      | Styles the button and confirmation as destructive.                                                                                                                                        |
| `requireReason`   | boolean                                    | `false`      | Running it must say why. Config can also turn this on, and so does a table's `requireReason` (below).                                                                                     |
| `maxAffectedRows` | positive integer                           | `1000`       | Changing more rows than this fails the action.                                                                                                                                            |
| `timeoutMs`       | positive integer                           | the pool's   | Statement timeout for the action's transaction.                                                                                                                                           |
| `deadlineMs`      | positive integer                           | the server's | How long a run or preview may take in all. See [Limits](#limits).                                                                                                                         |
| `run`             | `async (ctx) => ({ message?, redirect? })` | required     | Does the work.                                                                                                                                                                            |

| `target` | Offered on                               | `run` gets              | The request carries |
| -------- | ---------------------------------------- | ----------------------- | ------------------- |
| `one`    | the detail page and each grid row's menu | `record`                | one record id       |
| `many`   | the grid's bar for selected rows         | `records` (at most 500) | 1 to 500 record ids |
| `none`   | the grid's toolbar                       | neither                 | no record ids       |

A run must also say why when any table in `permissions` has [`requireReason`](config.md#tables) for a write the action may make there, whether or not `run` makes it: the requirement can't depend on what `run` decides to do. `GET /api/actions` reports the result as `requireReason`, so the UI asks for it.

`run` also gets `input` (validated, with picked records loaded), `tx`, `actor` (`{ subject, email, name, roles }`), `reason`, `log` (a logger for the request), and `afterCommit(fn)`. The target records are loaded and locked (`select ... for update`) before `run` starts, in primary-key order, so runs on overlapping records wait for each other instead of deadlocking. Ids that name the same row (`1` and `01`, a UUID in either case) are the same record: repeated target records, or repeated items in a `ref` array, are a `400`, and the audit log stores each record's canonical id. A record is a `RecordRef`: `{ entity, id, label, values }`, where `label` is its display field and `values` holds its exposed fields.

`run` may return `{ message }`, shown when it finishes, and `{ redirect: { entity, id } }`, a record the UI offers to open.

## The `tx` API

`run` reads and writes data only through `tx`, which goes through the same validation and write path as the CRUD routes:

```ts
tx.get(entity, id | record, { lock? })                  // RecordRef | null
tx.list(entity, { filter?, sort?, limit?, lock? })     // RecordRef[], limit 1 to 1000 (default 100)
tx.create(entity, values)                       // RecordRef
tx.update(entity, id | record, values)          // RecordRef
tx.delete(entity, id | record)
tx.updateMany(entity, filter, values)           // number of rows changed
tx.deleteMany(entity, filter)                   // number of rows deleted
```

- Entities are config-style table keys. Fields, values and [filters](../packages/core/src/filter.ts) are checked exactly as client input is, against the schema config exposes: a hidden table or column, or a table config `deny`s reading, is indistinguishable from one that doesn't exist, and read-only fields can't be written.
- Every write must be covered by `permissions`, or it throws and the action rolls back. That keeps the declaration honest, so whoever reviews or grants an action can trust it as the action's blast radius.
- Every write locks the rows it changes, writes them, and records an audit entry for each. `updateMany` and `deleteMany` work row by row, so each row gets its own before and after.
- Reads don't need a `read` grant: the action reads, not the user. They still see only exposed fields, and the user sees only what `run` returns. Field-level rules (`readableBy`, `writableBy`) don't apply to actions; `permissions` decides what they may write.
- Rows that Postgres changes through `on delete cascade` or triggers aren't recorded, as with the CRUD routes. Delete dependent rows explicitly first if they should be audited.

`tx` has no raw SQL: it would bypass the audit entries, preview, the permissions check and hidden columns all at once. That is a guardrail, not a sandbox: module code can still reach the database by other means (see [Trust model](#trust-model)).

## Concurrency

A run is one transaction at Postgres's default isolation, read committed. What Warden locks for you (`select ... for update`, held until the run commits or rolls back):

- the target records (`record`, `records`), before `run` starts;
- every row a write changes, including each row `updateMany` and `deleteMany` match;
- what `tx.get` and `tx.list` return, when you pass `lock: true`.

Plain reads, and picked records in `input`, aren't locked. So a run that reads a row, computes from it, and writes it back can lose an update: two runs both read a total of 100, both write 110, and one +10 is gone. Lock what you read when you'll write it back from what you read:

```js
async run({ tx, input }) {
  // Another run adding to the same account waits here until this one commits, then reads 110.
  const account = await tx.get('accounts', input.account.id, { lock: true });
  await tx.update('accounts', account, { balance: Number(account.values.balance) + input.amount });
}
```

The target records are already locked, so read-modify-write on `record` itself is safe. Locked rows block other runs, and CRUD writes, to the same rows until the run ends, so lock only what you'll write, and keep runs short (see [Limits](#limits)). When two runs lock the same rows in different orders, Postgres aborts one to break the deadlock and the user gets a `503` to try again (see [Errors](#errors)); `tx.list` with a `sort` locks in that order, which helps keep orders consistent.

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

Every array field takes at most 500 items unless its schema sets its own bound with `.max(n)`. Longer arrays are refused with a `400` before anything is parsed or looked up, and the bound is in the form's JSON Schema (`maxItems`). Picked records are looked up together, not one query per id.

## Preview

Preview runs the action for real and rolls it back: it takes the same locks, writes the same rows and audit entries, and calls `run` with the same context, then reports every row that would change and undoes it all. `run` can't tell that it's being previewed, which is what makes the preview trustworthy, so **put side effects outside the database (emails, webhooks) in `afterCommit`**, which only runs after a real run commits. Its errors are logged, not returned.

Preview is the UI's step, not the API's: a run doesn't need one (see [Trust model](#trust-model)). A preview returns a token that signs what it would change. Running with the token checks that the run would change exactly the same thing; if the data changed in between, the run rolls back with `409` (`error: "preview_stale"`) and the UI asks to preview again. Creates are compared by the values `run` gave, since a rolled-back preview still uses up sequence values.

The preview shows each user only what they may read: rows of tables they can't read appear without their record ids or values, and fields a [field-level rule](config.md#field-level-rules) keeps from them are left out.

## Errors

Every error rolls the whole action back, its audit entries included.

| Thrown in `run`                                          | Response                                               |
| -------------------------------------------------------- | ------------------------------------------------------ |
| `new ActionError(message, { field? })`                   | `400` with the message, attached to the field if given |
| An invalid `tx` call (unknown table or field, bad value) | `400` with the problems the user may see (below)       |
| A constraint violation                                   | `400` or `409`, as for CRUD writes                     |
| A `tx` call `run` didn't await                           | `500`, details in the log: a bug in the action         |
| A write outside `permissions`, too many rows             | `500`, details in the log: bugs in the action          |
| A deadlock or serialization failure with another change  | `503`; nothing was changed, so running again can work  |
| Anything else                                            | `500`, details in the log                              |

Only `ActionError` messages are written for users, so only they and Warden's own validation messages are sent. Any other error is a `500`, even one carrying a `4xx` `statusCode` (as some SDKs' errors do), whether it's thrown in `run`, during a preview, or in `defaults`.

Since `tx` reads and writes with the action's view, not the user's, an invalid `tx` call's problems are trimmed to what the user may read: problems with fields they can't read are left out, a filter's or sort's problems are only sent to users who can read every field of the table, and a table they can't read isn't named (`the action made an invalid change`). Everything is in the log.

A database error can't be caught and recovered from. Postgres aborts the transaction on any error, and there are no savepoints, so once a `tx` call fails in the database (a constraint violation, a statement timeout), every later `tx` call throws the same error and the action fails with it, even if `run` catches it and returns: nothing commits, `afterCommit` doesn't run, and preview reports the error. Check what you can first (`tx.get`, `tx.list`) instead of trying a write and catching. Invalid `tx` calls (an unknown field, a write outside `permissions`) are rejected before any SQL, so they don't fail the transaction.

Await every `tx` call (`for ... of`, or `await Promise.all(...)`; not `records.forEach(async ...)`). If `run` returns while calls are still running, Warden waits for them, then rolls back with a `500`; calls made after `run` has returned throw. A promise rejection nobody handles is logged and doesn't stop the server.

## Limits

Actions run on a pool of their own, so however many are running, stalled or slow, the main pool stays free for sessions and every other request.

- **Concurrency:** a server runs at most 4 runs and previews at once, 2 per user (`WARDEN_ACTION_MAX_CONCURRENT`, `WARDEN_ACTION_MAX_PER_USER`); the action pool has that many connections. Further requests get a `429` until one finishes.
- **Deadline:** a run or preview that takes longer than 60 seconds (`WARDEN_ACTION_DEADLINE`, or the action's `deadlineMs`) is rolled back and answered with a `503`. Its connection is closed, so it frees its slot even if `run` never settles (say, awaiting a webhook with no timeout), and every later `tx` call throws. `run` itself can't be stopped: it is in-process code, so give your own calls timeouts too.
- **Statements** time out as on every other connection (15 seconds), or after the action's `timeoutMs`.

`run` runs in Warden's own process. A synchronous loop (heavy CPU work, a `while` that never yields) blocks the event loop, and with it every request to that server, and no deadline can interrupt it. Keep `run` asynchronous and its work proportionate; move heavy computation out of process.

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
