# Configuration reference

Warden works with no config at all: it introspects the database and exposes every table and column, readable by everyone who can sign in and writable by nobody. A config file only narrows and customizes that. It hides tables and columns, locks fields read-only, adjusts labels and defaults, and grants write actions to roles.

- [Loading the config](#loading-the-config)
- [Errors and warnings](#errors-and-warnings)
- [`schemas`](#schemas)
- [`defaults`](#defaults)
- [`tables`](#tables)
- [`tables.<table>.columns`](#tablestablecolumns)
- [`roles`](#roles)
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
| `tables.<table>.columns`               | map of column name to [column config](#tablestablecolumns) | None                                           |

**`hidden`** removes the table completely. It doesn't appear in the UI, the schema API, or any relation, and requesting it returns the same 404 as a table that doesn't exist. No grant can make a hidden table accessible.

**`label`** is the name shown in the UI.

**`displayField`** is the column used to represent a row elsewhere, such as foreign key links and pickers. Without it, Warden picks the first visible column named `name`, `title`, `label`, `display_name`, `username`, or `email`, then a text column with a single-column unique constraint, then the first primary key column, then the first visible column.

**`defaultSort`** is the grid's initial sort.

**`searchable`** lists the columns the grid's free-text search matches against. By default that's every visible text column (`text`, `varchar`, `char`, `citext`, not arrays).

**`deny`** lists actions nobody may perform on this table, whatever their roles grant. It beats every grant, including `*`. Denying `read` blocks reading for everyone, even with `defaults.read: all`.

A column hidden in the same table can't be the `displayField`, the `defaultSort` column, or `searchable`. That fails startup. A column that doesn't exist, or is hidden by `defaults.newColumns: hidden`, is dropped from these settings with a warning.

```yaml
tables:
  orders:
    label: Customer orders
    displayField: number
    defaultSort: { column: placed_at, direction: desc }
    searchable: [number, notes]
    deny: [create, delete]
  internal_jobs:
    hidden: true
```

## `tables.<table>.columns`

Each key is a column name in that table.

| Key                                        | Type    | Default                                                  |
| ------------------------------------------ | ------- | -------------------------------------------------------- |
| `tables.<table>.columns.<column>.hidden`   | boolean | Per `defaults.newColumns` if no entry, otherwise `false` |
| `tables.<table>.columns.<column>.readOnly` | boolean | Per `defaults.newColumns` if no entry, otherwise `false` |
| `tables.<table>.columns.<column>.label`    | string  | Humanized name (`created_at` → `Created at`)             |

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

## `roles`

Roles grant actions on tables. Create, update, and delete are denied unless a role grants them, and reading follows [`defaults.read`](#defaults).

| Key                           | Type                                         | Default |
| ----------------------------- | -------------------------------------------- | ------- |
| `roles.<role>.grants.<table>` | list of `read`, `create`, `update`, `delete` | None    |

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

> **Status:** role assignment from SSO (email domain and IdP group claims) is tracked in [#15](https://github.com/laclemen92/warden/issues/15), and enforcement on the API in [#29](https://github.com/laclemen92/warden/issues/29). Until those land, roles are validated but not applied.

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

  orders:
    defaultSort: { column: placed_at, direction: desc }
    deny: [create, delete]
    columns:
      placed_at: { readOnly: true }

  billing.invoices:
    columns:
      stripe_customer_id: { hidden: true }

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
  finance:
    grants:
      billing.invoices: [read, update]
```

[`examples/basic/warden.config.yaml`](../examples/basic/warden.config.yaml) is the config used by `docker compose` and the tests.
