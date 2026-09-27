#!/bin/bash
# SessionStart hook for Claude Code on the web: installs dependencies so lint, typecheck,
# unit tests and e2e tests work in a fresh cloud container.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

export PATH="$HOME/.bun/bin:$PATH"
echo "export PATH=\"$HOME/.bun/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"

# bun.lock is written by bun >= 1.4 (lockfileVersion 2); older bun rewrites it. The bun.sh
# installer downloads from GitHub, which the sandbox may block, so take bun from npm instead.
if ! bun --version 2>/dev/null | grep -qE '^(1\.([4-9]|[1-9][0-9])|[2-9])\.'; then
  case "$(uname -m)" in
    aarch64 | arm64) pkg=@oven/bun-linux-aarch64 ;;
    *) pkg=@oven/bun-linux-x64 ;;
  esac
  tmp=$(mktemp -d)
  (cd "$tmp" && npm pack --silent "$pkg@^1.4" >/dev/null && tar -xzf ./*.tgz)
  mkdir -p "$HOME/.bun/bin"
  install -m 755 "$tmp/package/bin/bun" "$HOME/.bun/bin/bun"
  rm -rf "$tmp"
fi

bun install

# e2e/serve.ts and the binary build serve the built web app.
bun run build:web

# Playwright's pinned Chromium can't be downloaded here; use the pre-installed one.
if [ -x /opt/pw-browsers/chromium ]; then
  echo 'export PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium' >> "$CLAUDE_ENV_FILE"
fi
