# Contributing to Warden

Thanks for your interest in contributing!

## Getting started

1. Install Node 22 and enable pnpm with `corepack enable`.
2. `pnpm install`
3. `docker compose up -d postgres mock-oidc` for a seeded example database and a mock OIDC provider.
4. `pnpm dev`

## Before opening a PR

Run the same checks as CI:

```sh
pnpm format:check
pnpm lint
pnpm build
pnpm typecheck
pnpm test
```

CI also runs the end-to-end suite in `e2e/` against the compose stack. To run it locally:

```sh
docker compose up -d --build --wait
pnpm --filter @wardenhq/e2e exec playwright install chromium   # once
pnpm e2e
docker compose down -v
```

It signs in through the mock IdP as its test users and writes to the example database. If you start compose with a different `WARDEN_PORT`, pass the same one to `pnpm e2e`.

- Keep PRs focused, and link the issue they address (`Closes #123`).
- Add tests for new behavior. Pure logic belongs in `packages/*` with unit tests; database behavior gets integration tests against a real Postgres.
- Security matters here: Warden sits in front of production data. Any change touching auth, permissions, SQL generation, or the audit log should include tests for the deny/failure paths, not just the happy path.

## Reporting security issues

Please do not open public issues for vulnerabilities. Use GitHub's private vulnerability reporting on this repository instead.

## License

By contributing, you agree that your contributions are licensed under the [Apache-2.0](LICENSE) license.
