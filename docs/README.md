# Docs

Every doc in the repository, one line each. Contributors and agents: read [architecture](architecture.md) first, then the doc for the area you are changing (see [Read before touching](#read-before-touching)).

## For people running or using Warden

| Doc                                                      | What it covers                                                                                                                                                                                                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [README](../README.md)                                   | What Warden is, the quickstart, and the sign-in environment variables (`OIDC_*`, `WARDEN_SESSION_*`, logout, API access tokens).                                                                                                                   |
| [Deploying Warden](deployment.md)                        | Running the released image against your own database and IdP, with the files in [`examples/deploy`](../examples/deploy).                                                                                                                           |
| [Signing in with Auth0](auth0.md)                        | Auth0 application settings, logout, roles in the ID token, and API access tokens.                                                                                                                                                                  |
| [Configuration reference](config.md)                     | Every key in `warden.config.yaml`: tables, columns, field rules, views, roles, access, actions, audit, actor, soft and hard delete.                                                                                                                |
| [Database setup](database.md)                            | The `warden` schema and its migrations, restricted database roles, timeouts and limits, the audit log and writing it to your table.                                                                                                                |
| [Custom actions](actions.md)                             | Writing `defineAction` modules: the `tx` API, previews, HTTP actions, multi-step HTTP actions and retries, and the actions HTTP API. [`examples/verify-warden-request.mjs`](examples/verify-warden-request.mjs) is its reference request verifier. |
| [Using Warden](using-warden.md)                          | The day-to-day user guide (search, filters, views, editing, export, actions, shortcuts). The app's **Help** page shows the same text.                                                                                                              |
| [`@wardenhq/mock-oidc`](../packages/mock-oidc/README.md) | The development-only mock identity provider and its settings.                                                                                                                                                                                      |

## For contributors

| Doc                                                                         | What it covers                                                                                                            |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [Architecture](architecture.md)                                             | How a request flows end to end, package boundaries, the `warden` schema, and where each security invariant is enforced.   |
| [CLAUDE.md](../CLAUDE.md)                                                   | Commands, layout, the core security rules, conventions, and workflow for agents and contributors.                         |
| [Contributing](../CONTRIBUTING.md)                                          | Local setup, the checks to run before a PR, the E2E suite, and reporting security issues.                                 |
| [Releasing](releasing.md)                                                   | Cutting a release by pushing a tag, what the release workflow checks and publishes, and prereleases.                      |
| [RFC 0001: `defineAction`](rfcs/0001-define-action.md)                      | The design record for custom actions: goals, alternatives, and implementation notes. [actions.md](actions.md) is current. |
| [RFC 0002: Where Warden keeps its metadata](rfcs/0002-metadata-database.md) | Decision on a separate metadata database, read-only replicas, and which database each audit entry is written to.          |

## Read before touching

| If you change…                                                                                                                                                 | Read                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| The config schema ([`packages/config/src/schema.ts`](../packages/config/src/schema.ts)), `resolveSchema`, `resolvePolicy`, config views                        | [config.md](config.md) (update it, and `examples/basic/warden.config.yaml`, in the same PR) |
| Migrations, the `warden` schema, the audit log or audit store ([`packages/pg-adapter/src/migrate.ts`](../packages/pg-adapter/src/migrate.ts), `audit.ts`)      | [database.md](database.md)                                                                  |
| `WARDEN_DB_*`, `WARDEN_EXPORT_*` or `WARDEN_ACTION_*` settings                                                                                                 | [database.md](database.md#timeouts-exports-and-actions)                                     |
| `defineAction`, the `tx` API, HTTP actions ([`packages/actions`](../packages/actions/src/index.ts), `core/actions.ts`, `routes/actions.ts`, `http-actions.ts`) | [actions.md](actions.md)                                                                    |
| Sign-in, sessions, logout, API tokens ([`apps/server/src/auth`](../apps/server/src/auth/settings.ts), `routes/auth.ts`)                                        | [README › Authentication](../README.md#authentication), [auth0.md](auth0.md)                |
| The auth guard, CSRF checks, policy hook, or anything else security-relevant                                                                                   | [architecture.md › Security invariants](architecture.md#security-invariants)                |
| The Docker image, `examples/deploy`, or environment variables                                                                                                  | [deployment.md](deployment.md)                                                              |
| The UI's behavior or the Help page ([`apps/web/src/pages/help-page.tsx`](../apps/web/src/pages/help-page.tsx))                                                 | [using-warden.md](using-warden.md) (the two are kept in step)                               |
| The release or CI workflows ([`.github/workflows`](../.github/workflows/release.yml)), `docker/`                                                               | [releasing.md](releasing.md)                                                                |
| The mock IdP ([`packages/mock-oidc`](../packages/mock-oidc/src/index.ts))                                                                                      | [its README](../packages/mock-oidc/README.md)                                               |

A change in behavior updates the doc that describes it in the same PR. A new doc gets a line here.
