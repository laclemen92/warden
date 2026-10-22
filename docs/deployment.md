# Deploying Warden

Warden is one Docker image. It needs three things: environment variables (database, sign-in, secrets), a config file, and a Postgres database it can read your tables from and keep its own `warden` schema in. [`examples/deploy`](../examples/deploy) has all three ready to fill in:

| File                                                                              | What it's for                                                                                               |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`docker-compose.yml`](../examples/deploy/docker-compose.yml)                     | Runs the image with your `.env` and config, plus an optional local Postgres. Usually needs no edits.        |
| [`.env.example`](../examples/deploy/.env.example)                                 | Every setting Warden reads from the environment. Copy it to `.env`, fill it in, and never commit it.        |
| [`warden.config.yaml`](../examples/deploy/warden.config.yaml)                     | Who can sign in, what they can do, and what's hidden. Mounted into the container read-only.                 |
| [`docker-compose.mock-oidc.yml`](../examples/deploy/docker-compose.mock-oidc.yml) | Development only: adds a mock IdP for [trying it locally](#trying-it-locally-without-an-identity-provider). |

```sh
cp -r examples/deploy ~/warden && cd ~/warden
cp .env.example .env    # then fill it in (steps below)
```

Any other way of running a container works the same way: set the environment variables, mount the config file, and point `WARDEN_CONFIG` at it. The image listens on port 3000 and runs as a non-root user.

## 1. Register Warden with your identity provider

Warden signs people in with OIDC. Create a **web application** client at your IdP with:

- **Redirect URI:** `<WARDEN_PUBLIC_URL>/auth/callback`, e.g. `http://localhost:3000/auth/callback`
- **Post-logout redirect URI:** `<WARDEN_PUBLIC_URL>/`, if your IdP has the setting

Then set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` in `.env`. Generate `WARDEN_SESSION_SECRET` with `openssl rand -base64 32`.

**Google Workspace:**

1. In the [Google Cloud console](https://console.cloud.google.com/), set the OAuth consent screen to **Internal**, so only people in your Workspace can sign in.
2. Under **Credentials → OAuth client ID**, create a **Web application** client. The issuer is `https://accounts.google.com`.
3. Google sends no `groups` claim, so grant roles by `access.emailDomains` or [role assignments](config.md#role-assignments).

**Microsoft Entra ID:**

- The issuer is `https://login.microsoftonline.com/<tenant-id>/v2.0`.
- Add the groups claim to the token if you want to map groups to roles.

`WARDEN_PUBLIC_URL` must be `https` except on `localhost`. If you change the host port with `WARDEN_PORT`, the public URL must use the same port, or the sign-in redirect lands nowhere. See [Authentication](../README.md#authentication) for every sign-in and session setting.

### Trying it locally without an identity provider

To try Warden on your machine before registering a client, run the development-only mock IdP next to it. It shows a login page with fixed test users (`viewer@`, `editor@`, and `admin@example.com`, plus `outsider@example.org`) and signs you in as any of them with no password. **Never deploy it.**

[`docker-compose.mock-oidc.yml`](../examples/deploy/docker-compose.mock-oidc.yml) adds it from its published image, `ghcr.io/laclemen92/warden-mock-oidc`, tagged with the same versions as Warden. It isn't part of the Warden image or the default `docker-compose.yml`, so it only runs when you name the file. In `.env`, set the image (same version as `WARDEN_IMAGE`) and a throwaway session secret (at least 32 characters):

```sh
MOCK_OIDC_IMAGE=ghcr.io/laclemen92/warden-mock-oidc:1.0.0-rc.1
WARDEN_SESSION_SECRET=local-only-session-secret-not-for-production
```

Grant the test users a role in `warden.config.yaml`, e.g. `access.emailDomains: { example.com: [viewer] }` (the starter config already does), then start both files together. `--profile local-db` also starts the bundled Postgres that the default `DATABASE_URL` points at (empty until you [copy a database into it](#a-copy-of-your-database-safest-way-to-try-it)). Leave it out if `DATABASE_URL` points at another database:

```sh
docker compose --profile local-db -f docker-compose.yml -f docker-compose.mock-oidc.yml up -d
```

Open http://localhost:3000 and pick a test user. Both ports are published on `127.0.0.1` only, so other machines on your network can't reach them. The file sets `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and `WARDEN_PUBLIC_URL` for Warden, overriding `.env`, so leave those as they are for when you switch to a real IdP. Use `OIDC_PORT` and `WARDEN_PORT` in `.env` if 9400 or 3000 are taken. Pass the same flags to `docker compose down`, or set `COMPOSE_FILE=docker-compose.yml:docker-compose.mock-oidc.yml` and `COMPOSE_PROFILES=local-db` in `.env` to make them the default while you try it.

Warden joins the mock IdP's network, so both containers share `localhost`. That matters because the browser and Warden must reach the IdP at the same issuer URL. To reach a database on your machine from there, use `host.docker.internal` (see [below](#reaching-the-database-from-the-container)). Pulling the image needs the same GHCR login as the Warden image (see [releasing](releasing.md#pulling-the-image)).

## 2. Choose a database

Warden reads your tables **and** writes its own `warden` schema (sessions, the audit log, role assignments, saved views) **in the same database**. It can't run against a read-only replica.

### A copy of your database (safest way to try it)

Nothing can affect production. Start the bundled Postgres and copy a database you're allowed to put there:

```sh
docker compose --profile local-db up -d --wait db
docker compose exec -e SRC='postgres://user:pass@host:5432/dbname' db \
  sh -c 'pg_dump --no-owner --no-privileges -Fc "$SRC" | pg_restore --no-owner -U warden -d app'
```

The default `DATABASE_URL` in `.env.example` points at this copy. Warden logs a warning at startup that its role owns the audit log. That's expected for a throwaway copy, and the next option avoids it.

### Your real database, with restricted roles

Warden then reads only what you grant, and can't weaken the audit log's protections. Run this as a superuser or the database owner, replacing the passwords and `public` with your schemas:

```sql
-- Owns the warden schema and runs migrations.
create role warden_owner login password 'CHANGE_ME_OWNER';
create schema warden authorization warden_owner;

-- What Warden runs as: read-only on your tables.
create role warden_app login password 'CHANGE_ME_APP';
grant usage on schema public to warden_app;
grant select on all tables in schema public to warden_app;
```

Run the migrations as the owner, then apply the [runtime grants](database.md#restricting-the-runtime-role) as `warden_owner`:

```sh
docker compose run --rm -e DATABASE_URL='postgres://warden_owner:CHANGE_ME_OWNER@host:5432/dbname' \
  warden node dist/migrate.js
```

Point Warden at the restricted role in `.env`, and turn off startup migrations:

```sh
DATABASE_URL=postgres://warden_app:CHANGE_ME_APP@host:5432/dbname
WARDEN_MIGRATE=false
```

Before each upgrade, re-run the migrations and the runtime grants. If roles may write to some tables, grant `warden_app` `insert`/`update`/`delete` on those too.

### Reaching the database from the container

`DATABASE_URL` is resolved inside the Warden container, so `localhost` there means the container itself, not your machine.

- **Postgres on your machine, or published by another compose project** (e.g. `ports: ["5455:5432"]`): use `host.docker.internal` and the published port, e.g. `postgres://user:pass@host.docker.internal:5455/dbname`. Docker Desktop provides that name; on Linux, add it to the `warden` service:

  ```yaml
  extra_hosts:
    - 'host.docker.internal:host-gateway'
  ```

- **Postgres in another compose project, by service name:** join that project's network (`docker network ls` shows it, usually `<project>_default`) and use the service name and container port, e.g. `postgres://user:pass@postgres:5432/dbname`. The other project must be running first.

  ```yaml
  services:
    warden:
      networks: [app]
  networks:
    app:
      external: true
      name: myproject_default
  ```

- **A hosted database** (RDS, Cloud SQL, …): use its hostname, and make sure its firewall or security group allows the Docker host.

Check the connection with a throwaway container before starting Warden:

```sh
docker run --rm postgres:18-alpine psql "$DATABASE_URL" -c 'select 1'
```

## 3. Write the config

The starter config lets anyone from your email domain sign in and read everything, and nobody write anything. Change `example.com` to your domain, then hide anything people shouldn't see (tokens, password hashes, personal data) before inviting them:

```yaml
tables:
  api_keys: { hidden: true }
  users:
    columns:
      password_hash: { hidden: true }
```

List other schemas under `schemas:` if your tables aren't all in `public`. Warden refuses to start on an invalid config and names the file, line, and key. It logs a warning for config that names tables or columns that don't exist, but still starts. The [configuration reference](config.md) covers roles, write grants, field rules, and more.

## 4. Start it

The image is on GHCR. The repository is private, so log in once with a token that has `read:packages`:

```sh
gh auth refresh -s read:packages
gh auth token | docker login ghcr.io -u <github-username> --password-stdin

docker compose up -d
docker compose logs -f warden    # look for "schema loaded", and read any warnings
curl localhost:3000/healthz      # {"status":"ok","version":"..."}
```

Open `WARDEN_PUBLIC_URL` and sign in. After changing `.env` or the config, run `docker compose up -d --force-recreate warden`.

## Upgrading

1. Set `WARDEN_IMAGE` to the new version or digest from its [release notes](releasing.md).
2. If you migrate separately, run the migrations and runtime grants (above).
3. Run `docker compose up -d`.

Startup refuses to run with a pending migration when `WARDEN_MIGRATE=false`, so a missed step fails loudly rather than half-working.
