# AI assistants: MCP and OAuth

Cosimo serves a [Model Context Protocol](https://modelcontextprotocol.io) endpoint at
`<your instance>/mcp`. An assistant such as Claude can read your books through it and propose
changes. It can't change the books on its own: everything it writes to them waits in the review
queue until a person approves it. Only notes and contacts, which don't touch the books, apply
directly.

## Connecting

**With OAuth (recommended).** In your AI client, add a connector (custom MCP server) with the URL
`https://books.example.com/mcp`. The client finds the sign-in page by itself. You sign in to
Cosimo, pick one organization, choose the access level, and approve. The access level can't be
higher than your own role, and the default is Bookkeeper. Custom connectors in claude.ai need only
the URL. If dynamic client registration is turned off, an admin registers a client with the
redirect URI `https://claude.ai/api/mcp/auth_callback`, and you enter its client ID and secret in
the connector's advanced settings.

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
| `get_cash_snapshot` | Cash and card balances, month/YTD P&L, review and categorize counts, overdue invoices, bills due soon |
| `list_uncategorized_transactions`, `search_transactions` | Bank and card transactions |
| `get_entry`, `list_entries` | Journal entries, with account and contact names filled in and whether each has an attachment |
| `list_contacts` | Customers and vendors; pass `include_archived` to see archived ones too |
| `list_invoices`, `list_bills`, `list_bill_payments` | Invoices to customers, bills from vendors, and payments sent to vendors |
| `list_pending_reviews`, `get_review_item` | The review queue |
| `list_recurring_templates` | Recurring invoices, bills, and journal entries: schedule, next and upcoming dates, run mode, total, last error, and any change waiting for review |

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
| `create_bill_draft` | Posts the bill to Accounts Payable |
| `propose_reversal` | Posts a reversal of a posted entry |
| `propose_replacement` | Reverses a posted entry and posts the corrected one, together (one review item) |
| `propose_recurring_template` | Creates, changes, pauses, or resumes a recurring invoice, bill, or journal entry. A template that emails invoices to the customer always waits for a person, whatever the review policies say |
| `propose_payment_date_change` | Moves a payment to a new date: its entry is reversed on the old date and posted again on the new one; the documents it pays stay paid and a matched bank transaction stays matched (one review item) |

Entries created by invoices, bills, and payments can't be reversed or replaced over MCP; void or
edit the document instead. A payment's date is the one exception.

Apply directly, without review, and recorded in the audit log:

| Tool | Effect |
|---|---|
| `create_contact`, `update_contact` | Adds, edits, archives, or unarchives a customer or vendor (contacts don't touch the books) |
| `append_note` | Adds a dated note attributed to the assistant (notes don't touch the books) |

There are no tools to approve, reject, void, delete, or change lock dates. OAuth access
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
  - Clients can register themselves with dynamic client registration (`POST /oauth/register`),
    either as public clients (`token_endpoint_auth_method` `none`) or as confidential ones
    (`client_secret_post` or `client_secret_basic`). A confidential client gets its secret in the
    registration response, and the secret doesn't expire. An instance admin can turn dynamic
    registration off and register clients by hand instead, in Admin → Settings → OAuth clients.
    Those clients get a secret.
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
