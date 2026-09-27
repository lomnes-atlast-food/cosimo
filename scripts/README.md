# Installer scripts

These are the scripts published as release assets on every GitHub Release (SPEC §13.1–13.2). They are published here too so you can read them before running them.

| Script | Platforms | Usage |
| --- | --- | --- |
| `install.sh` | macOS, Linux (x64, arm64), POSIX `sh` | `curl -fsSL https://github.com/lomnes-atlast-food/cosimo/releases/latest/download/install.sh \| sh` |
| `install.ps1` | Windows x64 | `irm https://github.com/lomnes-atlast-food/cosimo/releases/latest/download/install.ps1 \| iex` |

Both scripts:

1. Detect the platform and pick the release asset (`cosimo-darwin-arm64`, `cosimo-darwin-x64`, `cosimo-linux-x64`, `cosimo-linux-arm64`, `cosimo-windows-x64.exe`).
2. Download it and `checksums.txt` from GitHub Releases (`lomnes-atlast-food/cosimo`).
3. Verify the SHA-256 and abort on a mismatch or a missing checksum line.
4. Install the binary and print advice about `PATH` if needed. `install.ps1` adds its folder to your user `PATH` itself.
5. Run `cosimo init` with the remaining arguments.

Every action is logged: to stderr with `install.sh`, which keeps stdout for `cosimo init --json`, and with `Write-Host` in `install.ps1`.

## install.sh

```sh
curl -fsSL https://github.com/lomnes-atlast-food/cosimo/releases/latest/download/install.sh | sh -s -- --answers ./cosimo-answers.json --yes --json
```

Installer flags (all other arguments go to `cosimo init`):

- `--system`: install to `/usr/local/bin`, using `sudo` if you are not root. Without this flag the script never uses `sudo`.
- `--no-init`: install only.
- `--help`: show usage.

Install location: `~/.local/bin/cosimo`, or `/usr/local/bin/cosimo` when run as root.

## install.ps1

Installs to `%LOCALAPPDATA%\Programs\cosimo\cosimo.exe`. `irm | iex` cannot pass arguments. For automation, either run it as a script block:

```powershell
& ([scriptblock]::Create((irm https://github.com/lomnes-atlast-food/cosimo/releases/latest/download/install.ps1))) --answers .\answers.json --yes --json
```

or use the environment variables below. `COSIMO_INIT_ARGS` and `COSIMO_NO_INIT` work only in `install.ps1`.

## Environment overrides

| Variable | Meaning |
| --- | --- |
| `COSIMO_VERSION` | Release to install: `latest` (default) or a version such as `0.1.0`, which maps to tag `v0.1.0` |
| `COSIMO_INSTALL_DIR` | Install directory |
| `COSIMO_DOWNLOAD_BASE` | Base URL that holds the release assets directly, for mirrors and tests |
| `COSIMO_ALLOW_UNSIGNED=1` | `install.sh`: continue if cosign is installed but the release has no signature files |
| `COSIMO_NO_INIT=1` | `install.ps1`: install only |
| `COSIMO_INIT_ARGS` | `install.ps1`: arguments for `cosimo init` when none are passed |

## How verification works

- **Checksum (always):** the binary's SHA-256 must match its line in `checksums.txt` (`sha256sum` format). The files are fetched over HTTPS.
- **Signature (when `cosign` is installed):** the release workflow signs `checksums.txt` with cosign keyless `sign-blob --bundle`, which publishes a Sigstore bundle, `checksums.txt.sigstore.json`. If `cosign` is on `PATH`, `install.sh` checks the bundle against this repository's `release.yml` workflow identity before it trusts any checksum. If `cosign` is not installed, the script says the signature was not checked. Releases v0.1.0 and v0.1.1 have no bundle, only `checksums.txt.sig` and `checksums.txt.pem`; for those, `install.sh` checks that signature and certificate instead. `install.ps1` does not check signatures. To check one by hand:

```sh
cosign verify-blob \
  --bundle checksums.txt.sigstore.json \
  --certificate-identity-regexp '^https://github.com/lomnes-atlast-food/cosimo/.github/workflows/release.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  checksums.txt
```

## Tests

`bun test scripts/install.test.ts` serves a fake release from a temporary directory and runs `install.sh` against it with a minimal `PATH`. The tests cover:

- a normal install, with arguments passed through to `init`
- a checksum mismatch
- a missing asset
- `--no-init` and `--help`
- cosign behavior, using a fake `cosign`: the bundle, the legacy `.sig`/`.pem` fallback, a bad signature, and missing signature files
- running under `dash`
- `sh -n`, and `shellcheck` when it is installed

`install.ps1` is only parsed, and only when `pwsh` is available.
