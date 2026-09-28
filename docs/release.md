# Releasing Cosimo

Releases are built by `.github/workflows/release.yml`.

## Cutting a release

Every green push to `main` cuts a release automatically; there is nothing to run by hand for the
common case. The version is never stored in source: `packages/shared/src/distribution.ts` reads it
from a build-time global, injected by the workflow.

`scripts/next-version.sh` computes the version once CI passes on `main`:

1. `prev` is the highest existing `v*` tag (by semver); with no tags yet, the release is `0.1.0`.
2. If `HEAD` is already tagged, nothing is published (a re-run of an already-released commit is a
   no-op).
3. Otherwise the bump is the max over every PR merged since `prev`: a `release:major` or
   `release:minor` label on any of them bumps higher; the default is a patch bump. The release is
   skipped entirely when every commit since `prev` belongs to a PR labeled `release:skip` (an
   unlabeled PR, or a commit pushed without a PR, counts as a patch), or when every changed file is
   docs or config (`*.md`, `docs/**`, `.claude/**`, `.github/ISSUE_TEMPLATE/**`).

Run it locally against fake tag/label input with `bash scripts/next-version.sh --dry-run` to check
what the next release would be without touching GitHub.

The tag itself is created by the workflow's `release` job, after the binaries build succeeds, so a
failed build leaves no tag behind and the next run retries the same version number.

### Overriding it

To release a specific version by hand — the first release, a re-release after a failed run, or a
pre-release — run the workflow from the Actions tab (`workflow_dispatch`) with a `version` input
(for example `0.2.0`), or push a tag directly:

```sh
git tag v0.2.0
git push origin v0.2.0
```

Either path always publishes that exact version, bypassing the auto-compute step. Tags with a
pre-release suffix (`v0.2.0-rc.1`) become GitHub pre-releases and do not move the `latest` or `X.Y`
image tags. A tag pushed by hand (not by the workflow's own token) triggers the workflow directly;
tags the workflow creates itself, with `GITHUB_TOKEN`, do not retrigger it.

Leaving the `version` input empty on a manual `workflow_dispatch` run falls back to the same
auto-compute logic as a push to `main`.

## What the workflow produces

- **Binaries.** All targets are cross-compiled on one Linux runner with `bun build --compile --target`. Each has the web UI built in. The files are `cosimo-linux-x64`, `cosimo-linux-arm64`, `cosimo-darwin-x64`, `cosimo-darwin-arm64` and `cosimo-windows-x64.exe`.
- **Checksums.** `checksums.txt` contains `sha256sum` output for every binary. The checksums file is signed with cosign keyless signing (GitHub OIDC), which produces one Sigstore bundle, `checksums.txt.sigstore.json` (signature, certificate and transparency-log entry). Releases v0.1.0 and v0.1.1 carry `checksums.txt.sig` and `checksums.txt.pem` instead.
- **Build provenance.** GitHub artifact attestations cover the binaries and `checksums.txt`.
- **GitHub Release.** It contains the files above plus `scripts/install.sh` and `scripts/install.ps1`.
- **Container image.** The image is published at `ghcr.io/steve-lomnes/cosimo` for `linux/amd64` and `linux/arm64`, tagged `X.Y.Z`, `X.Y` and `latest`. It includes SBOM and provenance attestations, and its digest is signed with cosign keyless signing.

## Verifying a download

Releases up to 0.6.5 were signed under the previous GitHub account name, so the
identity regexp below accepts both.

```sh
# 1. The checksums file was signed by this repo's release workflow.
cosign verify-blob \
  --bundle checksums.txt.sigstore.json \
  --certificate-identity-regexp '^https://github.com/(steve-lomnes|lomnes-atlast-food)/cosimo/.github/workflows/release.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  checksums.txt

# 2. The binary matches the checksums file.
sha256sum --check --ignore-missing checksums.txt     # macOS: shasum -a 256 -c --ignore-missing checksums.txt

# Alternative: GitHub build provenance
gh attestation verify cosimo-linux-x64 --repo steve-lomnes/cosimo
```

`install.sh` does both checks automatically. It skips the signature check if cosign is not installed, and falls back to `checksums.txt.sig` and `checksums.txt.pem` for an older release with no bundle.

## Verifying the image

```sh
cosign verify ghcr.io/steve-lomnes/cosimo:0.2.0 \
  --certificate-identity-regexp '^https://github.com/(steve-lomnes|lomnes-atlast-food)/cosimo/.github/workflows/release.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Deploying

A deployment pipeline can ship a signed image straight from this repo's releases, without rebuilding:
resolve the release's image tag to its digest, verify the cosign signature on that digest (the check
above), copy the image by digest into your own registry, fail if the digest changed in the copy, then
deploy that digest. Skip a Release run that published nothing (docs-only or `release:skip`).

## Allowed actions

The repository allows only GitHub-owned actions and these owners (Settings, Actions, "Allow
select actions"), and requires every action to be pinned to a full commit SHA:

- `docker/*`
- `oven-sh/*`
- `sigstore/*`
- `google/osv-scanner-action/*`
- `superfly/flyctl-actions/*`
- `zizmorcore/*`

A workflow that adds an action from any other owner fails until the list is updated.

## Running the image

```sh
docker run -d --name cosimo -p 8787:8787 \
  -v cosimo-data:/data \
  -e COSIMO_MASTER_KEY="$(openssl rand -base64 32)" \
  ghcr.io/steve-lomnes/cosimo:latest
```

Keep the master key somewhere safe. Without it, stored secrets cannot be decrypted. The container runs as uid 10001 and keeps all its state in `/data`. It reads an optional config file from `/etc/cosimo/config.toml`, and any `COSIMO_<SECTION>_<KEY>` environment variable overrides a config value.
