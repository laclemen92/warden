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
# warden.config.yaml (planned shape)
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
```

## Quickstart

Requires Docker.

```sh
docker compose up --build
```

This starts Postgres seeded with the example schema in [`examples/basic`](examples/basic) and Warden at http://localhost:3000. Override host ports with `POSTGRES_PORT` and `WARDEN_PORT` if 5432 or 3000 are taken.

## Development

Requires Node 22 and pnpm (`corepack enable`).

```sh
pnpm install
docker compose up -d postgres
pnpm dev          # server on :3000, web on :5173 (proxies /api to the server)
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
| `examples/basic`      | Example schema, seed data, and config used by compose/tests |
| `docker`              | Production Dockerfile                                       |

## License

[Apache-2.0](LICENSE)
