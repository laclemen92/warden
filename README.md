# Warden

A config-driven, audited backoffice for your Postgres database.

Point Warden at a database and it introspects the schema and exposes every table as a filterable grid with detail views and CRUD. A `warden.config.yaml` then narrows and customizes what is exposed: hide tables or columns, lock fields read-only, and grant actions per role. Every write is recorded in an append-only audit log.

> **Status:** early development. See the [milestones](https://github.com/laclemen92/warden/milestones) for the roadmap.

## How it works

- **Runtime, not codegen.** Warden reads the live schema on startup, so schema changes never require regenerating anything. New columns are handled by a configurable drift policy.
- **Config narrows the default.** Everything is readable unless config hides it; create, update and delete are denied unless config grants them to a role.
- **SSO only.** Employees log in through your OIDC provider (Google Workspace, Okta, Entra, Keycloak). Roles map from email domain, IdP groups, or in-app assignment.
- **Audit everything.** Each write runs in a transaction alongside an audit entry recording who, what, when, before/after, and why.
- **Self-hosted.** One Docker image. Warden's own metadata lives in a separate `warden` schema.

```yaml
# warden.config.yaml
defaults:
  expose: all
tables:
  users:
    displayField: email
    columns:
      password_hash: { hidden: true }
  orders:
    deny: [create, delete]
roles:
  viewer: { grants: { '*': [read] } }
  ops:
    grants:
      users: [read, update]
access: # who may sign in (required)
  groups:
    warden-ops: [ops]
  emailDomains:
    example.com: [viewer]
```

See the [configuration reference](docs/config.md) for every option and [database setup](docs/database.md) for migrations, database roles, and the audit log.

## Quickstart

Requires Docker.

```sh
docker compose up --build
```

This starts Postgres seeded with the example schema in [`examples/basic`](examples/basic), a mock OIDC provider at http://localhost:9400, and Warden at http://localhost:3000. Override host ports with `POSTGRES_PORT`, `OIDC_PORT` and `WARDEN_PORT` if 5432, 9400 or 3000 are taken.

The mock provider replaces a real IdP for local use: its sign-in page lists test users and needs no password. It is for development and E2E only.

| User       | Email                  | `groups` claim   |
| ---------- | ---------------------- | ---------------- |
| `viewer`   | `viewer@example.com`   | `warden-viewers` |
| `editor`   | `editor@example.com`   | `warden-editors` |
| `admin`    | `admin@example.com`    | `warden-admins`  |
| `outsider` | `outsider@example.org` | (none)           |

Client ID `warden`, secret `warden-dev-secret`, scopes `openid email profile groups`.

## Authentication

Warden signs users in with OIDC (authorization code + PKCE) and keeps server-side sessions in the `warden` schema, which it creates and migrates on startup (see [database setup](docs/database.md) to migrate separately and run Warden as a restricted role). Every `/api` route requires a session. Configure it with environment variables:

| Variable                          | Required | Default                | Description                                                                                                                          |
| --------------------------------- | -------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `WARDEN_PUBLIC_URL`               | yes      |                        | URL browsers use to reach Warden, e.g. `https://warden.example.com`. Register `<url>/auth/callback` as the redirect URI at your IdP. |
| `OIDC_ISSUER`                     | yes      |                        | Issuer URL (discovery is fetched from `/.well-known/openid-configuration`).                                                          |
| `OIDC_CLIENT_ID`                  | yes      |                        | Client ID registered at the IdP.                                                                                                     |
| `OIDC_CLIENT_SECRET`              | yes      |                        | Client secret.                                                                                                                       |
| `OIDC_SCOPES`                     | no       | `openid email profile` | Space-separated scopes. Add your IdP's group scope if it has one.                                                                    |
| `WARDEN_SESSION_SECRET`           | yes      |                        | At least 32 characters; signs cookies. Generate with `openssl rand -base64 32`. Changing it logs everyone out.                       |
| `WARDEN_SESSION_IDLE_TIMEOUT`     | no       | `2h`                   | A session ends after this long without a request (`30m`, `8h`, `7d`, or seconds).                                                    |
| `WARDEN_SESSION_ABSOLUTE_TIMEOUT` | no       | `12h`                  | A session ends this long after login, however active.                                                                                |

Both URLs must use https, except on `localhost`. When `WARDEN_PUBLIC_URL` is https, the session cookie is `__Host-warden_session` with `Secure`; it is always `HttpOnly` and `SameSite=Lax`. Only a hash of the session token is stored. Logging out (`POST /auth/logout`) deletes the session.

## Development

Requires Node 22 and pnpm (`corepack enable`).

```sh
pnpm install
docker compose up -d postgres mock-oidc
cp apps/server/.env.example apps/server/.env
pnpm dev          # server on :3000, web on :5173 (proxies /api and /auth to the server)
pnpm test
pnpm lint
pnpm typecheck
```

## Repository layout

| Path                  | Purpose                                                     |
| --------------------- | ----------------------------------------------------------- |
| `apps/server`         | Fastify API server; also serves the built web UI            |
| `apps/web`            | React UI                                                    |
| `packages/core`       | Schema model types, policy engine, filter compilation       |
| `packages/config`     | `warden.config.yaml`/`.json` schema and loader              |
| `packages/pg-adapter` | Postgres introspection and query execution                  |
| `packages/mock-oidc`  | Development-only OIDC provider with test users              |
| `examples/basic`      | Example schema, seed data, and config used by compose/tests |
| `e2e`                 | Playwright end-to-end tests against the compose stack       |
| `docker`              | Production Dockerfile                                       |
| `docs`                | Configuration reference and database setup                  |

## License

[Apache-2.0](LICENSE)
