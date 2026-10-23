# Warden

Config-driven, audited backoffice for Postgres. Warden introspects the live database at runtime (no codegen) and exposes every table as grids, detail views, and (later) CRUD. `warden.config.yaml|json` narrows and customizes that. Every write will be audited. Self-hosted as one Docker image; SSO (OIDC) only.

Roadmap: GitHub milestones and `epic`-labeled issues with sub-issues. The issue body is the spec; meet its acceptance criteria.

## Commands

```sh
pnpm install
pnpm build          # turbo; packages build before dependents
pnpm test           # vitest; DB tests start Postgres via Testcontainers (Docker must be running)
pnpm typecheck
pnpm lint
pnpm format         # prettier --write; CI runs format:check
pnpm --filter @wardenhq/<pkg> test   # one package
```

Run `pnpm format && pnpm lint && pnpm typecheck && pnpm test` before every commit. CI runs the same plus a Docker build.

## Layout

| Path                  | Contents                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`       | Pure logic, no I/O: `SchemaModel` types, `resolveSchema` (model + config → `EffectiveSchema`), filter AST + `validateFilter`, sort, record ids, cursors |
| `packages/config`     | zod schema for the config file and `loadConfig` (errors carry file/line/col)                                                                            |
| `packages/actions`    | Published types and error classes for custom action modules (`defineAction`); no runtime dependencies                                                   |
| `packages/pg-adapter` | Postgres: `introspect`, `createDatabase`, `compileFilter`, `listRows`/`getRow`, `migrate` (`warden` schema), sessions                                   |
| `packages/testing`    | `startPostgres()` / `readExampleSql()` test helpers (private)                                                                                           |
| `packages/mock-oidc`  | Dev/E2E-only OIDC provider (`startMockOidc()`, `MOCK_USERS`); runs in compose. Never ship it                                                            |
| `apps/server`         | Fastify. `warden.ts` boots (config → introspect → resolve → app); `app.ts` wires routes; `auth/*` OIDC + sessions; `routes/*`                           |
| `apps/web`            | React + Vite UI                                                                                                                                         |
| `examples/basic`      | Example schema, seed, and config used by compose and tests                                                                                              |

Put logic in `packages/core` when it can be pure; keep SQL in `pg-adapter`; keep the server thin.

## Docs map

[`docs/README.md`](docs/README.md) indexes every doc and says which to read before touching each area. Start with [`docs/architecture.md`](docs/architecture.md) (request flow, package boundaries, and where each rule below is enforced). Key references: [`config.md`](docs/config.md) (config schema), [`database.md`](docs/database.md) (`warden` schema, migrations, audit log), [`actions.md`](docs/actions.md) (custom and HTTP actions), and the README's [Authentication](README.md#authentication) section (sign-in env vars).

**Docs change in the same PR as the behavior.** A change to config, env vars, the API, the `warden` schema, or what users see updates the doc that describes it (and `apps/web/src/pages/help-page.tsx` with `docs/using-warden.md`). A new doc gets a line in `docs/README.md`.

## Core rules (security-relevant; don't break these)

- **Config narrows defaults.** Everything is readable unless config hides it. Writes (create/update/delete) are denied unless config grants them to a role, and a table-level `deny` beats every grant. Hard delete is also off unless the table opts in (`allowDelete` / `defaults.delete`), and a `*` grant never includes `delete`.
- **Hidden means absent.** Hidden tables and columns are removed in `resolveSchema` and must never be selected, returned, or accepted as input. A hidden field or entity must be indistinguishable from a nonexistent one (same 400/404 and message).
- **Only the `EffectiveSchema` decides what exists.** Identifiers in SQL come from it and are quoted with `sql.id`. Client values are always bind parameters. Never build SQL with string interpolation or `sql.raw` on user input.
- **Validate client input in `core`** (filters, sorts, ids, cursors) before it reaches `pg-adapter`.
- **Config/DB mismatches are warnings, not crashes** (a dropped column must not take Warden down). Invalid config files _do_ fail startup with a `ConfigError`.
- **Don't leak internals.** 5xx responses are generic; details go to the log.
- Enforce permissions on the server. The UI only hides controls.
- **Every `/api/*` route requires a session.** The guard in `routes/auth.ts` checks the matched route as well as the raw URL (Fastify decodes `/%61pi/...` to `/api/...`). New API routes go under `/api/` so they are covered.
- **Writes are same-origin JSON.** The `onRequest` hook in `routes/auth.ts` refuses unsafe methods whose `Sec-Fetch-Site` isn't `same-origin`, and `/api/*` POSTs that aren't `application/json`, so a cross-site form can't trigger them. Never change state on GET, and never add a CORS policy.

## Conventions

- TypeScript strict with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`: omit optional keys instead of setting them to `undefined` (`...(x ? { x } : {})`).
- ESM everywhere; relative imports use `.js` extensions (except in `apps/web`, which uses bundler resolution).
- **TypeScript is pinned to ~6.0** because typescript-eslint doesn't support 7 yet. Don't bump it.
- zod 4 (`z.strictObject`, `.prefault`). Config objects are strict, so typos fail.
- Postgres values: dates/times come back as Postgres text (not JS `Date`); `int8`/`numeric` are strings. Keep it that way: cursors depend on it.
- Comments explain _why_, sparingly. Match the surrounding style.
- New dependency: add it to the package that uses it with `pnpm --filter`. Shared dev tooling goes at the root. Check the latest version first.
- New shortcuts or mouse modifiers go in the shortcuts module (`apps/web/src/lib/shortcuts.ts`) and `docs/using-warden.md` in the same PR.
- **Config changes are documented in the same PR.** Adding, changing, or removing a key in `packages/config/src/schema.ts` updates `docs/config.md` (the config reference) and `examples/basic/warden.config.yaml`, and regenerates `packages/config/warden.config.schema.json` (`pnpm --filter @wardenhq/config schema:json`; CI fails when it's stale). Give new keys a `.meta({ description })` for editor hovers.

## Tests

- Vitest. Unit tests next to the package in `test/`. Anything touching SQL gets an integration test against real Postgres via `@wardenhq/testing` (see `packages/pg-adapter/test/*` and `apps/server/test/*`).
- For security-relevant code, test the deny and failure paths (hidden fields, injection payloads, tampered ids/cursors), not just the happy path.
- Prefer comparing against the equivalent hand-written SQL over hard-coded expectations.

## Workflow

- One branch and PR per issue: `feat/<issue>-<slug>`. The commit message and PR body end with `Closes #<issue>`. PR bodies have a Summary and a Test plan.
- Squash-merge. Regenerate `pnpm-lock.yaml` with `pnpm install` on conflicts; never hand-merge it.
- Several agents may work in parallel, so stay inside your issue's scope. Shared files that commonly conflict: `packages/core/src/index.ts` (append exports), `packages/config/src/schema.ts`, `apps/server/src/app.ts`, `pnpm-lock.yaml`.
- Docker compose host ports are configurable: use `POSTGRES_PORT=<unique> WARDEN_PORT=<unique> OIDC_PORT=<unique> docker compose up` so parallel work doesn't collide, and `docker compose down -v` afterwards.
- Check an issue's "Blocked by" notes before starting it.
- Label every PR with exactly one `semver:major|minor|patch|none` (CI enforces it); pick by [docs/versioning.md](docs/versioning.md), the higher one when unsure. Breaking config/env/API/`defineAction` changes are major; new optional keys, endpoints or action APIs are minor; fixes, docs and refactors are patch; CI/tests/tooling are none. Fill in the PR template's "Breaking changes / upgrade notes" for every major, and for minors that need operator action (e.g. re-running the grants); otherwise write "None".
