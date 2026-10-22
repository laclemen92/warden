# @wardenhq/mock-oidc

**Development only. Never deploy it.** A mock OIDC provider whose login page lists fixed test users (`viewer@`, `editor@`, and `admin@example.com`, plus `outsider@example.org`) and signs you in as any of them with no password. Anyone who can reach it can sign in to a Warden that trusts it as any of those users.

It is used by the repository's `docker-compose.yml` and the E2E suite, and each release publishes it as `ghcr.io/laclemen92/warden-mock-oidc:<version>` for [trying Warden locally](../../docs/deployment.md#trying-it-locally-without-an-identity-provider). It is never part of the Warden image.

| Variable                              | Default                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `MOCK_OIDC_PORT`                      | `9400`                                                                    |
| `MOCK_OIDC_HOST`                      | `0.0.0.0`                                                                 |
| `MOCK_OIDC_ISSUER`                    | `http://localhost:<port>`                                                 |
| `MOCK_OIDC_CLIENT_ID`                 | `warden`                                                                  |
| `MOCK_OIDC_CLIENT_SECRET`             | `warden-dev-secret`                                                       |
| `MOCK_OIDC_REDIRECT_URIS`             | `http://localhost:3000/auth/callback,http://localhost:5173/auth/callback` |
| `MOCK_OIDC_POST_LOGOUT_REDIRECT_URIS` | `http://localhost:3000/,http://localhost:5173/`                           |
