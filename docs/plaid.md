# Bank feeds with Plaid

Cosimo connects to banks through [Plaid](https://plaid.com) using **your own Plaid keys**. Cosimo
has no Plaid account of its own and nothing passes through anyone else's servers: your instance
talks to Plaid directly.

Bank feeds are optional. Statement import (CSV, OFX, QFX) works for every bank and can be used
alongside a feed.

## 1. Get keys

1. Create an account at <https://dashboard.plaid.com/signup>.
2. Under **Developers → Keys**, copy the `client_id` and the **Sandbox** secret.

Sandbox is free and needs no approval. It serves test banks with fake data. Sign in to any test bank
with `user_good` / `pass_good`.

### Production

To connect real bank accounts you must complete **Plaid's own production onboarding**: company
details, a use-case questionnaire, and in some cases a security review. Plaid decides whether and when
to approve; Cosimo can't speed that up. Until then, everything works in Sandbox, and statement import
works for real banks.

Once approved, switch the environment to **Production** and paste the production secret.

## 2. Add the keys to Cosimo

Pick one:

- **Setup**: answer yes to `plaid_enabled` in `cosimo init` (or set `plaid_env`, `plaid_client_id`,
  and `plaid_secret` in the answers file).
- **Admin → Settings → Plaid**: turn on bank feeds and enter the keys. The secret is write-only.
- **Environment variables** (they override stored values): `COSIMO_PLAID_ENABLED=true`,
  `COSIMO_PLAID_ENV`, `COSIMO_PLAID_CLIENT_ID`, `COSIMO_PLAID_SECRET`.
- **Per organization**: an org owner can use a different Plaid account under **Settings → Bank
  feeds**. Org keys override the instance keys for that org only.

Secrets and access tokens are encrypted with the instance master key (AES-256-GCM). They never appear
in API responses, logs, or exports. **If you lose the master key, stored bank connections can't be
recovered.** Reconnect each bank after restoring with a new key.

## 3. Connect a bank

As an org owner, go to **Banking → Accounts & connections → Connect a bank**. After you sign in at the
bank, choose what to do with each account:

- **New bank account**: Cosimo creates the bank account and its ledger account. It uses an asset
  account for checking and savings, and a credit card liability for cards.
- **Link to an existing account**: use this for an account you already import statements into.
  Feed transactions dated on or before its last imported statement row are skipped, so nothing is
  counted twice.
- **Don't import**: loans and investment accounts are skipped by default.

The first sync starts right away. New transactions appear in **Banking → Categorize**.

## How syncing works

- Cosimo uses Plaid's `/transactions/sync` with a stored cursor, so each sync fetches only what
  changed. Syncing twice never creates duplicates.
- **Pending** transactions are shown with a *Pending* badge and can't be categorized. When the bank
  posts one, Plaid replaces it: the pending row is removed and the posted row arrives ready to
  categorize.
- **Changes**: if the bank edits or removes a transaction you haven't categorized, Cosimo applies the
  change. If you already booked it, the entry stays as it is and the change is recorded in the audit
  log for you to check.
- **Polling**: every connection syncs every 6 hours, so a local instance with no public URL still
  gets new transactions. **Sync now** fetches immediately.
- **Webhooks**: when the instance has a public HTTPS URL, Cosimo registers
  `https://<your-host>/api/v1/webhooks/plaid/<org-id>` with Plaid. It syncs as soon as Plaid reports
  new activity. Every webhook's `Plaid-Verification` signature is checked (ES256 key from Plaid, body
  SHA-256, at most 5 minutes old), and unsigned or altered requests are rejected. If your public URL
  differs from `server.public_url`, set it under **Admin → Settings → Plaid → Public URL for
  webhooks**.

## Reconnecting

Banks sometimes ask you to sign in again, for example after a password change or when access
expires. The connection then shows **Reconnect needed** with the reason, and polling pauses for it.
Click **Reconnect**, sign in through Plaid's update mode, and syncing resumes where it left off.

## OAuth banks

Some institutions, including many large US banks, send you to their own website to sign in and then
back to Cosimo. For these you need to:

1. Serve Cosimo over **public HTTPS**.
2. In the Plaid dashboard, under **Developers → API → Allowed redirect URIs**, add
   `https://<your-host>/plaid/oauth`.
3. Enter the same URI in **Admin → Settings → Plaid → OAuth redirect URI**.

Without this, those banks can't be connected. Everything else still works, including other banks and
statement import.

## Disconnecting

**Disconnect** removes Cosimo's access at Plaid and deletes the stored access token. Bank accounts
and every imported transaction stay, and you can keep importing statements into them.
