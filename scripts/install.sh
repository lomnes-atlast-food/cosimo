#!/bin/sh
# Cosimo installer for macOS and Linux (POSIX sh).
#
#   curl -fsSL https://github.com/steve-lomnes/cosimo/releases/latest/download/install.sh | sh
#   curl -fsSL https://github.com/steve-lomnes/cosimo/releases/latest/download/install.sh | sh -s -- --answers ./cosimo-answers.json --yes --json
#
# Downloads the release binary from GitHub Releases, verifies its SHA-256
# against checksums.txt (and the cosign signature bundle on checksums.txt when
# cosign is installed), installs it, then runs `cosimo init` with any extra arguments.
# Every action is logged to stderr so stdout carries only `cosimo init` output.
#
# Installer flags:  --system (install to /usr/local/bin, using sudo if needed)
#                   --no-init (install only)   --help
# Environment:      COSIMO_VERSION (default: latest, or e.g. 0.1.0)
#                   COSIMO_INSTALL_DIR, COSIMO_DOWNLOAD_BASE, COSIMO_ALLOW_UNSIGNED=1
set -eu

# Mirrors packages/shared/src/distribution.ts
GITHUB_REPO="steve-lomnes/cosimo"
RELEASES_BASE_URL="https://github.com/${GITHUB_REPO}/releases"
# Downloads always come from GITHUB_REPO above (the current account), so accepting the old
# identity here doesn't let the old namespace supply files. Releases through 0.6.5 were signed
# under the previous GitHub account name; this regexp accepts both so those
# releases still verify.
CERT_IDENTITY_REGEXP="^https://github.com/(steve-lomnes|lomnes-atlast-food)/cosimo/.github/workflows/release.yml@"
CERT_OIDC_ISSUER="https://token.actions.githubusercontent.com"

VERSION="${COSIMO_VERSION:-latest}"
SYSTEM=0
NO_INIT=0

say() { printf 'cosimo-install: %s\n' "$*" >&2; }
die() { printf 'cosimo-install: error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat >&2 <<'EOF'
Usage: install.sh [--system] [--no-init] [--help] [-- cosimo init args...]

Installs the cosimo binary and runs `cosimo init`, passing through any
arguments that are not installer flags, e.g.:

  curl -fsSL https://github.com/steve-lomnes/cosimo/releases/latest/download/install.sh | sh -s -- --answers ./answers.json --yes --json

Installer flags:
  --system    Install to /usr/local/bin (uses sudo if not already root)
  --no-init   Install only; do not run `cosimo init`
  --help      Show this help

Environment:
  COSIMO_VERSION          Release to install (default: latest; e.g. 0.1.0)
  COSIMO_INSTALL_DIR      Install directory (default: ~/.local/bin, or
                          /usr/local/bin when run as root or with --system)
  COSIMO_DOWNLOAD_BASE    Base URL holding the release assets (for mirrors/tests)
  COSIMO_ALLOW_UNSIGNED=1 Continue if cosign is installed but signature files
                          are missing
EOF
}

# Split installer flags from pass-through args (no arrays in POSIX sh).
n=$#
while [ "$n" -gt 0 ]; do
  arg=$1
  shift
  n=$((n - 1))
  case $arg in
    --system) SYSTEM=1 ;;
    --no-init) NO_INIT=1 ;;
    --help | -h) usage; exit 0 ;;
    *) set -- "$@" "$arg" ;;
  esac
done

# 1. Detect OS and architecture.
case $(uname -s) in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "unsupported OS '$(uname -s)'. On Windows use: irm https://github.com/steve-lomnes/cosimo/releases/latest/download/install.ps1 | iex" ;;
esac
case $(uname -m) in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "unsupported architecture '$(uname -m)' (supported: x64, arm64)" ;;
esac
ASSET="cosimo-${os}-${arch}"
say "detected platform ${os}/${arch}; release asset ${ASSET}"

if [ -n "${COSIMO_DOWNLOAD_BASE:-}" ]; then
  base="${COSIMO_DOWNLOAD_BASE%/}"
elif [ "$VERSION" = latest ]; then
  base="${RELEASES_BASE_URL}/latest/download"
else
  base="${RELEASES_BASE_URL}/download/v${VERSION#v}"
fi

# Choose the install directory and whether sudo is needed.
SUDO=""
if [ -n "${COSIMO_INSTALL_DIR:-}" ]; then
  dir=$COSIMO_INSTALL_DIR
elif [ "$SYSTEM" = 1 ] || [ "$(id -u)" = 0 ]; then
  dir=/usr/local/bin
else
  dir="${HOME:?HOME is not set}/.local/bin"
fi
if [ "$SYSTEM" = 1 ] && [ "$(id -u)" != 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "--system needs root or sudo"
  SUDO=sudo
fi

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t cosimo)
trap 'rm -rf "$tmp"' EXIT
trap 'exit 1' HUP INT TERM

download() { # url dest
  say "downloading $1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    die "curl or wget is required"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    die "no SHA-256 tool found (need sha256sum, shasum, or openssl)"
  fi
}

# 2. Download the binary and checksums.
download "${base}/${ASSET}" "$tmp/$ASSET" || die "download of ${ASSET} failed"
download "${base}/checksums.txt" "$tmp/checksums.txt" || die "download of checksums.txt failed"

# 3. Verify the checksums file signature (when cosign is available), then the binary.
# Releases carry a Sigstore bundle (checksums.txt.sigstore.json); v0.1.0 and v0.1.1 carry only a
# detached signature and certificate (checksums.txt.sig/.pem), so fall back to those.
if command -v cosign >/dev/null 2>&1; then
  sig=none
  if download "${base}/checksums.txt.sigstore.json" "$tmp/checksums.txt.sigstore.json"; then
    sig=bundle
  else
    say "no signature bundle; trying the legacy checksums.txt.sig/.pem"
    if download "${base}/checksums.txt.sig" "$tmp/checksums.txt.sig" &&
      download "${base}/checksums.txt.pem" "$tmp/checksums.txt.pem"; then
      sig=legacy
    fi
  fi
  case $sig in
    bundle)
      say "verifying checksums.txt signature bundle with cosign"
      cosign verify-blob \
        --bundle "$tmp/checksums.txt.sigstore.json" \
        --certificate-identity-regexp "$CERT_IDENTITY_REGEXP" \
        --certificate-oidc-issuer "$CERT_OIDC_ISSUER" \
        "$tmp/checksums.txt" >&2 || die "cosign signature verification FAILED; not installing"
      say "signature OK"
      ;;
    legacy)
      say "verifying checksums.txt signature with cosign"
      cosign verify-blob \
        --certificate "$tmp/checksums.txt.pem" \
        --signature "$tmp/checksums.txt.sig" \
        --certificate-identity-regexp "$CERT_IDENTITY_REGEXP" \
        --certificate-oidc-issuer "$CERT_OIDC_ISSUER" \
        "$tmp/checksums.txt" >&2 || die "cosign signature verification FAILED; not installing"
      say "signature OK"
      ;;
    *)
      if [ "${COSIMO_ALLOW_UNSIGNED:-}" = 1 ]; then
        say "warning: signature files missing; continuing because COSIMO_ALLOW_UNSIGNED=1"
      else
        die "signature files missing for this release; set COSIMO_ALLOW_UNSIGNED=1 to install anyway"
      fi
      ;;
  esac
else
  say "note: cosign not found, signature not checked (checksum is still verified; files fetched over HTTPS)"
fi

expected=$(awk -v f="$ASSET" '$2 == f || $2 == "*" f { print $1; exit }' "$tmp/checksums.txt")
[ -n "$expected" ] || die "no checksum for ${ASSET} in checksums.txt; not installing"
actual=$(sha256_of "$tmp/$ASSET")
if [ "$expected" != "$actual" ]; then
  die "checksum mismatch for ${ASSET} (expected ${expected}, got ${actual}); not installing"
fi
say "checksum OK (sha256 ${actual})"

# 4. Install.
say "installing to ${dir}/cosimo${SUDO:+ (via sudo)}"
$SUDO mkdir -p "$dir"
chmod 755 "$tmp/$ASSET"
$SUDO cp "$tmp/$ASSET" "$dir/.cosimo.new.$$"
$SUDO chmod 755 "$dir/.cosimo.new.$$"
$SUDO mv -f "$dir/.cosimo.new.$$" "$dir/cosimo"
say "installed ${dir}/cosimo"

case ":${PATH}:" in
  *":${dir}:"*) ;;
  *)
    say "${dir} is not on your PATH. Add it with:"
    say "  echo 'export PATH=\"${dir}:\$PATH\"' >> ~/.profile  # or ~/.zshrc, ~/.bashrc"
    ;;
esac

# 5. Run `cosimo init`.
if [ "$NO_INIT" = 1 ]; then
  say "skipping 'cosimo init' (--no-init). Run it later with: ${dir}/cosimo init"
  exit 0
fi
say "running: ${dir}/cosimo init $*"
rm -rf "$tmp"
trap - EXIT HUP INT TERM
exec "$dir/cosimo" init "$@"
