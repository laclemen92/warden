# Versioning

Warden follows [semantic versioning](https://semver.org): `MAJOR.MINOR.PATCH`, with prereleases such as `1.0.0-rc.1`. The version is the release tag (see [releasing](releasing.md)). Warden is at `1.0.0-rc.1`; from `1.0.0` on, these rules decide every bump.

The version describes Warden's **public API**, the things an operator or integration relies on. Anything not listed below can change in any release.

## Public API

| Surface               | What's covered                                                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config file           | Every key, default, and validation rule of `warden.config.yaml`/`.json` ([`packages/config/src/schema.ts`](../packages/config/src/schema.ts), documented in [config.md](config.md)).                    |
| Custom actions        | The `@wardenhq/actions` types and error classes, `defineAction`, the context actions receive (including the `tx` API and HTTP steps), and how Warden loads `WARDEN_ACTIONS` ([actions.md](actions.md)). |
| HTTP API              | Routes under `/api/*` and `/auth/*`, their request and response shapes, status codes, and the session cookie, as used by integrations, not just the bundled UI.                                         |
| Environment variables | Every documented variable (`DATABASE_URL`, `WARDEN_*`, `OIDC_*`), its format and default.                                                                                                               |
| CLI entry points      | `node dist/migrate.js` and its behaviour ([database.md](database.md#migrations)).                                                                                                                       |
| Database              | The `warden` schema's migrations, the tables integrations read (such as `warden.audit_log`), and the documented [runtime grants](database.md#restricting-the-runtime-role).                             |
| Docker image          | Port 3000, `GET /healthz` and its response, `WARDEN_CONFIG`, the image names and tag scheme ([releasing.md](releasing.md#what-gets-published)).                                                         |

Not covered: the web UI's look and layout, log message text, internal `@wardenhq/*` packages other than `@wardenhq/actions` (they are private), the mock IdP (development only), and undocumented behaviour.

## Bump rules

Pick the highest that applies.

### Major

A change that can break a working deployment or integration on upgrade:

- removing or renaming a config key or environment variable (e.g. renaming `tables.<t>.hidden` to `tables.<t>.hide`);
- tightening validation so a previously valid config fails to load (e.g. rejecting a column name that used to be accepted);
- changing a default in a way that grants or removes access (e.g. making a previously readable column hidden by default, or a write allowed by default);
- removing or changing the shape of an `/api/*` route or response field;
- a breaking change to `defineAction` or the `tx` API (e.g. a required new argument, a removed method);
- a migration that needs manual steps beyond re-running the grants (e.g. backfilling data, changing ownership);
- changing the image's port, `/healthz` response, or tag scheme.

A security fix that has to break behaviour is still a major, and its notes say plainly that it is a security fix and what to change.

### Minor

A backwards-compatible addition:

- a new optional config key, environment variable, endpoint, response field, or action API (e.g. adding `tables.<t>.softDelete`);
- a new feature in the UI;
- a migration that adds tables or columns the runtime role needs new grants for. Call it out in the upgrade notes ("re-run the grants").

### Patch

No change to the contract:

- bug fixes and security fixes that keep documented behaviour (e.g. a filter that returned wrong rows now returns the right ones);
- docs, internal refactors, dependency updates, performance work.

### None

Changes that never reach a release: CI and workflow changes, tests, repository tooling, and contributor docs such as `CLAUDE.md`.

## Labels

Every PR carries exactly one label: `semver:major`, `semver:minor`, `semver:patch`, or `semver:none`. The [PR labels](../.github/workflows/pr-labels.yml) check fails without one. When unsure between two, pick the higher.

PRs labelled `semver:major`, and `semver:minor` PRs that need operators to act (such as re-running the grants), fill in the **Breaking changes / upgrade notes** section of the PR template: what changes for whom, and the exact steps to upgrade. Everything else writes "None".

## The next version

The [release draft](../.github/workflows/release-draft.yml) workflow runs on every push to `main`. It takes the highest `semver:*` label among the PRs merged since the last stable version tag (prereleases don't count) and keeps a draft GitHub Release titled with the suggested next version, with the upgrade notes from those PRs and the generated notes (breaking changes first). PRs without a single `semver:*` label count as patch and are listed in a warning. From a prerelease, a bump the prerelease already covers releases it: after `v1.0.0-rc.1`, any bump suggests `v1.0.0`.

The draft is only a suggestion and is never published. To release, push the tag ([releasing](releasing.md#cutting-a-release)); the release workflow copies the draft's upgrade notes into the Release and deletes the draft, and the next push to `main` starts a new one. To cut a prerelease of the suggested version instead, tag `v<suggested>-rc.1`; a prerelease leaves the draft in place, so the final release still gets every upgrade note since the last stable version.
