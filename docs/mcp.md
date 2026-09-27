# AI assistants: MCP and OAuth

Cosimo serves a [Model Context Protocol](https://modelcontextprotocol.io) endpoint at
`<your instance>/mcp`. An assistant such as Claude can read your books through it and propose
changes. It can't make changes on its own: everything it writes waits in the review queue until a
person approves it.

## Connecting

**With OAuth (recommended).** In your AI client, add a connector (custom MCP server) with the URL
`https://books.example.com/mcp`. The client finds the sign-in page by itself. You sign in to
Cosimo, pick one organization, choose the access level, and approve. The access level can't be
higher than your own role, and the default is Bookkeeper.

**With an API token.** For scripts and clients without OAuth, create a token under Account →
Personal API tokens, or with `cosimo token create`. Send it as `Authorization: Bearer <token>`.

Each connection works with exactly one organization. See and disconnect your apps under Account →
Connected AI apps. Owners see every app connected to their organization under Settings → AI
connections.

## What an assistant can do

Read:

| Tool | What it returns |
|---|---|
| `list_orgs` | The organization and the connection's role |
| `get_account_balances` | Chart of accounts with balances as of a date |
| `run_report` | Any report (P&L, balance sheet, trial balance, cash flow, tax lines, general ledger, AR/AP aging, 1099) |
| `list_uncategorized_transactions`, `search_transactions` | Bank and card transactions |
| `get_entry`, `list_entries` | Journal entries |
| `list_contacts`, `list_invoices` | Customers, vendors, invoices |
| `list_pending_reviews`, `get_review_item` | The review queue |

`list_uncategorized_transactions` leaves out transactions still pending at the bank: they aren't
categorizable yet and don't count toward a closed month.

Resources: `org://profile` (the business profile) and `org://notes` (bookkeeping notes). Edit both
under Settings → Business profile.

Propose (each takes a `rationale`, which you see in Review):

| Tool | Effect when approved |
|---|---|
| `categorize_transaction` | Posts the categorization entry |
| `create_rule` | Activates the rule |
| `create_manual_entry` | Posts the entry |
| `create_invoice_draft` | Finalizes the invoice (you still decide when to send it) |
| `append_note` | Adds a dated note attributed to the assistant (no review; notes don't touch the books) |

There are no tools to approve, reject, void, reverse, delete, or change lock dates. OAuth access
tokens can only read through the REST API, so an assistant can't reach those actions there either. Owners can auto-approve some
proposals with a review policy, such as "AI categorizations under $100 to an account already used
for that payee" (Settings → Review policies). Anything over the amount threshold is always
reviewed.

## The bundled skill

`skills/cosimo-bookkeeping/SKILL.md` teaches an assistant the standard workflows: the monthly
close, invoice follow-up, and the year-end package. For Claude Code, copy the folder to
`~/.claude/skills/cosimo-bookkeeping/`. For other clients, add it as a skill or paste it into the
project instructions.

## Technical details

- Transport: streamable HTTP, stateless. Each JSON-RPC `POST /mcp` gets an `application/json`
  answer. `GET /mcp` returns 405, because there is no server-initiated stream. Protocol versions
  2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05 are accepted.
- Authorization follows the MCP authorization spec, which is based on OAuth 2.1:
  - Protected resource metadata is at `/.well-known/oauth-protected-resource/mcp` and
    authorization server metadata at `/.well-known/oauth-authorization-server`. A request without
    a token gets `401` with `WWW-Authenticate: Bearer resource_metadata="…"`.
  - Clients can register themselves with dynamic client registration (`POST /oauth/register`,
    public clients only). An instance admin can turn this off and register clients by hand
    instead, in Admin → Settings → OAuth clients. Those clients get a secret.
  - Authorization uses the code flow with PKCE, and only `S256` is accepted. Codes are single-use
    and last 10 minutes. Replaying a code revokes the tokens it produced.
  - Access tokens last 1 hour. Refresh tokens last 30 days and rotate on every use, so an old
    refresh token stops working. Revoke a token with RFC 7009 at `POST /oauth/revoke`.
  - Redirect URIs must match exactly. `http://` is accepted only for `localhost`, `127.0.0.1` and
    `[::1]`, which may use any port (RFC 8252).
  - Codes, tokens and client secrets are stored only as SHA-256 hashes.
- Cookies aren't accepted at `/mcp`, and requests whose `Origin` isn't this instance's are refused.
  Both protect against DNS rebinding and cross-site use.
- Try it with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):
  `npx @modelcontextprotocol/inspector`, transport "Streamable HTTP", URL `https://books.example.com/mcp`.
  Either let it run the OAuth flow, or add an `Authorization: Bearer <token>` header.
