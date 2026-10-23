# Releasing

A release is one step: push a version tag. The [release workflow](../.github/workflows/release.yml) then:

1. Runs every CI check (format, lint, build, typecheck, unit and integration tests, the Docker build, and the E2E suite against compose) by calling [`ci.yml`](../.github/workflows/ci.yml). If any check fails, nothing is pushed or published.
2. Builds [`docker/Dockerfile`](../docker/Dockerfile) for `linux/amd64` and `linux/arm64` and pushes it to `ghcr.io/laclemen92/warden`, with OCI labels (source, revision, version, license), build provenance, and an SBOM. In parallel, it builds the development-only mock IdP from [`docker/mock-oidc.Dockerfile`](../docker/mock-oidc.Dockerfile) and pushes it to `ghcr.io/laclemen92/warden-mock-oidc` with the same tags, labelled as development-only. The mock IdP is a separate image; nothing from it goes into the Warden image.
3. Pulls the pushed image by digest on each platform, starts it against Postgres with the [example config](../examples/basic/warden.config.yaml), and checks that `/healthz` responds with the release version. It also starts the pushed mock IdP and checks its discovery document.
4. Creates a GitHub Release for the tag, with the upgrade notes from the [release draft](versioning.md#the-next-version) (stable releases only, which then delete the draft), notes generated from the PRs merged since the previous release (grouped by label with breaking changes first, see [`.github/release.yml`](../.github/release.yml)), the image digests, a `docker pull` line, and the config JSON Schema (`warden.config.schema.json`, see [Editor support](config.md#editor-support)) attached.

The tag is the version. It is baked into the image as `WARDEN_VERSION`, logged at startup, and returned by `GET /healthz` (`{"status":"ok","version":"0.2.0"}`). Builds outside the release workflow report `dev`. The `@wardenhq/*` packages stay private and are not published to npm.

## Cutting a release

Pick the version with [versioning](versioning.md): the **Release draft** under **Releases** suggests it from the `semver:*` labels of the PRs merged since the last tag. From an up-to-date `main` whose CI is green:

```sh
git tag v0.2.0
git push origin v0.2.0
```

Then watch the run under **Actions → Release**. The tag must be `vMAJOR.MINOR.PATCH`, optionally with a prerelease suffix.

You can also run the workflow from **Actions → Release → Run workflow** (or `gh workflow run release.yml -f version=0.2.0 --ref main`). Give the version without the `v`; the workflow tags the commit at the head of the branch you run it on. It refuses a version whose tag already exists.

### Prereleases

A version with a suffix, such as `v0.3.0-rc.1` or `v0.3.0-beta.2`, is a prerelease. It is published the same way, except that:

- the image is tagged only `0.3.0-rc.1` (not `0.3`, and never `latest`), and
- the GitHub Release is marked as a prerelease.

Prereleases can be cut from any branch, which is the way to try the workflow out. To clean one up afterwards, delete the Release and its tag (`gh release delete v0.3.0-rc.1 --cleanup-tag`) and the image versions under the repository's **Packages → warden** and **Packages → warden-mock-oidc → Package settings**.

## What gets published

| Version      | Image tags (`warden` and `warden-mock-oidc`) | GitHub Release |
| ------------ | -------------------------------------------- | -------------- |
| `1.4.2`      | `1.4.2`, `1.4`, `latest`                     | Release        |
| `1.5.0-rc.1` | `1.5.0-rc.1`                                 | Prerelease     |

A failed run may leave pushed images without a Release (for example, if the smoke test fails). Delete those image versions before retrying; re-running the workflow for the same tag overwrites its tags.

## Pulling the image

The repository is private, so its packages are too. Log in to GHCR with a [personal access token (classic)](https://github.com/settings/tokens) that has the `read:packages` scope:

```sh
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-username> --password-stdin
docker pull ghcr.io/laclemen92/warden:0.2.0
```

Pin a deployment by digest (from the Release notes) to be sure the image can't change underneath it:

```sh
docker pull ghcr.io/laclemen92/warden@sha256:<digest>
```

The mock IdP image (`ghcr.io/laclemen92/warden-mock-oidc`) is pulled the same way. Its package inherits the repository's access when first pushed; anyone who can pull `warden` can pull it, as long as it stays linked to this repository (**Packages → warden-mock-oidc → Package settings → Manage access**).

To run it, see [deploying Warden](deployment.md). The image listens on port 3000 and needs the environment variables in the [README](../README.md#authentication) plus `DATABASE_URL` and, usually, `WARDEN_CONFIG` pointing at a mounted config file. See [database setup](database.md) for migrations and database roles.
