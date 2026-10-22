# Configuration reference

Warden needs one decision from you before it starts: who may sign in ([`access`](#access)). Beyond that it introspects the database and exposes every table and column, readable by everyone who can sign in and writable by nobody. Hard deletes are off on every table until config turns them on (see [Hard delete](#hard-delete)). The rest of the config only narrows and customizes that. It hides tables and columns, locks fields read-only, adjusts labels and defaults, and grants write actions to roles.

- [Loading the config](#loading-the-config)
- [Errors and warnings](#errors-and-warnings)
- [`schemas`](#schemas)
- [`defaults`](#defaults)
- [`tables`](#tables)
- [`tables.<table>.columns`](#tablestablecolumns)
- [`roles`](#roles)
- [`actions`](#actions)
- [`access`](#access)
- [`audit`](#audit)
- [`actor`](#actor)
- [Schema drift](#schema-drift)
- [Audit log](#audit-log)
- [Saved views](#saved-views)
- [CSV export](#csv-export)
- [Full example](#full-example)

Custom actions (code, loaded from `WARDEN_ACTIONS`) are described in [actions.md](actions.md).

## Loading the config

Warden reads one file at startup, YAML or JSON. It uses the first of:

1. The path in the `WARDEN_CONFIG` environment variable, relative to the working directory. This file must exist.
2. `warden.config.yaml`, `warden.config.yml`, or `warden.config.json` in the working directory, checked in that order.
3. No file: the built-in defaults. Warden still won't start, because [`access`](#access) is required.

In Docker, mount the file and point `WARDEN_CONFIG` at it:

```sh
docker run -v ./warden.config.yaml:/config/warden.config.yaml:ro \
  -e WARDEN_CONFIG=/config/warden.config.yaml ...
```

Config is read once. Restart Warden to apply changes.

An empty file means the same as no file. Every key below is optional except `access`.

## Errors and warnings

Warden separates mistakes in the file from mismatches between the file and the database.

**Invalid config fails startup.** Syntax errors, unknown keys (typos such as `hiden`), wrong types, unknown values, and the rule violations noted below stop Warden with a `ConfigError` that lists every problem with its line and column:

```text
Invalid Warden config /config/warden.config.yaml:
  - tables.users.columns.password_hash.hiden (line 5, col 9): Unrecognized key: "hiden"
  - defaults.expose (line 2, col 11): Invalid option: expected one of "all"|"none"
```

**Config that doesn't match the database only warns.** A table or column that the config names but the database doesn't have is ignored, and Warden logs a warning with the key path, for example `config: table "public.legacy_orders" does not exist`. Dropping a column must never take the backoffice down, so check the startup log after schema changes.

## `schemas`

| Key       | Type            | Default    |
| --------- | --------------- | ---------- |
| `schemas` | list of strings | `[public]` |

The Postgres schemas Warden introspects. Tables in other schemas don't exist as far as Warden is concerned.

The first schema is the **default schema**. Tables in it are referred to by bare name (`users`) in config, URLs, and the API. Tables in other schemas use `schema.table` (`billing.invoices`). In config, `users` and `public.users` (when `public` is the default schema) mean the same table. Listing a table under both spellings, in `tables` or in one role's `grants`, fails startup with an error at both keys: rules split across two entries would otherwise be applied inconsistently.

A table whose name contains a dot gets a key that can collide with a table in another listed schema: `"a.b"` in the default schema and `b` in schema `a` would both be `a.b`. If both are exposed, Warden refuses to start and names the two tables. Rename one, or set `defaults.expose: none` and list only the tables to expose.

A `schema.table` key whose schema isn't listed in `schemas` fails startup.

```yaml
schemas: [public, billing]
tables:
  users: {} # public.users
  billing.invoices: {}
```

## `defaults`

| Key                        | Values                               | Default                    |
| -------------------------- | ------------------------------------ | -------------------------- |
| `defaults.expose`          | `all`, `none`                        | `all`                      |
| `defaults.newColumns`      | `visible`, `hidden`, `readOnly`      | `visible`                  |
| `defaults.read`            | `all`, `granted`                     | `all`                      |
| `defaults.delete`          | `none`, `granted`                    | `none`                     |
| `defaults.requireReason`   | list of `create`, `update`, `delete` | `[create, update, delete]` |
| `defaults.reasonMinLength` | integer, 1 to 2000                   | `10`                       |

**`defaults.expose`** decides which tables Warden shows.

- `all`: every introspected table, minus those configured with `hidden: true`.
- `none`: only tables listed under `tables` (an empty entry such as `orders: {}` is enough), minus hidden ones. New tables stay out until you add them, which is the safer choice for databases with sensitive tables.

**`defaults.newColumns`** decides how columns that have no entry under `tables.<table>.columns` are treated. It applies to columns added to the database later as well as to columns you never configured.

- `visible`: shown and writable (when a role grants writes).
- `hidden`: removed, as if configured `hidden: true`. Only columns with an entry are shown.
- `readOnly`: shown but never writable.

A column with any entry, even `{}`, ignores this setting: it's visible and writable unless the entry sets `hidden` or `readOnly`. Primary key columns are always visible.

**`defaults.read`** decides who may read exposed tables.

- `all`: everyone who can sign in may read every exposed table.
- `granted`: reading a table requires a `read` grant from one of the user's [roles](#roles).

A table's [`deny`](#tables) can still forbid reading it in either mode.

**`defaults.delete`** decides whether a `delete` grant on a table can hard-delete its rows. See [Hard delete](#hard-delete).

- `none`: deleting is refused on every table, even for a role granted `delete`, unless the table sets [`allowDelete: true`](#tables).
- `granted`: a role's `delete` grant on a table is honored, unless the table sets `allowDelete: false`.

`delete` can't be granted with `*` in either mode: a `*` grant that lists it fails startup.

**`defaults.requireReason`** lists the writes that must say why, on every table that doesn't set its own [`requireReason`](#tables). By default that's all three: every create, update and delete needs a reason. See [Required reasons](#required-reasons). `[]` makes reasons optional.

**`defaults.reasonMinLength`** is the shortest a required reason may be, in characters, after trimming whitespace, so `.` or `fix` doesn't count. It applies to required reasons on tables and [custom actions](#actions) alike.

```yaml
defaults:
  expose: none
  newColumns: hidden
  read: granted
  delete: none
  requireReason: [update, delete] # creates may skip the reason
  reasonMinLength: 15
```

### Required reasons

Every write may send a `reason`, stored in the [audit log](#audit-log) with the change. The UI labels it **Internal note**: people who can read the audit log see it, end users of your application don't. Unless config says otherwise, it is required: the API rejects a write that needs one with a 400 when the reason is missing, only whitespace, or shorter than `defaults.reasonMinLength` once trimmed, and the UI won't save, delete or run an action until the note is long enough. A reason is never longer than 2,000 characters, required or not.

What needs one:

- **Creates, updates and deletes:** the table's `requireReason` if it sets one, otherwise `defaults.requireReason`. A table's list overrides the default either way: `requireReason: []` turns reasons off for that table, and `requireReason: [delete]` requires them for deletes only.
- **[Custom actions](#actions):** required unless the action's definition sets `requireReason: false`. `actions.<action>.requireReason` overrides the definition either way. A table that sets its own `requireReason` covering a write the action may make on it requires one regardless; `defaults.requireReason` doesn't apply to actions.

```yaml
defaults:
  requireReason: [create, update, delete] # the default
tables:
  page_views:
    requireReason: [] # high-volume corrections; reasons optional
actions:
  resend-invite:
    requireReason: false
```

> **Upgrading:** reasons used to be optional unless a table opted in. Writes and actions that don't send one now get a 400. Set `defaults.requireReason: []` (and `requireReason: false` on actions) to go back to optional reasons. Until you do, Warden logs a startup notice saying so.

### Hard delete

Deleting a row through Warden removes it for good. That's riskier than other writes: most applications soft-delete and have their own cleanup and invariants that a hard delete skips; `on delete cascade` and `set null` foreign keys change other tables outside Warden's policy and audit log (see [cascades](#cascades)); and nothing in Warden restores a deleted row. So deleting has to be turned on table by table:

1. The table allows it: `tables.<table>.allowDelete: true`, or `defaults.delete: granted` (and the table doesn't set `allowDelete: false`).
2. A role grants `delete` on that table by name (`orders: [delete]`). `*` can't grant `delete`.
3. The table's `deny` doesn't include `delete`. It beats `allowDelete`.

Otherwise a delete gets the same 403 as any other denied write, and the UI shows no delete control. At startup Warden warns about every `delete` grant it ignores, naming the key to add, and about every table some role (or [custom action](#actions)) may delete from whose rows other tables reference with `on delete cascade`, `set null` or `set default`, naming those tables and any reached further down a chain of `on delete cascade` keys. Foreign keys from tables outside [`schemas`](#schemas) aren't introspected, so they aren't named.

```yaml
tables:
  users:
    allowDelete: true
    requireReason: [delete]
roles:
  admin:
    grants:
      '*': [read, create, update]
      users: [delete] # only users; nobody may delete other tables
```

> **Upgrading:** before this setting existed, a `delete` grant allowed hard deletes on its own. A `*: [delete]` grant now fails startup, and a table-named `delete` grant does nothing until the table sets `allowDelete: true` (or you set `defaults.delete: granted`). The startup warnings list each ignored grant.

## `tables`

Each key is a table, as `table` (in the default schema) or `schema.table`. Warden introspects ordinary and partitioned tables; individual partitions and views aren't exposed.

| Key                                    | Type                                                       | Default                                        |
| -------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| `tables.<table>.hidden`                | boolean                                                    | `false`                                        |
| `tables.<table>.label`                 | string                                                     | Humanized name (`order_items` → `Order items`) |
| `tables.<table>.displayField`          | column name                                                | See below                                      |
| `tables.<table>.defaultSort.column`    | column name                                                | See below                                      |
| `tables.<table>.defaultSort.direction` | `asc`, `desc`                                              | `asc`                                          |
| `tables.<table>.columnOrder`           | list of column names                                       | See below                                      |
| `tables.<table>.searchable`            | list of column names                                       | Visible text columns                           |
| `tables.<table>.deny`                  | list of `read`, `create`, `update`, `delete`, `export`     | None                                           |
| `tables.<table>.allowDelete`           | boolean                                                    | Per `defaults.delete`                          |
| `tables.<table>.requireReason`         | list of `create`, `update`, `delete`                       | Per `defaults.requireReason`                   |
| `tables.<table>.updatablePrimaryKey`   | boolean                                                    | `false`                                        |
| `tables.<table>.insertablePrimaryKey`  | boolean                                                    | `false`                                        |
| `tables.<table>.columns`               | map of column name to [column config](#tablestablecolumns) | None                                           |

**`hidden`** removes the table completely. It doesn't appear in the UI, the schema API, or any relation, and requesting it returns the same 404 as a table that doesn't exist. No grant can make a hidden table accessible.

**`label`** is the name shown in the UI.

**`displayField`** is the column used to represent a row elsewhere, such as foreign key links and pickers. Without it, Warden picks the first visible column named `name`, `title`, `label`, `display_name`, `username`, or `email`, then a text column with a single-column unique constraint, then the first primary key column, then the first visible column.

**`defaultSort`** is the grid's initial sort, and the order of API lists and exports that don't name one. Without it, a table with a primary key is sorted newest first by the first visible timestamp column named `created_at`, `createdAt`, `inserted_at`, or `insertedAt` (`desc`); otherwise rows are in primary key order. The primary key is always added as a final tie-breaker. Tables without a primary key have no default order.

**`columnOrder`** lists the columns the grid shows first, left to right. The rest follow in the default order: the primary key columns in key order, then the `displayField`, then the timestamp columns `created_at`, `updated_at`, `inserted_at`, and `modified_at` (and their camelCase forms), then everything else in table order. Tables without a primary key show columns in table order. It only orders columns; which ones are visible is up to the user's column picker and saved views. A column can't be listed twice.

**`searchable`** lists the columns the grid's free-text search matches against. By default that's every visible text column (`text`, `varchar`, `char`, `citext`, not arrays).

**`deny`** lists actions nobody may perform on this table, whatever their roles grant. It beats every grant, including `*`. Denying `read` blocks reading for everyone, even with `defaults.read: all`.

**`allowDelete`** turns [hard delete](#hard-delete) on (`true`) or off (`false`) for this table, overriding `defaults.delete`. It doesn't grant anything: a role still needs `delete` on the table by name. A `deny` that includes `delete` beats it, with a warning.

**`requireReason`** lists writes on this table that must say why, overriding [`defaults.requireReason`](#defaults) either way (`[]` makes reasons optional here). See [Required reasons](#required-reasons). It also covers [custom actions](#actions) whose `permissions` allow one of these writes on the table: running them needs a reason too, even if the action turns it off. It doesn't grant or deny anything: the caller still needs a role that may perform the action.

**`updatablePrimaryKey`** lets updates change the table's primary key columns. By default key columns without a default must be set when creating a row but are read-only afterwards: an update that sends one is rejected with `is read-only`, and the edit form shows them read-only. Changing a key gives the row a new record id, so its links stop working and its [audit history](#audit-log) splits between the old id and the new one, and an `on update cascade` foreign key changes rows in other tables (see [cascades](#cascades)). Set it only for tables with natural keys that really do change. Columns that are read-only anyway (`readOnly`, identity `GENERATED ALWAYS`, generated, or a key with a default without `insertablePrimaryKey`) stay read-only.

**`insertablePrimaryKey`** lets creates set primary key columns that have a default: a `serial` or other sequence, identity `GENERATED BY DEFAULT`, or a default expression such as `gen_random_uuid()`. By default those columns are read-only, on create as well as on update, and the database generates them. In a composite key, only sequence and identity columns count: a column with a plain default, such as `created_at default now()` in a partitioned table's key, is settable on create like a key without a default. An explicit value doesn't advance the sequence, so later inserts, whether by Warden or by your application, fail with a unique violation each time the sequence reaches a key someone inserted by hand. Set it only for tables whose keys are meant to be chosen, or whose default is only a fallback. With it, these columns behave like keys without a default: settable on create, and changeable on update only with `updatablePrimaryKey`.

A column hidden in the same table can't be the `displayField`, the `defaultSort` column, in `columnOrder`, or `searchable`. That fails startup. A column that doesn't exist, or is hidden by `defaults.newColumns: hidden`, is dropped from these settings with a warning.

```yaml
tables:
  orders:
    label: Customer orders
    displayField: number
    defaultSort: { column: placed_at, direction: desc }
    columnOrder: [number, status]
    searchable: [number, notes]
    deny: [create, delete]
    requireReason: [update]
  currencies:
    updatablePrimaryKey: true # the code is the key, and corrections are allowed
  tags:
    insertablePrimaryKey: true # the uuid default is a fallback; imports keep their ids
  internal_jobs:
    hidden: true
```

## `tables.<table>.columns`

Each key is a column name in that table.

| Key                                          | Type               | Default                                                  |
| -------------------------------------------- | ------------------ | -------------------------------------------------------- |
| `tables.<table>.columns.<column>.hidden`     | boolean            | Per `defaults.newColumns` if no entry, otherwise `false` |
| `tables.<table>.columns.<column>.readOnly`   | boolean            | Per `defaults.newColumns` if no entry, otherwise `false` |
| `tables.<table>.columns.<column>.label`      | string             | Humanized name (`created_at` → `Created at`)             |
| `tables.<table>.columns.<column>.readableBy` | list of role names | Everyone who can read the table                          |
| `tables.<table>.columns.<column>.writableBy` | list of role names | Everyone who can write the table                         |

**`hidden`** removes the column completely. It's never selected from the database, never returned by the API, never sent to the UI, and never accepted as input. Filtering or sorting on it fails exactly as for a column that doesn't exist. Foreign keys through a hidden column don't produce relations. Primary key columns can't be hidden, because rows are addressed by them: Warden warns and keeps them visible.

**`readOnly`** shows the column but never accepts writes to it. Identity (`GENERATED ALWAYS`) and generated columns are always read-only, and so are primary key columns with a default unless the table sets [`insertablePrimaryKey`](#tables).

**`label`** is the name shown in the UI.

```yaml
tables:
  users:
    columns:
      password_hash: { hidden: true }
      created_at: { readOnly: true, label: Joined }
```

### Field-level rules

**`readableBy`** limits who can see the column. To a user holding none of the listed roles, the column is hidden in the same way as `hidden`: it isn't selected, returned, shown, or accepted as input, filtering or sorting on it fails exactly as for a column that doesn't exist, it's left out of search, and foreign keys through it don't produce relations. If it is the table's `displayField` or `defaultSort` column, that user gets the primary key and the order described under [`defaultSort`](#tables) instead, and it's left out of that user's `columnOrder`. Primary key columns are always readable: Warden warns and ignores `readableBy` on them.

**`writableBy`** limits who can change the column. Everyone else who can read it sees it as read-only, and writes to it are rejected with `is read-only`.

Both apply on top of the table's actions, not instead of them: `writableBy` doesn't let a role update a table it has no `update` grant for. A user with several roles may read or write the column if any of them is listed. Every role in `writableBy` must also be in `readableBy` when both are set, `hidden` columns can't have `readableBy`, and `readOnly` columns can't have `writableBy`.

```yaml
roles:
  admin: { grants: { '*': [read, create, update] } }
  hr: { grants: { users: [read, update] } }
  support: { grants: { users: [read, update] } }
tables:
  users:
    columns:
      role: { writableBy: [admin] } # everyone sees it, only admin changes it
      salary: { readableBy: [hr, admin], writableBy: [hr] }
```

Here `support` can update users but sees `role` as read-only and doesn't see `salary` at all. `admin` sees `salary` but can't change it.

Version tokens are computed from the fields each user can see, so a change to a field someone can't see doesn't make their edit a conflict. Audit entries always record every exposed field.

## `roles`

Roles grant actions on tables. Create, update, and delete are denied unless a role grants them, delete also needs [hard delete](#hard-delete) turned on for the table, and reading follows [`defaults.read`](#defaults).

| Key                           | Type                                                   | Default |
| ----------------------------- | ------------------------------------------------------ | ------- |
| `roles.<role>.grants.<table>` | list of `read`, `create`, `update`, `delete`, `export` | None    |
| `roles.<role>.admin`          | list of `schema`, `audit`, `roles`, `views`            | None    |
| `roles.<role>.actions`        | list of [custom action](#actions) names, or `*`        | None    |

Each grant key is a table (`users`, `billing.invoices`) or `*` for every exposed table. A user with several roles gets every action any of them grants. A role name that isn't defined here grants nothing.

How a request is decided:

1. A table that is hidden or doesn't exist is denied every action.
2. An action in the table's `deny` is denied.
3. `read` is allowed when `defaults.read` is `all`.
4. `export` is denied unless the user may also `read` the table.
5. `delete` is denied unless [hard delete](#hard-delete) is on for the table.
6. Otherwise the action is allowed only if one of the user's roles grants it on that table or on `*`. `*` can't grant `delete`; config that tries fails startup.

A table the user may do nothing with is hidden from them in the same way as a `hidden` table: it isn't in their sidebar or schema, relations to it are left out, and every request for it gets the same 404 as a table that doesn't exist. A table they may write but not read (for example, a role granted only `create`) stays visible so they can fill in its form: they see its columns, and reading its rows is refused with a 403. A write's response then carries only the new or changed record's id, not its values.

**`export`** lets a role download a table's grid as CSV (see [CSV export](#csv-export)). `defaults.read: all` doesn't grant it, so nobody can export until a role is granted `export`.

A grant naming a table that isn't exposed has no effect and produces a warning.

```yaml
roles:
  viewer:
    grants:
      '*': [read]
  ops:
    grants:
      users: [read, update]
      companies: [read, create, update]
tables:
  orders:
    deny: [create, delete] # nobody, regardless of role
```

Here `ops` may update users and create or update companies. Nobody may create or delete orders, even a role granted `orders: [create, delete]` with `allowDelete: true` on orders.

**`admin`** lists the Warden administration areas the role may use:

- `schema`: the [schema drift](#schema-drift) page. It names every table and column in the database, including ones config hides, so give it only to people who may see the whole schema.
- `audit`: the [audit log](#audit-log) page, which searches every change made through Warden.
- `roles`: the [roles page](#role-assignments), where admins assign roles to people. Someone who can assign roles can give anyone, themselves included, any role config defines, so treat it like the most powerful role you have.
- `views`: sharing [saved views](#saved-views) with everyone, and editing or deleting any shared view.

**`actions`** lists the [custom actions](#actions) the role may run, or `*` for all of them.

Users get roles from [`access`](#access) when they sign in, plus any [assigned in the app](#role-assignments). The API enforces every rule; the UI only hides controls a user can't use. To restrict individual columns by role, see [field-level rules](#field-level-rules).

## `actions`

Custom actions are multi-step operations, written in code, that run in one transaction with one audit entry linking every row they change: for example, "move this user to another company and cancel their pending orders". A deployment defines them in a JavaScript or TypeScript module and points `WARDEN_ACTIONS` at it; see [Custom actions](actions.md) for writing one. Config decides who may run them, and can override a few of their settings:

| Key                              | Type    | Default                                              |
| -------------------------------- | ------- | ---------------------------------------------------- |
| `actions.<action>.disabled`      | boolean | `false`                                              |
| `actions.<action>.requireReason` | boolean | The action's own setting, which is by default `true` |
| `actions.<action>.label`         | string  | The action's own label                               |

Action names are those the action module gives (`^[a-z][a-z0-9-]*$`), except `create`, `update`, `delete`, `export`, `assign`, `unassign` and `acknowledge`, which the audit log uses for Warden's own entries. Naming one of those here or in a role's `actions` fails startup.

Running an action is a write, so it is denied unless a role lists it in [`roles.<role>.actions`](#roles). A user may run an action when all of these hold:

1. It loaded, isn't `disabled` here, and wasn't disabled by a warning at startup (below).
2. One of the user's roles lists it, or lists `*`.
3. No table `deny` covers anything in its `permissions` (the writes its code declares it may make), and [hard delete](#hard-delete) is on for every table it may `delete` from.
4. The user may `read` the action's table, and every table its form picks records from.

The user does **not** need the table grants for what the action writes. Granting an action is a deliberate, narrow escalation: `ops` may "move a user and cancel their pending orders" without being able to update arbitrary orders. A table `deny` still beats it, as it beats every grant. To everyone else an action doesn't exist: it isn't listed, and its routes give the same 404 as a nonexistent one.

```yaml
roles:
  ops:
    grants:
      users: [read]
    actions: [move-user, refund-order]
  admin:
    actions: ['*']

actions:
  refund-order:
    requireReason: true # running it must say why, even if the action turns it off
  legacy-cleanup:
    disabled: true
```

**`requireReason`** overrides the action's own setting either way. Actions require a reason by default; see [Required reasons](#required-reasons).

Mismatches warn rather than fail, as for tables and columns: an action whose table, written tables, or picked tables are hidden or don't exist, or whose `permissions` include a write a table `deny` forbids, a table that denies `read`, or `delete` on a table where hard delete is off, is disabled with a warning; and `roles.<role>.actions` or `actions` naming an action the module doesn't define is a warning. Mistakes in the module itself (a missing file, duplicate names, unsupported input fields) fail startup with an `ActionsError`.

## `access`

Decides who may sign in and which [roles](#roles) they get, from the claims in the IdP's ID token.

| Key                            | Type               | Default  |
| ------------------------------ | ------------------ | -------- |
| `access.groupsClaim`           | string             | `groups` |
| `access.groups.<group>`        | list of role names | None     |
| `access.emailDomains.<domain>` | list of role names | None     |
| `access.requireVerifiedEmail`  | boolean            | `true`   |
| `access.allowAll`              | boolean            | `false`  |

**`access` is required.** Without it, Warden fails to start with a `ConfigError`. Otherwise anyone your IdP authenticates (anyone with a Google account, if the issuer is Google) could sign in and read the database.

A user gets every role of every rule they match, and a user who matches no rule (and has no [role assignment](#role-assignments)) is denied. The login fails with `/login?error=access_denied`, and no session is created.

- **`allowAll`** lets in everyone the IdP authenticates. Users who match no rule sign in with no roles: they can read per [`defaults.read`](#defaults) and write nothing. Use it only when the IdP itself restricts who can sign in (for example, you assigned the Warden app to specific users or groups), never with a public or multi-tenant issuer. Warden logs a warning at startup while it is on. Rules still apply alongside it, giving roles to the users they match.

- **`groups`** maps an IdP group to roles. It matches when the group is in the ID token claim named by **`groupsClaim`** (a list of strings, or a single string). Group names match exactly and are case-sensitive. Most IdPs only send groups when asked, so add the right scope to `OIDC_SCOPES` (often `groups`) or configure the claim at the IdP. Entra ID sends group object IDs, not names; Keycloak may prefix groups with `/`.
- **`emailDomains`** maps an email domain to roles, a default for everyone at that domain. It matches the part of the `email` claim after the last `@`, case-insensitively, and only that exact domain: `example.com` doesn't match `eu.example.com`. Domains must be ASCII; write internationalized domains in their punycode form (`xn--...`). See [non-ASCII emails](#non-ascii-emails).
- **`requireVerifiedEmail`**: `emailDomains` only match when the ID token has `email_verified: true`. Otherwise anyone who can set their own email at the IdP could claim a domain. It also decides whether Warden records the user's email at all: without a verified one, their sessions, audit entries, and the roles page identify them only by OIDC subject, so nobody can act under someone else's address. Set it to `false` only for an IdP that never sends `email_verified` and doesn't let users change their email address. It doesn't affect `groups`. Changing it takes effect for existing sessions at the next restart, which recomputes their stored emails; audit entries already written keep the email they recorded. Entries written by builds before v1.0.0-rc.1, which didn't check `email_verified`, may carry an unverified actor email, and nothing marks them.

Every role named here must be defined under `roles`, and a domain may only be listed once; otherwise startup fails.

Roles are resolved again from the stored claims on every request, so restarting Warden with stricter rules applies to existing sessions too. Claims themselves are only refreshed at sign-in, so a change at the IdP (for example, removing a user from a group) takes effect the next time they sign in, or when an admin [signs them out everywhere](#role-assignments). Until then they keep that group's roles, at most until their session expires.

```yaml
roles:
  viewer: {}
  ops:
    grants:
      users: [read, update]
access:
  groups:
    warden-ops: [ops]
  emailDomains:
    example.com: [viewer] # everyone at example.com can sign in and read
```

If your IdP already decides who may use Warden, opt in to letting all of them in explicitly:

```yaml
access:
  allowAll: true
```

## `audit`

Where the [audit log](#audit-log) is written. By default (`audit.store: warden`) it is `warden.audit_log`. With `audit.store: table`, every entry goes to a table you own instead: creates, updates, and deletes, custom actions and the rows they change, exports, role assignments, session revocations, and schema drift acknowledgements. Each entry is still inserted in the same transaction as the change, so a change whose entry can't be written is rolled back. History and the audit log page read from the same table.

| Key                   | Default   | Description                                                                                                                              |
| --------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `audit.store`         | `warden`  | `warden`: `warden.audit_log`. `table`: the table named by `audit.table`.                                                                 |
| `audit.table`         |           | `table` (in the first of `schemas`) or `schema.table`. Required with `store: table`. Its schema needn't be one Warden exposes.           |
| `audit.columns`       | see below | The column each field is written to. Leave it out to use [`warden.audit_log`'s column names](database.md#the-audit-log) for every field. |
| `audit.source.column` |           | A text column that tells Warden's entries apart, in a table that also holds your application's own.                                      |
| `audit.source.value`  |           | What Warden writes in `audit.source.column`, such as `warden`.                                                                           |

```yaml
audit:
  store: table
  table: public.change_log
  columns: # Warden field: your column
    id: id
    occurredAt: created_at
    actorSubject: actor_sub
    actorEmail: actor_email
    action: action
    entity: table_name
    recordId: record_id
    before: old_values
    after: new_values
    diff: diff
    details: details
    reason: reason
  source: { column: source, value: warden }
```

With `audit.columns`, only the fields listed are written; the others are dropped. The first eight below are required, since History and the audit log need them to show each user only what they may see. Each column must have a compatible type, and a field Warden sometimes leaves empty needs a nullable column. Text columns can't have a length limit (`varchar`, not `varchar(n)`), since a long value would make the write fail:

| Field                        | Column type                                            | Holds                                                                                                   |
| ---------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `audit.columns.id`           | `int2`/`int4`/`int8` with identity or sequence default | Required. Increasing entry id; Warden never writes it. Pages and parent links use it.                   |
| `audit.columns.occurredAt`   | `timestamptz` or `timestamp`                           | Required. The write's transaction start (`now()`); a `timestamp` holds it in the session's time zone.   |
| `audit.columns.actorSubject` | `text`/`varchar`                                       | Required. OIDC subject of the user.                                                                     |
| `audit.columns.action`       | `text`/`varchar`                                       | Required. `create`, `update`, `delete`, `export`, a custom action's name, ...                           |
| `audit.columns.entity`       | `text`/`varchar`                                       | Required. Entity key.                                                                                   |
| `audit.columns.recordId`     | `text`/`varchar`, nullable                             | Required. The API's record id; History finds a record's entries by it.                                  |
| `audit.columns.diff`         | `json`/`jsonb`, nullable                               | Required. `{ field: { from, to } }`.                                                                    |
| `audit.columns.details`      | `json`/`jsonb`, nullable                               | Required. What exports and custom actions did.                                                          |
| `audit.columns.requestId`    | `text`/`varchar`, nullable                             | The request's id.                                                                                       |
| `audit.columns.actorEmail`   | `text`/`varchar`, nullable                             | The user's verified email.                                                                              |
| `audit.columns.actorRoles`   | `text[]`                                               | Their Warden roles. Unmapped, History and the audit log don't show roles.                               |
| `audit.columns.primaryKey`   | `json`/`jsonb`, nullable                               | The row's primary key columns.                                                                          |
| `audit.columns.before`       | `json`/`jsonb`, nullable                               | The row before the change.                                                                              |
| `audit.columns.after`        | `json`/`jsonb`, nullable                               | The row after the change.                                                                               |
| `audit.columns.reason`       | `text`/`varchar`, nullable                             | The reason given. Unmapped, reasons (even required ones) are not kept.                                  |
| `audit.columns.written`      | `text[]`, nullable                                     | The fields an update set. Unmapped, an update's reason is shown only to readers of every changed field. |
| `audit.columns.parentId`     | the id's type, nullable                                | A custom action's entry, on the rows it changed. Unmapped, those rows aren't linked to the action.      |

Warden checks the table against this at startup. A missing table or column, an incompatible type, a not-null column Warden leaves empty, or a not-null column without a default that isn't mapped, is logged as a warning like any other config that doesn't match the database, and Warden still starts, but every audited change (writes, actions, exports, role and session changes) is refused with a `503` until it is fixed, and History and the audit log can't be read. Everything else keeps working.

The audit table is never exposed, whatever the rest of the config says: it has no grid, record page, or export, and nobody can write it through Warden. Configuring it under `tables` or granting anything on it is a config error. Entries your application writes to the same table are shown in History and the audit log as well as they can be (they need Warden's entity key and record id to appear in a record's History), with their `audit.source.column` value; the audit log page can filter on it. See [database.md](database.md#writing-the-audit-log-to-your-own-table) for the DDL, an ORM entity, and grants.

## Role assignments

Config is the source of truth for which roles exist and what they grant. On top of the roles [`access`](#access) gives people, users with a role that has `admin: [roles]` can open **Roles** in the sidebar to assign extra roles to individual people by email. The page also shows the roles and access rules from config, read-only.

- An assignment matches the user's `email` claim case-insensitively, and only when the IdP says it is verified (`email_verified: true`), unless [`access.requireVerifiedEmail`](#access) is `false`.
- Assignments are for ASCII email addresses only; the page refuses any other with a 400. To remove an assignment stored before that rule, send its email exactly as listed.
- An assignment counts as an access rule: a user who matches no rule in `access` can sign in if they have one.
- Only roles defined under `roles` can be assigned. If a role is later removed from config, its assignments stop having any effect (the page marks them "Not in config") and come back if the role does.
- Roles are resolved on every request, so assigning or removing a role applies to existing sessions immediately.
- An assignment belongs to the email address, not the person. Whoever holds that address at the IdP gets the role: a mailbox reassigned to a new hire inherits it, and a typo (`bob@corp.co`) gives it to whoever owns that address. Remove assignments when people leave, and check addresses before assigning.
- When no `groups` or `emailDomains` rule grants a role with `admin: [roles]`, the last assignment of such a role can't be removed (`409`), not even by its holder, since that would lock everyone out of the page until someone edited config or the database. Assign one to someone else first, or grant one through an access rule.

The page also lists who is signed in: each user with a live session, how many sessions (browsers or devices) they have, and when they were last seen. **Sign out everywhere** deletes all of that user's sessions, so their next request fails and they must sign in again, which reads their claims from the IdP afresh. Use it after removing someone from a group or disabling them at the IdP, or if a session token may have leaked. It doesn't stop them signing in again if the IdP and your access rules still let them. The API is `DELETE /api/admin/roles/sessions` with `{ "subject": "<OIDC subject>" }`; it returns `{ "revoked": <count> }`.

Each assignment and removal, and each sign-out everywhere, is recorded in the [audit log](database.md#role-assignments) and listed on the audit log page (filter by action `assign`, `unassign`, or `revoke_sessions`). Assignments are stored in the `warden` schema, so they survive restarts and config changes.

### Non-ASCII emails

Warden only matches ASCII emails, against both `emailDomains` and assignments. An email claim with any other character matches neither, even when it's verified. Such a user can still sign in through `groups` or `allowAll`, and their email is still shown and audited as the IdP sent it, so an IdP that verifies a look-alike address (`аdmin@example.com` with a Cyrillic `а`) shows it as such; trust displayed emails only as far as you trust the IdP's verification. Unicode case folding and normalization turn look-alike characters into ASCII: the Kelvin sign `K` (U+212A) lowercases to `k`, and full-width `ｋ` normalizes to `k`. Without this rule, an IdP that marks such an address verified without proving the mailbox (admin-created users, some federated logins) could hand someone another person's assignment or domain. Users with internationalized addresses need a group rule or an ASCII alias. Internationalized domains match only when the IdP sends them in punycode.

## `actor`

Maps each signed-in user to a row of your own users table, so audit entries, custom actions, and your database's triggers know which internal user made a change, not just their OIDC subject and email.

| Key                 | Type        | Default  |
| ------------------- | ----------- | -------- |
| `actor.table`       | table key   | Required |
| `actor.matchColumn` | column name | Required |
| `actor.idColumn`    | column name | Required |
| `actor.required`    | boolean     | `false`  |

```yaml
actor:
  table: users # or schema.table; the schema must be listed in `schemas`
  matchColumn: email # matched against the verified email claim
  idColumn: id
  required: false # true: deny sign-in to users with no matching row
```

- At sign-in, Warden looks for the row whose **`matchColumn`** equals the user's `email` claim, ignoring case, and takes its **`idColumn`** as text. The email must be verified, exactly as for [role assignments](#role-assignments) (unless [`access.requireVerifiedEmail`](#access) is `false`), and ASCII, as must the stored value (see [non-ASCII emails](#non-ascii-emails)). `matchColumn` must be a text column (`text`, `varchar`, `char`, or `citext`).
- No matching row, several, or a null id gives the user no id; several also log a warning. Make `matchColumn` unique to avoid that.
- The table may be [hidden](#tables): Warden still looks the user up, reading only those two columns, and the table stays absent from the API and UI. The database role Warden runs as needs `select` on both columns.
- The id is stored on the session, so it is as of sign-in: a change to the user's row, or to `actor`, applies when they next sign in. Removing or breaking the mapping stops existing sessions' ids being used at the next restart.
- With **`required: true`**, a user without an id can't sign in (`/login?error=access_denied`), and a session without one (from before the mapping was required) gets a `401`.
- A table or column that doesn't exist is a startup [warning](#errors-and-warnings), not an error: nobody gets an id, and with `required: true` nobody can sign in.

The id is recorded as `actor_user_id` on every [audit log](database.md#the-audit-log) entry the user makes (writes, custom actions, exports, role assignments, and sign-outs everywhere), shown next to them in History and on the audit log page, where the actor search also matches it exactly. It is passed to custom actions as [`actor.userId`](actions.md#defineaction). Inside every transaction Warden writes in (creates, updates, deletes, and custom actions), it sets these for your triggers and column defaults to read:

| Setting              | Value                                            |
| -------------------- | ------------------------------------------------ |
| `warden.actor_id`    | The user's id from `actor`, or empty without one |
| `warden.actor_sub`   | Their OIDC subject                               |
| `warden.actor_email` | Their verified email, or empty without one       |

They are local to the transaction (`set_config(..., true)`). Read them with `nullif(current_setting('warden.actor_id', true), '')`, which is null outside a Warden write, including for writes your application makes:

```sql
create function stamp_updated_by() returns trigger language plpgsql as $$
begin
  new.updated_by := nullif(current_setting('warden.actor_id', true), '');
  return new;
end;
$$;
create trigger users_updated_by before update on users
  for each row execute function stamp_updated_by();
```

## Schema drift

Warden keeps a baseline snapshot of the database schema in the `warden` schema. The first start records it. Users with a role that has `admin: [schema]` can open **Schema drift** in the sidebar, which lists:

- tables and columns added since the baseline that config doesn't mention, with how Warden currently treats them (exposed or not, and visible, hidden, or read-only per [`defaults.newColumns`](#defaults)),
- tables and columns removed since the baseline,
- config entries that name tables or columns that no longer exist (the same mismatches startup logs as [warnings](#errors-and-warnings)).

The page also shows a YAML snippet for the new tables and columns. It writes down the current treatment, so pasting it into `tables` changes nothing until you edit it, for example from `hidden: false` to `hidden: true`. Merge it with any entries you already have for those tables. Config entries for missing objects have to be removed by hand.

The page reflects the schema as of Warden's last start. **Acknowledge** makes that schema the new baseline and records the change in the [audit log](database.md#the-audit-log).

## Audit log

Every create, update, and delete made through Warden is recorded in the [audit log](database.md#the-audit-log), with the reason given for it (the **Internal note** in the UI). It is `warden.audit_log` unless [`audit`](#audit) points it at a table you own. Reasons are required by default; see [Required reasons](#required-reasons). Entries are shown in two places:

- **History** on a record lists its changes, newest first, with who made each one (email and OIDC subject, plus their [`actor`](#actor) user id), why, and the before and after values. Anyone who may read the record sees it. The roles the author held are shown only to users with `admin: [audit]`, so reading a record doesn't tell everyone who holds `admin` or `hr`.
- **Audit log** in the sidebar searches every entry by actor (email or subject), entity, action, and date range. Only users with a role that has `admin: [audit]` can open it. Besides changes to tables, it lists [role assignments](#role-assignments) and removals (`assign`, `unassign`: who gave or removed which role from whom) and sign-outs everywhere (`revoke_sessions`: whose sessions, and how many). These are shown in full, and only here: they belong to no table, so no record's History includes them.

A [custom action](#actions) records one entry for the run, with its name, input (sensitive fields redacted), target records and reason, and an entry for every row it changed that links back to it. A record's History shows those as part of the action; on the audit log page, an action's entry links to the rows it changed. The rows it changed are shown like any other change, field by field. The action's own entry is different: its input isn't made of the record's fields and may hold anything, so a record's History shows it only to users who could run the action now, and to users with `admin: [audit]`. Everyone else sees neither that entry nor the action's name: rows it changed lose their link to it. Input fields that pick records of a table the user can't read are left out for everyone.

Both show an entry only for entities the user may read now, and only the fields they may read now: columns since hidden by config or restricted by a [field-level rule](#field-level-rules) are left out. An update is listed only if it changed a field the user can read that the request itself set; columns the database changed on its own, such as an `updated_at` maintained by a trigger, don't count. So an update to a salary only HR can read, with its reason, doesn't appear for anyone else at all. Creates and deletes are always listed, with their reason, since anyone who can read the table can see a row appear or go. Older updates, recorded before Warden tracked which fields a request set, can't tell the two apart: they are listed if any readable field changed, but their reason is shown only to users who can read every changed field. Schema drift acknowledgements are recorded in the log but not shown. [Exports](#csv-export) are listed with what they included.

Entry ids are sequential across the whole log, and a page's cursor is the last entry's id, so the gaps between the ids someone can see roughly show how much was recorded that they can't, such as how busy a hidden table is. Saved view ids are sequential in the same way. Only the volume shows, never what changed, and Warden accepts this rather than make ids opaque.

### Cascades

Foreign keys with `on delete cascade`, `on delete set null`/`set default`, or `on update cascade` (and triggers) change rows in other tables inside the database, as part of the statement Warden runs. Warden doesn't see those changes, so they bypass its policy and its audit log:

- They happen whatever roles the user holds on the other table, including when it is [hidden](#tables), carries a `deny`, or has [field-level rules](#field-level-rules). A user allowed to delete a company also deletes its orders under `on delete cascade`, even with no `delete` grant on orders.
- Only the row Warden was asked to change gets an audit entry. The rows changed by the cascade don't.

Primary keys are read-only on update by default (see [`updatablePrimaryKey`](#tables)), so `on update cascade` only comes into play on tables that opt in. Likewise, deletes only happen on tables that turn on [hard delete](#hard-delete), and Warden warns at startup about the cascading foreign keys into those tables. For deletes, prefer `on delete restrict` (or `no action`) on foreign keys into tables Warden writes, so that removing dependent rows is a separate, checked, and audited delete; or deny `delete` on the parent table. Where a cascade is intended, make sure everyone allowed to delete the parent may remove its children too.

## Saved views

Everyone who can read a table can save its grid's filters, search, sort, and visible columns as a named view, from **Views** above the grid. A view is private to whoever saved it unless they share it. Sharing needs a role with `admin: [views]`; a shared view appears for everyone who can read the table, and anyone with `admin: [views]` may edit or delete it.

Each view has a link, `/entities/<table>?view=<id>`, that opens the grid with the view applied. It always applies the view's current state, so editing a shared view updates everyone's link. The grid's own URL already carries its state, so copying the address bar shares the grid as it is, without saving a view.

Views follow the same rules as everything else. A view can only use columns its author can see. A shared view that uses a column someone can't see (because of [`readableBy`](#field-level-rules), or because the column was hidden or dropped since) doesn't appear for them at all. Its owner, and anyone who may delete it, see it marked as out of date so they can fix or delete it. The exception is a column hidden from someone by `readableBy`: then only the view's owner sees it, since even its name could describe that column, and anyone with `admin: [views]` who can't read the column can't see or delete it.

Views are stored in [`warden.saved_views`](database.md#saved-views).

## CSV export

Users with the [`export`](#roles) action on a table see **Export CSV** above its grid. It downloads every row that matches the grid's current filter and search, in its current sort, with its visible columns. Paging doesn't apply.

- **Fields:** only columns the user can read. Hidden columns and columns a [field-level rule](#field-level-rules) keeps from them are never included, and naming one in the export request fails exactly as for a column that doesn't exist.
- **Audit:** every export writes an `export` entry to the [audit log](#audit-log) before the first row is sent, with the row count, columns, filter, search, and sort. If the entry can't be written, nothing is exported. On the audit log page, a reader who can't see some of those columns sees them left out, and the filter or sort too if it names one. The search is left out if any column it matched against is one they can't see, and the row count whenever the filter or search is, since it says how many rows matched.
- **Size:** an export may have at most 100,000 rows. A larger one is refused with a message to narrow the filter, rather than cut short.
- **Format:** UTF-8 with a byte order mark (so Excel reads it correctly), comma-separated, CRLF line endings, a header row of column names, empty cells for nulls, and JSON for `json`/`jsonb` and array values. Text that a spreadsheet would run as a formula (starting with `=`, `+`, `-`, `@`, `|`, `;`, their full-width forms, tab, or carriage return, including after leading whitespace) is prefixed with `'`. Numbers and dates are written as is.
- **Consistency:** the count and the rows come from one snapshot of the database, so concurrent writes don't make the file disagree with the audit entry.
- **Limits:** each server runs at most 4 exports at once, and at most 2 per user; more get a `429` until one finishes. An export whose download stops reading for 30 seconds, or that is still running after 15 minutes, is ended and the download fails. See [timeouts and exports](database.md#timeouts-exports-and-actions) to change these.

```yaml
roles:
  analyst:
    grants:
      '*': [read, export]
tables:
  users:
    deny: [export] # nobody exports users, whatever their role
```

## Full example

```yaml
schemas: [public, billing]

defaults:
  expose: all
  newColumns: visible
  read: all
  delete: none
  requireReason: [create, update, delete]
  reasonMinLength: 10

tables:
  users:
    label: People
    displayField: email
    defaultSort: { column: created_at, direction: desc }
    searchable: [email, full_name]
    columns:
      password_hash: { hidden: true }
      created_at: { readOnly: true, label: Joined }
      role: { writableBy: [ops] }
    allowDelete: true
    requireReason: [delete]

  orders:
    defaultSort: { column: placed_at, direction: desc }
    deny: [create, delete]
    columns:
      placed_at: { readOnly: true }

  billing.invoices:
    columns:
      stripe_customer_id: { hidden: true }
      notes: { readableBy: [finance] }

  schema_migrations:
    hidden: true

roles:
  viewer:
    grants:
      '*': [read]
  ops:
    grants:
      users: [read, update, delete]
      companies: [read, create, update]
      orders: [update]
    actions: [move-user]
  dba:
    admin: [schema, audit, views]
  finance:
    grants:
      billing.invoices: [read, update]

actions:
  move-user:
    requireReason: true

access:
  groupsClaim: groups
  groups:
    warden-ops: [ops]
    warden-dba: [dba]
    warden-finance: [finance]
  emailDomains:
    example.com: [viewer]

actor:
  table: staff
  matchColumn: email
  idColumn: id
```

[`examples/basic/warden.config.yaml`](../examples/basic/warden.config.yaml) is the config used by `docker compose` and the tests.
