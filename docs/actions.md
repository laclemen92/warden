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
- [Calling your API](#calling-your-api)
- [Several endpoints: `http.steps`](#several-endpoints-httpsteps)
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

| Variable                   | Default | Description                                                                                                  |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `WARDEN_ACTIONS`           | none    | Path to the actions module, relative to the working directory. Must exist.                                   |
| `WARDEN_ACTION_ALLOW_HTTP` | `false` | Let [HTTP actions](#calling-your-api) call plain `http` URLs off loopback. Leave it off outside development. |

The module is loaded once at startup, after the config and the database schema. In Docker, mount it next to the config:

```sh
docker run -v ./actions:/actions:ro -e WARDEN_ACTIONS=/actions/index.js ...
```

As with config, mistakes in code fail startup and mismatches with the database only warn:

| Problem                                                                                                                                                                   | Result                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| The module is missing, throws on import, its default export isn't a function or doesn't return a list, or it exports an `apiVersion` newer than Warden's                  | Startup fails (`ActionsError`)       |
| A definition is invalid: duplicate or malformed `name`, unknown key, unknown `permissions` write, unsupported input field                                                 | Startup fails, listing every problem |
| `target: 'one'` or `'many'` on a table without a primary key                                                                                                              | Startup fails                        |
| An enabled [HTTP action](#calling-your-api)'s secret variable isn't set, its fixed `url` or `tokenUrl` isn't https, or it uses `user` auth that this Warden can't provide | Startup fails                        |
| `on`, `permissions` or a `ref()` names a table that is hidden or doesn't exist                                                                                            | Warning; the action is disabled      |
| `permissions` includes a write that a table `deny` forbids, or a table whose `deny` includes `read`                                                                       | Warning; the action is disabled      |
| Config grants or configures an action the module doesn't define                                                                                                           | Warning                              |

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
| `permissions`     | map of table key to writes                 | required     | Everything `run` may write. HTTP actions take none. Checked at startup and at every write, and shown to the user before they run it.                                                      |
| `input`           | `z.object({...})`                          | no input     | The form. See [Input forms](#input-forms).                                                                                                                                                |
| `defaults`        | `({ record, actor }) => values`            | none         | Prefills the form when the dialog opens.                                                                                                                                                  |
| `confirm`         | `preview`, `confirm`                       | `preview`    | `preview` shows the change set before running; `confirm` asks for a plain confirmation.                                                                                                   |
| `destructive`     | boolean                                    | `false`      | Styles the button and confirmation as destructive.                                                                                                                                        |
| `requireReason`   | boolean                                    | `true`       | Running it must say why (an internal note in the audit log). `actions.<name>.requireReason` in config overrides it either way, and a table's own `requireReason` can require it (below).  |
| `maxAffectedRows` | positive integer                           | `1000`       | Changing more rows than this fails the action.                                                                                                                                            |
| `timeoutMs`       | positive integer                           | the pool's   | Statement timeout for the action's transaction.                                                                                                                                           |
| `deadlineMs`      | positive integer                           | the server's | How long a run or preview may take in all. See [Limits](#limits).                                                                                                                         |
| `http`            | object                                     | none         | Call your API instead of `run`. See [Calling your API](#calling-your-api).                                                                                                                |
| `run`             | `async (ctx) => ({ message?, redirect? })` | required     | Does the work. Give either `run` or `http`.                                                                                                                                               |

| `target` | Offered on                               | `run` gets              | The request carries |
| -------- | ---------------------------------------- | ----------------------- | ------------------- |
| `one`    | the detail page and each grid row's menu | `record`                | one record id       |
| `many`   | the grid's bar for selected rows         | `records` (at most 500) | 1 to 500 record ids |
| `none`   | the grid's toolbar                       | neither                 | no record ids       |

Actions require a reason by default, at least [`defaults.reasonMinLength`](config.md#defaults) characters once trimmed (10 unless configured). Set `requireReason: false` for an action where a reason adds nothing; config's `actions.<name>.requireReason` can still turn it back on, or off. A run must also say why when any table in `permissions` sets its own [`requireReason`](config.md#tables) for a write the action may make there, whether or not `run` makes it: the requirement can't depend on what `run` decides to do. `defaults.requireReason` applies to record writes only. See [Required reasons](config.md#required-reasons). `GET /api/actions` reports the result as `requireReason` (and `reasonMinLength`), so the UI asks for it; a preview needs the reason too.

`run` also gets `input` (validated, with picked records loaded), `tx`, `actor` (`{ subject, email, name, userId, roles }`, where `userId` is the user's id in your own users table when config's [`actor`](config.md#actor) maps them to one), `reason`, `log` (a logger for the request), and `afterCommit(fn)`. The target records are loaded and locked (`select ... for update`) before `run` starts, in primary-key order, so runs on overlapping records wait for each other instead of deadlocking. Ids that name the same row (`1` and `01`, a UUID in either case) are the same record: repeated target records, or repeated items in a `ref` array, are a `400`, and the audit log stores each record's canonical id. A record is a `RecordRef`: `{ entity, id, label, values }`, where `label` is its display field and `values` holds its exposed fields.

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

Preview runs the action for real and rolls it back: it takes the same locks, writes the same rows and audit entries, and calls `run` with the same context, then reports every row that would change and undoes it all. `run` can't tell that it's being previewed, which is what makes the preview trustworthy, so **put side effects outside the database (emails, webhooks) in `afterCommit`**, which only runs after a real run commits. Its errors are logged, not returned. When the side effect is the point of the action, and the user must see whether it worked, make it an [HTTP action](#calling-your-api), which is never previewed.

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

## Calling your API

Some operations belong to your application, not to Warden. Resolving a fraud-held payout, say, changes a payout item, a certificate's resolution status and the account's fraud flags together, and that logic lives in your API. Rebuilding it as `tx` writes duplicates it. Calling the API from `run` doesn't work either: preview runs `run` for real, so the API would be called on every preview, and `afterCommit` hides failures.

An HTTP action delegates to an endpoint instead:

```js
defineAction({
  name: 'review-payout',
  label: 'Resolve review',
  on: 'policy_admin.payout_items',
  target: 'one',
  input: z.object({ decision: z.enum(['fraudulent', 'not_fraudulent']) }),
  http: {
    url: (ctx) =>
      `${process.env.SPOT_API_URL}/internal/payout-items/${ctx.record.values.id}/review`,
    method: 'POST',
    body: ({ input, reason }) => ({ decision: input.decision, note: reason }),
    auth: { type: 'hmac', secretEnv: 'WARDEN_API_SECRET' },
    timeoutMs: 10_000,
  },
});
```

| `http` key    | Type                             | Default              | Description                                                                                            |
| ------------- | -------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------ |
| `url`         | string, or `(ctx) => string`     | required             | The endpoint. `https` only, except on loopback, unless `WARDEN_ACTION_ALLOW_HTTP=true`.                |
| `method`      | `POST`, `PUT`, `PATCH`, `DELETE` | `POST`               |                                                                                                        |
| `body`        | `(ctx) => value`                 | `{ input, records }` | The JSON body. By default, the input (record ids for `ref` fields) and the target records' Warden ids. |
| `auth`        | object                           | required             | How Warden authenticates (below).                                                                      |
| `timeoutMs`   | positive integer, at most 60000  | `10000`              | Per request.                                                                                           |
| `perRecord`   | boolean                          | `false`              | `target: 'many'` only: one request per record instead of one for all.                                  |
| `concurrency` | positive integer, at most 16     | `4`                  | With `perRecord`, how many requests are in flight at once.                                             |

`url` and `body` get `{ input, record, records, actor, reason }`, with picked records and target records loaded as for `run` (with `perRecord`, `record` is that request's record). An HTTP action has no `run` and no `permissions`, since it writes nothing through `tx`; defining `run` too fails startup.

### What happens on a run

- **No preview.** An HTTP action is always `confirm: 'confirm'` (setting `preview` fails startup), the UI offers only a confirmation, and `POST /preview` is a `400`. The endpoint is never called during a preview.
- **Audit first, then call once.** Warden validates the request, loads the target records, writes the action's audit entry (who, input, reason, records) and commits it, then calls the endpoint once. A `url` or `body` that throws, or a URL that isn't allowed, fails the run before the entry is written, and nothing is called. `ActionError`s thrown there are `400`s, as in `run`.
- **The answer:**

| API answers                               | User gets                                                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `2xx`                                     | `200`. `message` from a JSON body is shown, and an `id` is recorded in the audit log.                                               |
| `4xx`                                     | `400` with the body's `message` (or `error`, or a `text/plain` body), tags and control characters stripped, at most 300 characters. |
| `401` or `403`                            | `403` with that message, or "not allowed" when there is none (an HTML page isn't a message).                                        |
| `5xx`, a redirect, timeout, network error | `502` (`504` for a timeout) with a generic message. Details go to the log, never to the user.                                       |

Redirects are never followed. Only the first 64 KiB of a response is read. Error responses carry the `auditId` too.

- **Idempotency.** Every request carries `Idempotency-Key`: the action entry's id (with `perRecord`, `<id>.<n>` for the nth record). Make your endpoint apply a key once, so a retried request can't apply twice.
- **Many records.** By default one request carries every record id. Its `2xx` body may report each one as `records: [{ id, ok, message? }]` (Warden's ids, as sent), and the UI lists those that failed; the audit log then records the call as `partial`, or `rejected` when every record failed. With `perRecord: true` Warden sends one request per record, at most `concurrency` at a time, and answers `200` with `result.records` saying how each went; a `5xx` for one record gets the generic message.
- **Limits.** While it calls the API a run holds no database connection and none of the server's action slots, but it counts toward the user's limit (`WARDEN_ACTION_MAX_PER_USER`, see [Limits](#limits)). With `perRecord`, no request starts after the action's deadline (`deadlineMs`, or `WARDEN_ACTION_DEADLINE`, counted from the first request); records not reached fail with "not attempted: the action ran out of time".

### Who's calling: `X-Warden-Context`

Every request carries `X-Warden-Context`, base64url JSON naming who ran what and why:

```json
{
  "action": "review-payout",
  "auditId": "1042",
  "requestId": "6c4a…",
  "actor": { "subject": "auth0|abc", "email": "ana@example.com", "userId": "17", "roles": ["ops"] },
  "reason": "Customer sent proof of address",
  "records": ["5531"],
  "recordCount": 1
}
```

`records` holds the request's record ids, up to 2 KiB of them, so the header stays under common proxy limits; `recordCount` says how many there are. The default body carries them all.

With `hmac` and `client_credentials` auth it is signed with the body, so your API can trust it and record who did what. With `user` auth the bearer token says who the user is; the context header is unsigned.

### `http.auth`

Users never paste tokens. Pick one mode per action:

| `type`               | Keys                                                                             | Sends                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `hmac`               | `secretEnv`                                                                      | `X-Warden-Timestamp` and `X-Warden-Signature` over the request (below).                               |
| `client_credentials` | `tokenUrl`, `clientIdEnv`, `clientSecretEnv`, `secretEnv`, `audience?`, `scope?` | `Authorization: Bearer <M2M token>` from your IdP, and the HMAC signature (keyed with `secretEnv`).   |
| `user`               | `audience`                                                                       | `Authorization: Bearer <the signed-in user's access token>`, so your API applies its own permissions. |

- Secrets are read from the named environment variables at startup. A variable that isn't set fails startup, as does a `tokenUrl` that isn't https (with the same loopback exception).
- `client_credentials` needs `secretEnv` too: the M2M token only says the caller is Warden (any client with a token for the audience could send it), so the signature is what vouches for the actor in `X-Warden-Context`.
- `client_credentials` posts `grant_type=client_credentials` with the client id and secret (and `audience`, `scope`) to `tokenUrl`, caches the token until a minute before it expires, and on a `401` from your API fetches a new one and retries once.
- `user` sends the access token Warden keeps from sign-in for `OIDC_AUDIENCE` (see [Auth0](auth0.md) for setting up an API audience and refresh tokens), refreshed first if it is about to expire. An action whose `audience` isn't `OIDC_AUDIENCE`, or any `user` action when `OIDC_AUDIENCE` isn't set, fails startup. When the token can't be had or refreshed, the run is a `401` "Sign in again to continue" and the API isn't called.
- Tokens and secrets are never sent to the browser, logged, or written to the audit log.

### Verifying the signature

The signature is `v1=` and the hex HMAC-SHA256, keyed with the secret, of these lines joined with `\n`:

```
v1
<METHOD>
<path and query, as requested>
<X-Warden-Timestamp, Unix seconds>
<X-Warden-Context, as sent>
<hex SHA-256 of the raw body>
```

[`docs/examples/verify-warden-request.mjs`](examples/verify-warden-request.mjs) is a reference verifier with no dependencies: copy it into your API. It rejects a tampered body, path, method or context, a timestamp more than five minutes off, and the wrong secret, and returns the context. Verify against the raw body, before JSON parsing, and the path as Warden requested it (behind a proxy that rewrites paths, the original one). Within the five minutes a captured request could be replayed, so dedupe on `Idempotency-Key`.

Express:

```js
import express from 'express';
import { wardenAuth } from './verify-warden-request.mjs';

const app = express();
app.use(express.json({ verify: (req, _res, buf) => void (req.rawBody = buf) }));
app.post(
  '/internal/payout-items/:id/review',
  wardenAuth(process.env.WARDEN_API_SECRET),
  async (req, res) => {
    const { actor, reason } = req.warden;
    const review = await resolveReview(req.params.id, req.body.decision, {
      by: actor.email,
      note: reason,
      idempotencyKey: req.get('Idempotency-Key'),
    });
    res.json({ message: 'Review resolved', id: review.id });
  },
);
```

NestJS: create the app with `NestFactory.create(AppModule, { rawBody: true })` and check the request in a guard:

```ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { verifyWardenRequest } from './verify-warden-request.mjs';

@Injectable()
export class WardenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    try {
      req.warden = verifyWardenRequest({
        secret: process.env.WARDEN_API_SECRET!,
        method: req.method,
        path: req.originalUrl,
        headers: req.headers,
        rawBody: req.rawBody ?? '',
      });
      return true;
    } catch {
      throw new UnauthorizedException('invalid Warden signature');
    }
  }
}
```

### In the audit log

The action's own entry is written before the call, and the log is append-only, so the API's answer goes in a second entry for the same action and record, with no input. Its `details.outcome` holds `attempt` (the first entry's id), `endpoint` (method, origin and path; the query is left out, since it may hold secrets), `result` (`ok`, `rejected`, `failed`, or `partial` when some records failed), the HTTP `status`, the message the user was shown and the `id` a `2xx` named, and with many records each record's result. A `5xx`'s body is only logged. Both entries are shown to the same people as any action entry (see [Audit log](#audit-log)).

## Several endpoints: `http.steps`

### First, prefer one endpoint

HTTP calls can't share a transaction. If a second call fails after the first succeeded, your system is half-changed, and nothing Warden does can make the pair atomic. **When both changes belong to one service, give it one endpoint that makes them in its own transaction, and point a single-call action at it.** Resolving a fraud review that updates a payout item and its claim, both in your API's database, is one endpoint:

```js
// In your API: both changes commit together, or neither does.
app.post('/internal/payout-items/:id/review', wardenAuth(secret), async (req, res) => {
  const result = await db.transaction(async (trx) => {
    const item = await resolvePayoutItem(trx, req.params.id, req.body.decision);
    if (req.body.decision === 'fraudulent') await resolveClaim(trx, item.claimId, 'fraudulent');
    return item;
  });
  res.json({ message: 'Review resolved', id: result.id });
});
```

Multi-step actions are for steps that live in different services, or for endpoints you can't change.

### Steps

Give `http.steps` instead of `url`. The same fraud review, when payouts and claims are separate services:

```js
defineAction({
  name: 'resolve-fraud-review',
  label: 'Resolve review',
  on: 'policy_admin.payout_items',
  target: 'one',
  input: z.object({ decision: z.enum(['fraudulent', 'not_fraudulent']) }),
  http: {
    auth: { type: 'user', audience: 'https://api.example.com' },
    steps: [
      {
        name: 'payout',
        url: (ctx) => `${process.env.API}/internal/payout-items/${ctx.record.values.id}/review`,
        body: ({ input, reason }) => ({ decision: input.decision, note: reason }),
        // Keep this response in the audit log, so a retry can rebuild the next step.
        auditBody: { redact: ['accountNumber'] },
      },
      {
        name: 'claim',
        url: (ctx, prev) =>
          `${process.env.CLAIMS_API}/internal/claims/${prev.payout.body.claimId}/resolve`,
        body: ({ input }) => ({ decision: input.decision }),
        when: ({ input }) => input.decision === 'fraudulent',
        compensate: {
          url: (ctx, prev) =>
            `${process.env.CLAIMS_API}/internal/claims/${prev.payout.body.claimId}/reopen`,
        },
      },
    ],
  },
});
```

| `http` key  | Type                            | Default  | Description                                                          |
| ----------- | ------------------------------- | -------- | -------------------------------------------------------------------- |
| `steps`     | array                           | required | The steps, in order. At most 5 (`WARDEN_ACTION_MAX_STEPS`, 1 to 20). |
| `auth`      | object                          | required | As for a single call ([`http.auth`](#httpauth)); every step uses it. |
| `timeoutMs` | positive integer, at most 60000 | `10000`  | Each step's default timeout.                                         |

`url`, `method`, `body`, `perRecord` and `concurrency` can't be set on `http` with `steps`; set them on each step (`perRecord` isn't available).

| Step key     | Type                                  | Default              | Description                                                                                                                 |
| ------------ | ------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `name`       | `^[a-z][a-zA-Z0-9_]*$`, unique        | required             | Later steps read its answer as `prev.<name>`; the audit log and its `Idempotency-Key` use it.                               |
| `url`        | string, or `(ctx, prev) => string`    | required             | As for a single call.                                                                                                       |
| `method`     | `POST`, `PUT`, `PATCH`, `DELETE`      | `POST`               |                                                                                                                             |
| `body`       | `(ctx, prev) => value`                | `{ input, records }` |                                                                                                                             |
| `when`       | `(ctx, prev) => boolean`              | always               | Skip the step when it returns false. A skip is recorded as `skipped`.                                                       |
| `timeoutMs`  | positive integer, at most 60000       | `http.timeoutMs`     |                                                                                                                             |
| `compensate` | `{ url, method?, body?, timeoutMs? }` |                      | A call that undoes this step if a later one fails. Its functions get `(ctx, prev)`.                                         |
| `auditBody`  | `true`, or `{ redact: [key, ...] }`   | not kept             | Keep the step's JSON response in the audit log, with the values of `redact`'s keys (at any depth) replaced by `[redacted]`. |

`ctx` is what a single call's `url` and `body` get. `prev` holds the earlier steps that succeeded, as `{ status, body }`, where `body` is the parsed JSON response, or `undefined` when it wasn't JSON or was larger than 64 KiB. A skipped step isn't in `prev`.

- **In order, stopping at the first failure.** Each step starts after the one before it answered with a `2xx`. A `4xx`, `5xx`, timeout or network error stops the chain, and later steps aren't called; the user gets the failed step's answer as for a single call (a `400` with its message, or a generic `502`/`504`), plus `steps` and `retryable` (below). A `url`, `body` or `when` that throws stops it too (an `ActionError`'s message is shown; anything else is a generic error and is logged). The first step's request is built before the action's entry is written, so a module error there leaves no attempt behind.
- **Same auth and headers.** Every step is sent with the action's auth mode, `X-Warden-Context` (with the action entry's id as `auditId`) and, with `hmac` and `client_credentials`, its own signature.
- **One `Idempotency-Key` per step:** `<audit entry id>.<step name>`, the same on every retry. Undo calls use `<audit entry id>.<step name>.compensate`.
- **Deadline.** The steps share one deadline, the action's `deadlineMs` (or `WARDEN_ACTION_DEADLINE`), counted from the first step. No step starts after it, and a step still running when it passes is cut off and fails as a timeout (`504`).
- **`compensate` isn't a transaction.** When a step fails, the steps that completed are undone in reverse order where they have `compensate`. Undo calls are best effort: each is made once with its own timeout (not the deadline), and its outcome is logged, recorded in the audit log and shown to the user ("undone", "undo failed"). An undo that fails leaves your system half-changed; the audit log says which.

The response always lists every step:

```json
{
  "statusCode": 502,
  "message": "the API this action calls failed; try again later",
  "auditId": "1042",
  "steps": [
    { "name": "payout", "result": "ok", "message": "Payout held" },
    {
      "name": "claim",
      "result": "failed",
      "message": "the API this action calls failed; try again later"
    }
  ],
  "retryable": true
}
```

A step's `result` is `ok`, `rejected` (a `4xx`), `failed`, `skipped` or `not_attempted`, and an undone step has `compensation: { result, message? }`. A run that succeeds answers `200` with `result.steps` in the same form.

### Retry remaining steps

After a failure, running the action again is the way to recover, and the UI offers **Retry remaining steps**: it resends the failed step and the ones after it, with the same idempotency keys, and never resends a step that completed. If your endpoints apply each `Idempotency-Key` once, a step that timed out but did apply isn't applied twice.

A retry (`POST /api/actions/:name/retry` with `{ auditId }`) rebuilds the requests from the attempt's audit entry: its input, records and reason, with the records loaded as they are now. Later steps get `prev` from the steps' kept bodies (`auditBody`); a step that reads the body of an earlier step that didn't keep it fails with a `409` saying so, without being sent. A retry is refused with a `409`, and `retryable` is false, when:

- any undo call was made, since the steps that completed may have been undone;
- the action has [sensitive](#input-forms) input fields, which the audit log doesn't keep;
- the audit store doesn't keep details or the actor;
- the run is more than 24 hours old (APIs commonly forget idempotency keys after a day);
- every step already completed, or the run is still calling the API.

Only the user who ran it may retry a run, and only while they may run the action; for anyone else it is a `404`, like a run that doesn't exist.

### Steps in the audit log

The action's entry is written before the first step. When the steps finish, a second entry records each step's `name`, `result`, `endpoint`, `status`, `durationMs`, the message shown and the `id` a `2xx` named, plus its undo call's outcome. Response bodies aren't stored unless a step sets `auditBody` (a kept body larger than 8 KiB is left out and marked `bodyOmitted`). A retry writes its own entry (`details.retryOf`: the attempt's id) before sending anything, then an outcome entry with `outcome.retry` set; the steps it didn't resend are marked `earlier`. Entries are never updated.

## Audit log

A run writes one entry for the action itself (its `action` is the action's name, with the input and target record ids, sensitive fields redacted, and the actor, roles, reason and request id) and one entry per changed row, exactly like a CRUD write, linked to it by `parent_id`. The action's entry is written before `run` and records what was asked; the log is append-only, so the result isn't added afterwards (it is in the response and the server log). An [HTTP action](#calling-your-api) writes a second entry with its API's answer. A record's History shows its rows' entries "as part of" the action, and the action's own entry when the action targeted that record; on the audit log page, an action's entry links to the rows it changed (`/api/audit?parent=<id>`). History shows the action's own entry (its input and reason) only to users who could run the action now and to audit admins; to everyone else it, and the action's name on the rows it changed, doesn't exist. Input that picks records from a table the user can't read is left out for everyone. See [Audit log](config.md#audit-log). Failed runs leave no entry, since they roll back; they are logged with the request id.

The action's transaction also carries the `warden.actor_id`, `warden.actor_sub` and `warden.actor_email` settings, set before the target records are loaded, so your triggers can attribute the rows `run` changes (see [`actor`](config.md#actor)).

## HTTP API

All routes require a session. An action the user may not run gets the same `404` as one that doesn't exist, before the request is validated.

| Method & path                     | Body / query                                   | Response                                                                                    |
| --------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET /api/actions`                |                                                | `{ actions: [...] }`: the actions the user may run                                          |
| `GET /api/actions/:name/defaults` | `?record=<id>` (`target: 'one'`)               | `{ values }`                                                                                |
| `POST /api/actions/:name/preview` | `{ records?, input?, reason? }`                | `{ changes, total, truncated, result, previewToken }`; `400` for an HTTP action             |
| `POST /api/actions/:name/run`     | `{ records?, input?, reason?, previewToken? }` | `{ auditId, result }`; an HTTP action's `result` may have `records: [{ id, ok, message? }]` |
| `POST /api/actions/:name/retry`   | `{ auditId }`                                  | As `run`, for the remaining steps of a multi-step run ([Retry](#retry-remaining-steps))     |

Each descriptor in `GET /api/actions` has `name`, `label`, `description`, `on`, `target`, `confirm`, `destructive`, `requireReason`, `reasonMinLength` (when a reason is required), `hasDefaults`, `inputSchema` (JSON Schema) and `permissions`. `GET /api/capabilities` lists, per entity, the names of the actions the user may run on it (`customActions`). Preview returns at most 200 changes, with `total` counting them all.
