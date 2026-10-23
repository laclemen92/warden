# Warden

A config-driven, audited backoffice for your Postgres database.

Point Warden at a database and it introspects the schema and exposes every table as a filterable grid with detail views and CRUD. A `warden.config.yaml` then narrows and customizes what is exposed: hide tables or columns, lock fields read-only, and grant actions per role. Every write is recorded in an append-only audit log.

> **Status:** early development. See the [milestones](https://github.com/laclemen92/warden/milestones) for the roadmap.

## How it works

- **Runtime, not codegen.** Warden reads the live schema on startup, so schema changes never require regenerating anything. New columns are handled by a configurable drift policy.
- **Config narrows the default.** Everything is readable unless config hides it; create, update and delete are denied unless config grants them to a role, and hard delete stays off until config turns it on per table.
- **SSO only.** Employees log in through your OIDC provider (Google Workspace, Okta, Entra, Keycloak, [Auth0](docs/auth0.md)). Roles map from email domain, IdP groups, or in-app assignment.
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

To run a released image against your own database and identity provider, see [deploying Warden](docs/deployment.md).

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

| Variable                          | Required | Default                | Description                                                                                                                                                                                                                                                                                    |
| --------------------------------- | -------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WARDEN_PUBLIC_URL`               | yes      |                        | URL browsers use to reach Warden, e.g. `https://warden.example.com`. Register `<url>/auth/callback` as the redirect URI and `<url>/` as the post-logout redirect URI at your IdP.                                                                                                              |
| `OIDC_ISSUER`                     | yes      |                        | Issuer URL (discovery is fetched from `/.well-known/openid-configuration`).                                                                                                                                                                                                                    |
| `OIDC_CLIENT_ID`                  | yes      |                        | Client ID registered at the IdP.                                                                                                                                                                                                                                                               |
| `OIDC_CLIENT_SECRET`              | yes      |                        | Client secret.                                                                                                                                                                                                                                                                                 |
| `OIDC_SCOPES`                     | no       | `openid email profile` | Space-separated scopes. Add your IdP's group scope if it has one.                                                                                                                                                                                                                              |
| `OIDC_AUDIENCE`                   | no       |                        | Sent as `audience` on the authorization request, for IdPs such as Auth0 that use it. With an audience, each session keeps the API access token (and refresh token, with `offline_access` in `OIDC_SCOPES`) so Warden can call that API as the user. See below.                                 |
| `OIDC_AUTH_PARAMS`                | no       |                        | Extra authorization request parameters as `key=value&key=value`, e.g. `organization=org_123&prompt=login`. Parameters Warden sets itself (`client_id`, `redirect_uri`, `response_type`, `response_mode`, `scope`, `state`, `nonce`, `code_challenge*`, `request`, `request_uri`) fail startup. |
| `OIDC_LOGOUT_URL`                 | no       |                        | Logout URL template for IdPs without an `end_session_endpoint`, e.g. `https://TENANT.auth0.com/v2/logout?client_id={clientId}&returnTo={postLogoutRedirect}`. See below.                                                                                                                       |
| `WARDEN_SESSION_SECRET`           | yes      |                        | At least 32 characters; signs cookies. Generate with `openssl rand -base64 32`. Changing it logs everyone out.                                                                                                                                                                                 |
| `WARDEN_SESSION_IDLE_TIMEOUT`     | no       | `2h`                   | A session ends after this long without a request (`30m`, `8h`, `7d`, or seconds).                                                                                                                                                                                                              |
| `WARDEN_SESSION_ABSOLUTE_TIMEOUT` | no       | `12h`                  | A session ends this long after login, however active.                                                                                                                                                                                                                                          |

Both URLs must use https, except on `localhost`. When `WARDEN_PUBLIC_URL` is https, the session cookie is `__Host-warden_session` with `Secure`; it is always `HttpOnly` and `SameSite=Lax`. Only a hash of the session token is stored. Logging out (`POST /auth/logout`) deletes the session, and so does signing in again from the same browser, so a copy of the old cookie stops working. Admins can sign a user out of every session from the [roles page](docs/config.md#role-assignments). Request logs leave out the query string of `/auth/*` URLs and redact `code` and `state` parameters elsewhere, so authorization codes don't reach your log pipeline. Warden sends no CORS headers and refuses cross-site writes: a state-changing request whose `Sec-Fetch-Site` header isn't `same-origin` gets a 403, and a `POST` to `/api/*` must have an `application/json` body (otherwise 415), so another site, including a sibling subdomain, can't submit a form to it.

**Logging out ends the IdP session too** when the IdP supports [RP-initiated logout](https://openid.net/specs/openid-connect-rpinitiated-1_0.html), that is, when its discovery document has an `end_session_endpoint`. After deleting Warden's session, the browser goes to that endpoint with `id_token_hint`, `client_id`, and `post_logout_redirect_uri` set to `<WARDEN_PUBLIC_URL>/`, and the IdP sends it back there once it has signed the user out. Without this, the next person to click "Sign in" on a shared machine would be signed straight back in as the previous user. Register `<WARDEN_PUBLIC_URL>/` as a post-logout redirect URI at the IdP, or it will refuse the logout request (some IdPs then show an error page instead of returning to Warden). `POST /auth/logout` returns `200` with `{ "redirectTo": "<IdP logout URL>" }` in that case. With an IdP that has no `end_session_endpoint`, set `OIDC_LOGOUT_URL` to its logout URL instead: Warden fills in `{clientId}` and `{postLogoutRedirect}` (`<WARDEN_PUBLIC_URL>/`), URL-encoded, and sends the browser there. Those are the only placeholders, allowed only in the query string, and the URL must use https (except on `localhost`) and have the same origin as `OIDC_ISSUER`; otherwise startup fails. Discovery's `end_session_endpoint` wins when both exist. With neither, or with an IdP Warden can't reach, logout returns `204` and ends only Warden's session. To keep the ID token to send as the hint, Warden stores it with the session, encrypted under a key derived from the session cookie, so a copy of the database alone doesn't reveal it. It is deleted with the session and never accepted as a credential. As RP-initiated logout specifies, the hint travels in the logout URL, so it can end up in the browser's history and the IdP's access logs; it identifies the user to the IdP but doesn't authenticate anyone. `POST /auth/logout` must have a JSON body (`{}` will do), like every other Warden POST, so a cross-site form can't log users out.

**Calling an API as the signed-in user.** With an API audience (`OIDC_AUDIENCE`, or `audience` in `OIDC_AUTH_PARAMS`), the login also yields an access token for that API, and Warden keeps it with the session, encrypted under a key derived from the session cookie like the ID token. Add `offline_access` to `OIDC_SCOPES` to also get a refresh token: Warden then renews the access token when it has less than a minute left, once per session even when several requests need it at the same time. When it can't (no refresh token, or the IdP refuses it because it was revoked, expired, or the user was removed), the call fails with "Sign in again to continue". Renewing never extends Warden's own session timeouts. The tokens are deleted with the session, never sent to the browser, and never logged (`refresh_token` is redacted in request logs like `code`). Without an audience no access token is kept.

Using Auth0? See [Signing in with Auth0](docs/auth0.md) for the application settings, logout, sending roles in the ID token, and API access tokens.

Custom actions (multi-step, transactional, audited operations written in code) are loaded from the module `WARDEN_ACTIONS` points at; see [Custom actions](docs/actions.md).

Request bodies are limited to 1 MiB; larger ones get a `413`. Set `WARDEN_BODY_LIMIT` (bytes, or a size like `512kb` or `2mb`) to change it. JSON values written to `json`/`jsonb` columns may nest at most 100 levels deep.

Database timeouts and CSV export limits (how many may run at once, and when a stalled download is ended) and custom action limits are set with the `WARDEN_DB_*`, `WARDEN_EXPORT_*` and `WARDEN_ACTION_*` variables in [timeouts, exports and actions](docs/database.md#timeouts-exports-and-actions).

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

| Path                  | Purpose                                                         |
| --------------------- | --------------------------------------------------------------- |
| `apps/server`         | Fastify API server; also serves the built web UI                |
| `apps/web`            | React UI                                                        |
| `packages/core`       | Schema model types, policy engine, filter compilation           |
| `packages/config`     | `warden.config.yaml`/`.json` schema and loader                  |
| `packages/pg-adapter` | Postgres introspection and query execution                      |
| `packages/actions`    | Types and errors for writing custom actions                     |
| `packages/mock-oidc`  | Development-only OIDC provider with test users                  |
| `examples/basic`      | Example schema, seed, config, and actions used by compose/tests |
| `examples/deploy`     | Compose file, `.env.example`, and starter config for deploying  |
| `e2e`                 | Playwright end-to-end tests against the compose stack           |
| `docker`              | Production Dockerfile                                           |
| `docs`                | Configuration, database setup, deployment, and releasing        |

## License

[Apache-2.0](LICENSE)
