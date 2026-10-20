# Configuration reference

Warden works with no config at all: it introspects the database and exposes every table and column, readable by everyone who can sign in and writable by nobody. A config file only narrows and customizes that. It hides tables and columns, locks fields read-only, adjusts labels and defaults, and grants write actions to roles.

- [Loading the config](#loading-the-config)
- [Errors and warnings](#errors-and-warnings)
- [`schemas`](#schemas)
- [`defaults`](#defaults)
- [`tables`](#tables)
- [`tables.<table>.columns`](#tablestablecolumns)
- [`roles`](#roles)
- [`access`](#access)
- [Schema drift](#schema-drift)
- [Saved views](#saved-views)
- [Full example](#full-example)

## Loading the config

Warden reads one file at startup, YAML or JSON. It uses the first of:

1. The path in the `WARDEN_CONFIG` environment variable, relative to the working directory. This file must exist.
2. `warden.config.yaml`, `warden.config.yml`, or `warden.config.json` in the working directory, checked in that order.
3. No file: the built-in defaults.

In Docker, mount the file and point `WARDEN_CONFIG` at it:

```sh
docker run -v ./warden.config.yaml:/config/warden.config.yaml:ro \
  -e WARDEN_CONFIG=/config/warden.config.yaml ...
```

Config is read once. Restart Warden to apply changes.

An empty file is valid and means the same as no file. Every key below is optional.

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

The first schema is the **default schema**. Tables in it are referred to by bare name (`users`) in config, URLs, and the API. Tables in other schemas use `schema.table` (`billing.invoices`). In config, `users` and `public.users` (when `public` is the default schema) mean the same table. Configuring a table under both spellings is a warning, and only the first entry is used.

A `schema.table` key whose schema isn't listed in `schemas` fails startup.

```yaml
schemas: [public, billing]
tables:
  users: {} # public.users
  billing.invoices: {}
```

## `defaults`

| Key                   | Values                          | Default   |
| --------------------- | ------------------------------- | --------- |
| `defaults.expose`     | `all`, `none`                   | `all`     |
| `defaults.newColumns` | `visible`, `hidden`, `readOnly` | `visible` |
| `defaults.read`       | `all`, `granted`                | `all`     |

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

```yaml
defaults:
  expose: none
  newColumns: hidden
  read: granted
```

## `tables`

Each key is a table, as `table` (in the default schema) or `schema.table`. Warden introspects ordinary and partitioned tables; individual partitions and views aren't exposed.

| Key                                    | Type                                                       | Default                                        |
| -------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| `tables.<table>.hidden`                | boolean                                                    | `false`                                        |
| `tables.<table>.label`                 | string                                                     | Humanized name (`order_items` → `Order items`) |
| `tables.<table>.displayField`          | column name                                                | See below                                      |
| `tables.<table>.defaultSort.column`    | column name                                                | None                                           |
| `tables.<table>.defaultSort.direction` | `asc`, `desc`                                              | `asc`                                          |
| `tables.<table>.searchable`            | list of column names                                       | Visible text columns                           |
| `tables.<table>.deny`                  | list of `read`, `create`, `update`, `delete`               | None                                           |
| `tables.<table>.requireReason`         | list of `create`, `update`, `delete`                       | None                                           |
| `tables.<table>.columns`               | map of column name to [column config](#tablestablecolumns) | None                                           |

**`hidden`** removes the table completely. It doesn't appear in the UI, the schema API, or any relation, and requesting it returns the same 404 as a table that doesn't exist. No grant can make a hidden table accessible.

**`label`** is the name shown in the UI.

**`displayField`** is the column used to represent a row elsewhere, such as foreign key links and pickers. Without it, Warden picks the first visible column named `name`, `title`, `label`, `display_name`, `username`, or `email`, then a text column with a single-column unique constraint, then the first primary key column, then the first visible column.

**`defaultSort`** is the grid's initial sort.

**`searchable`** lists the columns the grid's free-text search matches against. By default that's every visible text column (`text`, `varchar`, `char`, `citext`, not arrays).

**`deny`** lists actions nobody may perform on this table, whatever their roles grant. It beats every grant, including `*`. Denying `read` blocks reading for everyone, even with `defaults.read: all`.

**`requireReason`** lists writes that must say why. Every write may send a `reason`, which is stored in the [audit log](#audit-log); for these actions the API rejects a write without one (or with only whitespace) with a 400, and the UI asks for it before saving or deleting. It doesn't grant or deny anything: the caller still needs a role that may perform the action.

A column hidden in the same table can't be the `displayField`, the `defaultSort` column, or `searchable`. That fails startup. A column that doesn't exist, or is hidden by `defaults.newColumns: hidden`, is dropped from these settings with a warning.

```yaml
tables:
  orders:
    label: Customer orders
    displayField: number
    defaultSort: { column: placed_at, direction: desc }
    searchable: [number, notes]
    deny: [create, delete]
    requireReason: [update]
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

**`readOnly`** shows the column but never accepts writes to it. Identity (`GENERATED ALWAYS`) and generated columns are always read-only.

**`label`** is the name shown in the UI.

```yaml
tables:
  users:
    columns:
      password_hash: { hidden: true }
      created_at: { readOnly: true, label: Joined }
```

### Field-level rules

**`readableBy`** limits who can see the column. To a user holding none of the listed roles, the column is hidden in the same way as `hidden`: it isn't selected, returned, shown, or accepted as input, filtering or sorting on it fails exactly as for a column that doesn't exist, it's left out of search, and foreign keys through it don't produce relations. If it is the table's `displayField` or `defaultSort` column, that user gets the primary key and the default order instead. Primary key columns are always readable: Warden warns and ignores `readableBy` on them.

**`writableBy`** limits who can change the column. Everyone else who can read it sees it as read-only, and writes to it are rejected with `is read-only`.

Both apply on top of the table's actions, not instead of them: `writableBy` doesn't let a role update a table it has no `update` grant for. A user with several roles may read or write the column if any of them is listed. Every role in `writableBy` must also be in `readableBy` when both are set, `hidden` columns can't have `readableBy`, and `readOnly` columns can't have `writableBy`.

```yaml
roles:
  admin: { grants: { '*': [read, create, update, delete] } }
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

Roles grant actions on tables. Create, update, and delete are denied unless a role grants them, and reading follows [`defaults.read`](#defaults).

| Key                           | Type                                         | Default |
| ----------------------------- | -------------------------------------------- | ------- |
| `roles.<role>.grants.<table>` | list of `read`, `create`, `update`, `delete` | None    |
| `roles.<role>.admin`          | list of `schema`, `audit`, `roles`           | None    |

Each grant key is a table (`users`, `billing.invoices`) or `*` for every exposed table. A user with several roles gets every action any of them grants. A role name that isn't defined here grants nothing.

How a request is decided:

1. A table that is hidden or doesn't exist is denied every action.
2. An action in the table's `deny` is denied.
3. `read` is allowed when `defaults.read` is `all`.
4. Otherwise the action is allowed only if one of the user's roles grants it on that table or on `*`.

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

Here `ops` may update users and create or update companies. Nobody may create or delete orders, even a role granted `*: [create, delete]`.

**`admin`** lists the Warden administration areas the role may use:

- `schema`: the [schema drift](#schema-drift) page. It names every table and column in the database, including ones config hides, so give it only to people who may see the whole schema.
- `audit`: the [audit log](#audit-log) page, which searches every change made through Warden.
- `roles`: the [roles page](#role-assignments), where admins assign roles to people. Someone who can assign roles can give anyone, themselves included, any role config defines, so treat it like the most powerful role you have.
- `views`: sharing [saved views](#saved-views) with everyone, and editing or deleting any shared view.

Users get roles from [`access`](#access) when they sign in, plus any [assigned in the app](#role-assignments). The API enforces every rule; the UI only hides controls a user can't use. To restrict individual columns by role, see [field-level rules](#field-level-rules).

## `access`

Decides who may sign in and which [roles](#roles) they get, from the claims in the IdP's ID token.

| Key                            | Type               | Default  |
| ------------------------------ | ------------------ | -------- |
| `access.groupsClaim`           | string             | `groups` |
| `access.groups.<group>`        | list of role names | None     |
| `access.emailDomains.<domain>` | list of role names | None     |
| `access.requireVerifiedEmail`  | boolean            | `true`   |

**Without `access`**, everyone the IdP authenticates may sign in, with no roles: they can read per [`defaults.read`](#defaults) and write nothing. Limit who can sign in at the IdP (for example, assign the Warden app to specific users or groups), or configure `access`.

**With `access`**, a user gets every role of every rule they match, and a user who matches no rule (and has no [role assignment](#role-assignments)) is denied. The login fails with `/login?error=access_denied`, and no session is created.

- **`groups`** maps an IdP group to roles. It matches when the group is in the ID token claim named by **`groupsClaim`** (a list of strings, or a single string). Group names match exactly and are case-sensitive. Most IdPs only send groups when asked, so add the right scope to `OIDC_SCOPES` (often `groups`) or configure the claim at the IdP. Entra ID sends group object IDs, not names; Keycloak may prefix groups with `/`.
- **`emailDomains`** maps an email domain to roles, a default for everyone at that domain. It matches the part of the `email` claim after the last `@`, case-insensitively, and only that exact domain: `example.com` doesn't match `eu.example.com`.
- **`requireVerifiedEmail`**: `emailDomains` only match when the ID token has `email_verified: true`. Otherwise anyone who can set their own email at the IdP could claim a domain. Set it to `false` only for an IdP that never sends `email_verified` and doesn't let users change their email address. It doesn't affect `groups`.

Every role named here must be defined under `roles`, and a domain may only be listed once; otherwise startup fails.

Roles are resolved again from the stored claims on every request, so restarting Warden with stricter rules applies to existing sessions too. Claims themselves are only refreshed at sign-in, so a user removed from a group at the IdP keeps that group's roles until their session expires.

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

## Role assignments

Config is the source of truth for which roles exist and what they grant. On top of the roles [`access`](#access) gives people, users with a role that has `admin: [roles]` can open **Roles** in the sidebar to assign extra roles to individual people by email. The page also shows the roles and access rules from config, read-only.

- An assignment matches the user's `email` claim case-insensitively, and only when the IdP says it is verified (`email_verified: true`), unless [`access.requireVerifiedEmail`](#access) is `false`.
- An assignment counts as an access rule: a user who matches no rule in `access` can sign in if they have one.
- Only roles defined under `roles` can be assigned. If a role is later removed from config, its assignments stop having any effect (the page marks them "Not in config") and come back if the role does.
- Roles are resolved on every request, so assigning or removing a role applies to existing sessions immediately.

Each assignment and removal is recorded in the [audit log](database.md#role-assignments). Assignments are stored in the `warden` schema, so they survive restarts and config changes.

## Schema drift

Warden keeps a baseline snapshot of the database schema in the `warden` schema. The first start records it. Users with a role that has `admin: [schema]` can open **Schema drift** in the sidebar, which lists:

- tables and columns added since the baseline that config doesn't mention, with how Warden currently treats them (exposed or not, and visible, hidden, or read-only per [`defaults.newColumns`](#defaults)),
- tables and columns removed since the baseline,
- config entries that name tables or columns that no longer exist (the same mismatches startup logs as [warnings](#errors-and-warnings)).

The page also shows a YAML snippet for the new tables and columns. It writes down the current treatment, so pasting it into `tables` changes nothing until you edit it, for example from `hidden: false` to `hidden: true`. Merge it with any entries you already have for those tables. Config entries for missing objects have to be removed by hand.

The page reflects the schema as of Warden's last start. **Acknowledge** makes that schema the new baseline and records the change in the [audit log](database.md#the-audit-log).

## Audit log

Every create, update, and delete made through Warden is recorded in the [audit log](database.md#the-audit-log), with the reason given for it, if any. A table's [`requireReason`](#tables) makes the reason mandatory for chosen actions. Entries are shown in two places:

- **History** on a record lists its changes, newest first, with who made each one, why, and the before and after values. Anyone who may read the record sees it.
- **Audit log** in the sidebar searches every entry by actor (email or subject), entity, action, and date range. Only users with a role that has `admin: [audit]` can open it.

Both show an entry only for entities the user may read now, and only the fields they may read now: columns since hidden by config or restricted by a [field-level rule](#field-level-rules) are left out, and an update that changed only such fields isn't listed. Schema drift acknowledgements are recorded in the log but not shown.

## Saved views

Everyone who can read a table can save its grid's filters, search, sort, and visible columns as a named view, from **Views** above the grid. A view is private to whoever saved it unless they share it. Sharing needs a role with `admin: [views]`; a shared view appears for everyone who can read the table, and anyone with `admin: [views]` may edit or delete it.

Each view has a link, `/entities/<table>?view=<id>`, that opens the grid with the view applied. It always applies the view's current state, so editing a shared view updates everyone's link. The grid's own URL already carries its state, so copying the address bar shares the grid as it is, without saving a view.

Views follow the same rules as everything else. A view can only use columns its author can see. A shared view that uses a column someone can't see (because of [`readableBy`](#field-level-rules), or because the column was hidden or dropped since) doesn't appear for them at all. Its owner, and anyone who may delete it, see it marked as out of date so they can fix or delete it.

Views are stored in [`warden.saved_views`](database.md#saved-views).

## Full example

```yaml
schemas: [public, billing]

defaults:
  expose: all
  newColumns: visible
  read: all

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
      users: [read, update]
      companies: [read, create, update]
      orders: [update]
  dba:
    admin: [schema, audit, views]
  finance:
    grants:
      billing.invoices: [read, update]

access:
  groupsClaim: groups
  groups:
    warden-ops: [ops]
    warden-dba: [dba]
    warden-finance: [finance]
  emailDomains:
    example.com: [viewer]
```

[`examples/basic/warden.config.yaml`](../examples/basic/warden.config.yaml) is the config used by `docker compose` and the tests.
