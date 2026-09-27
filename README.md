# Cosimo

Self-hosted double-entry bookkeeping for freelancers, consultants, and small businesses.
Named after Cosimo de' Medici, who built the Medici bank on disciplined double-entry books.

## Install

macOS and Linux:

```sh
curl -fsSL https://github.com/lomnes-atlast-food/cosimo/releases/latest/download/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://github.com/lomnes-atlast-food/cosimo/releases/latest/download/install.ps1 | iex
```

Docker: `ghcr.io/lomnes-atlast-food/cosimo:<version>`. See [docs/deployment.md](docs/deployment.md)
for Docker, Fly.io, and other platforms.

## First steps

`cosimo init` asks a few questions and sets up a local instance, a Docker server with automatic
HTTPS, or a Fly.io app. It prints a claim link; open it within 24 hours to set your password and log
in. Agents: see [AGENTS.md](AGENTS.md). Other platforms: [docs/deployment.md](docs/deployment.md).
Bank feeds: [docs/plaid.md](docs/plaid.md).

## Develop

```sh
bun install
bun run check        # lint + typecheck + tests
bun run dev          # server on http://localhost:8787
```

## Operations

- `cosimo backup` runs nightly by default; `cosimo backup list`, `cosimo backup download <name>`,
  and `cosimo restore <file>`. Attachments and backups can live in any S3-compatible bucket
  ([docs/object-storage.md](docs/object-storage.md)); `cosimo move-attachments` moves existing ones.
- `cosimo export <org_id>` writes the books in an open format ([docs/export-format.md](docs/export-format.md));
  `cosimo import <file.zip>` brings them back on any instance.
- Moving from QuickBooks Online, Xero, or Wave: [docs/importing.md](docs/importing.md).
- `cosimo upgrade` installs a new release (backup first, then migrate); `cosimo doctor` checks health.

## AI assistants and the API

- Add `https://<your instance>/mcp` to Claude (or any MCP client) as a connector; everything it
  writes waits in the review queue. See [docs/mcp.md](docs/mcp.md).
- The bundled skill [skills/cosimo-bookkeeping](skills/cosimo-bookkeeping/SKILL.md) teaches the
  monthly close, invoice follow-up, and year-end package.
- REST API reference at `/api/docs` (OpenAPI 3.1 at `/api/v1/openapi.json`).

## License

MIT © 2026 Stephen Lomnes
