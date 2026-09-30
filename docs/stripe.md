# Online invoice payments with Stripe

Cosimo can put a **Pay online** link on each invoice. The link opens a Stripe Checkout page in
**your own Stripe account**, where the customer pays by card, ACH Direct Debit, or US bank transfer.
Cosimo then records the payment and Stripe's fee in your books; nobody books them by hand. Cosimo has
no Stripe account of its own and takes no cut: your instance talks to Stripe directly, and Stripe's
pricing applies.

Cosimo uses Checkout Sessions only. It doesn't use Stripe Invoicing, Stripe Billing, or Stripe.js;
the customer is redirected to a page hosted by Stripe.

Online payments are optional and off by default. There is also a simpler **payment link** mode for
any other payment service (see [below](#payment-link-mode)).

## 1. Create a restricted key

In the Stripe dashboard, under **Developers → API keys → Create restricted key**, give the key:

| Resource | Permission |
|---|---|
| Checkout Sessions | Write |
| Customers | Write |
| PaymentIntents | Read |
| Charges | Read |
| Balance transactions | Read |
| Webhook Endpoints | Write |
| Events | Read |
| Refunds | Read |
| Disputes | Read |
| Payouts | Read |

Customers can pay with the first seven; Webhook Endpoints write is needed only when Cosimo registers
the webhook itself (see [below](#webhooks-or-polling)). Refunds, Disputes, and Payouts read let
Cosimo propose entries for [refunds and disputes](#refunds-and-disputes) and suggest [payouts](#payouts)
on Categorize; without them it skips those and the settings page says which are missing. If you offer
Bank Transfers, the key also needs to read customers' **cash balances**; the check names the
permission Stripe asks for. **Account: Read** is optional: with it, Cosimo can also check that the
payment methods you offer are active.

Save and **Test connection** check each permission with requests that can't create anything. A
missing permission doesn't stop the save; the settings page (and `cosimo doctor`) list what's missing
until you add it to the key. Test connection lists every permission with its result.

A full secret key (`sk_...`) also works, but a restricted key (`rk_...`) limits what a leaked key can
do. Publishable keys (`pk_...`) are rejected.

Start with a **test mode** key (`rk_test_...`). Pay links then open Stripe's test Checkout, where the
card `4242 4242 4242 4242` with any future date and CVC succeeds. The invoice page and the settings
show a **Test mode** badge. Switch to a live key when you're ready.

Test mode and live mode are separate in Stripe: each has its own keys, payment method settings,
webhooks, and customers. When you switch an organization between a test key and a live key (or to
another Stripe account), Cosimo finds that a contact's saved Stripe customer doesn't exist there,
creates a new one, and carries on.

## 2. Add the key to Cosimo

As an org owner, open **Settings → Online payments**, choose **Stripe**, paste the key, and save.
Only owners see this tab; AI assistants can't change it.

- Cosimo checks the key with Stripe before storing it, and **Test connection** checks it again at
  any time.
- The key is encrypted with the instance master key (AES-256-GCM). It never appears in API
  responses, logs, the audit log, or exports.
- Choose the payment methods to offer. Cosimo uses the Stripe dashboard's names:

  | Stripe dashboard and Cosimo | Stripe API type |
  |---|---|
  | Cards | `card` |
  | ACH Direct Debit | `us_bank_account` |
  | Bank Transfers | `customer_balance` |

  **Each method you offer must be active in Stripe**, under **Settings → Payments → Payment
  methods**, in the same mode as the key (test and live are set separately). With Account: Read on
  the key, Save and Test connection check this and warn about any method that isn't active. If a
  checkout still names an inactive method, Stripe rejects it; Cosimo then retries once without that
  method so the customer can pay another way, and shows a warning naming the method on the settings
  page and the invoice. Checkouts leave the method out until you activate it and save or test the
  connection again. Your choice of methods isn't changed.

  **Link**, Stripe's saved-card wallet, can appear with card and is recorded as a card payment.
- On first setup Cosimo creates a **Stripe Clearing** asset account (code 1090, or the next free
  code) and uses **6300 Bank and Merchant Fees** for Stripe's fees, creating it if your chart doesn't
  have it. For refunds it uses **4050 Refunds and Allowances** (income), and for disputes a
  **Chargebacks** expense account (the next free code from 6310), creating each if it's missing.
  You can pick other accounts instead.
- **Accept online payment on new invoices by default** turns the link on for new invoices. Each
  invoice has its own switch.

Payment methods are chosen for the whole organization, not per invoice.

## Webhooks, or polling

- **Automatic webhook**: when the instance has a public HTTPS URL (`server.public_url`), saving the
  key registers `https://<your-host>/api/v1/webhooks/payments/stripe/<org-id>` in your Stripe account
  and stores its signing secret. Changing the key or turning Stripe off deletes that endpoint.
  An endpoint registered by an earlier release is updated with any events added since (such as
  `charge.updated` and the dispute events) on the next save or payment check; `cosimo doctor` warns
  if that fails.
- **Manual webhook**: if the key can't create webhook endpoints, add an endpoint for the same URL in
  the Stripe dashboard (events `checkout.session.*`, `payment_intent.succeeded`,
  `payment_intent.payment_failed`, `charge.updated`, `charge.refunded`, `charge.dispute.created`,
  `charge.dispute.funds_withdrawn`, `charge.dispute.funds_reinstated`, `charge.dispute.closed`,
  `payout.paid`), then paste its signing secret (`whsec_...`) under **Settings → Online payments**.
  When the key can read webhook endpoints, the settings page and `cosimo doctor` name any event the
  endpoint is missing.
- **Polling**: without a webhook (for example on a local instance), Cosimo asks Stripe every 15
  minutes about invoices with an open or processing checkout. With a webhook it still checks every 6
  hours as a safety net, and every 15 minutes while a payment waits for its fee or a webhook event
  waits to be retried. Each check also looks for refunds and payouts from the last 30 days and
  disputes from the last 120, so nothing depends on a webhook arriving. A customer who finishes
  Checkout is sent back to the pay link, which records the payment right away, webhook or not.

Every webhook's `Stripe-Signature` is checked (HMAC-SHA256 with the signing secret, at most 5 minutes
old); unsigned or altered requests get `401` and are not stored. Each event is stored once, so a
redelivery does nothing.

## What the customer sees

The invoice PDF gets a **PAY ONLINE** section with a clickable link, and the invoice email and
reminders say `Pay online: <link>`. The link is
`https://<your-host>/pay/<org-id>/<token>`:

- For an open invoice it goes straight to Checkout for the **balance due**, so after a partial
  payment the next checkout is for the rest.
- Stripe won't take less than **$0.50** through Checkout. While an invoice's balance due is under
  $0.50, the PDF and email leave out the link and the invoice page says why. A link sent earlier
  shows the customer a page asking them to pay another way. The link comes back if the balance goes
  up again.
- A paid invoice shows "This invoice is paid", a bank payment on its way shows "Your payment is
  processing", and a draft or void invoice shows that the link isn't available. These pages show
  only your organization name and the invoice number.
- The invoice page shows the link with a copy button, and when the customer first opened it.

The token is derived from the instance master key and only its hash is stored, so a copy of the
database alone gives no working links. **Like Plaid tokens, pay links depend on the master key**: if
the master key changes, every link stops working. An owner can **Replace link** on an invoice to
invalidate a link that went to the wrong person.

## What gets posted

When Stripe reports a successful payment, Cosimo records, as the **Payment provider** actor:

1. A **payment received** from the customer into **Stripe Clearing** (method `stripe`, reference the
   PaymentIntent ID), applied to the invoice.
2. **Stripe's fee** as a journal entry: debit the fee account, credit Stripe Clearing, with the memo
   "Stripe fee, invoice <number>", dated the day of the payment.

The payment's journal entry reads "Payment from <customer> (<PaymentIntent ID>)", like any payment.
The payment's own memo says how it was paid, for example "Paid online by card, invoice INV-1001".

**The fee often arrives a few seconds after the payment.** Stripe works out the fee shortly after the
charge, often after it has reported the payment. Cosimo then records the payment first and posts the
fee when Stripe's `charge.updated` event arrives, usually within seconds. Without a webhook the fee
is posted on the next check, every 15 minutes. Bank payments settle days later, and their fee is
posted the same way once Stripe reports it.

Stripe takes its fee when the customer pays, not when it pays out, so once the fee is posted Stripe
Clearing matches your Stripe balance: payments less fees (and less refunds and disputes, below). A
payout then moves that net amount to your bank with no fee in it; see [Payouts](#payouts).

Provider payments auto-approve by default, but the org's review threshold and review policies still
apply (add a policy for the **Payment provider** actor to hold them). A payment that doesn't match an
open invoice always waits in the review queue: an unknown invoice, a void or already paid invoice, or
more than the balance due. An overpayment applies the balance to the invoice and leaves the rest as
customer credit once approved.

The same Stripe payment is never recorded twice, whether the webhook, polling, and the customer's
return all see it: each Stripe payment is written once to `provider_payments` in the same
transaction as the payment.

## Refunds and disputes

Refunds and disputes happen in Stripe. Cosimo proposes an entry for each one, and **every one waits
in the review queue**; none posts on its own. They are proposed only for payments Cosimo recorded.

- **Refund** (full or partial, once Stripe reports it succeeded): debit **Refunds and Allowances**,
  credit Stripe Clearing, for the refunded amount, dated the refund, memo "Stripe refund, invoice
  <number>". Stripe keeps its original fee, so no fee entry is posted. The invoice stays paid, and
  its page shows "Refunded $X". Two partial refunds are two entries.
- **Dispute**: when Stripe takes the disputed amount from your balance, debit **Chargebacks** for
  the amount and the fee account for Stripe's dispute fee, credit Stripe Clearing for both. The
  amounts come from the dispute's balance transactions in Stripe. If you win and Stripe returns the
  funds, a reversing entry is proposed (debit Stripe Clearing, credit Chargebacks, and credit the fee
  account too if Stripe returns the fee).

The review card shows the refund or dispute amounts from Stripe next to the entry. Each refund and
each dispute movement is proposed once, however many times the webhook and the checks see it. If you
reject one, Cosimo doesn't propose it again; the invoice page says so, and you book it by hand if
the money did move.

Events for refunds, disputes, and payouts that arrived before this handling existed are processed
once if they are less than 30 days old (Stripe keeps events that long). `cosimo doctor` lists older
ones; check the Stripe dashboard for refunds and disputes from then and book them by hand.

## Payouts

When Stripe pays out to your bank, Cosimo stores the payout (nothing is posted). When a bank deposit
for the same amount shows up within a day before to three days after the payout's arrival date,
Categorize suggests "Stripe payout <date>: transfer from Stripe Clearing". Accept it and the usual
transfer entry moves the amount from Stripe Clearing to the bank account, and the payout is linked to
the deposit. This works whichever arrives first, the payout or the bank transaction. Undoing the
transfer frees the payout to match again.

## Customer cash balances

With Bank Transfers, a customer's transfer that Stripe can't match to a payment (a wrong amount or
reference) stays in the customer's **cash balance** in Stripe, and Stripe returns it after 75 days.
Cosimo reads these balances every 6 hours (up to 200 customers at a time) and when an invoice page is
opened. When Stripe holds money for the invoice's customer, the invoice page says so; resolve it in
Stripe. The instance admin's status page lists every nonzero balance.

## When a pay link shows an error

If a customer sees "Online payment isn't working right now", Stripe refused to create the checkout.
The invoice page shows Stripe's reason and when it happened, and **Settings → Online payments**
shows the latest failure; `cosimo doctor` warns about failures in the last 30 days. For more detail:

1. The error page shows a **Reference**. Search the server log for `pay link failed` with that
   `request_id`.
2. Or open **Developers → Logs** in the Stripe dashboard (in the key's mode) and find the failed
   `POST /v1/checkout/sessions` or `POST /v1/customers` request.

The usual causes:

| Stripe says | Fix |
|---|---|
| `403 more_permissions_required` | Add the named permission to the restricted key (see the table above). |
| `payment method type provided: … is invalid` | Activate that method in Stripe, or turn it off in Cosimo. |

Once the cause is fixed, the customer can open the same link again; there's no need to replace it.
Each failed attempt moves the invoice to a new request key, so Stripe doesn't replay the old error.

## Typical fees

Stripe's standard US pricing at the time of writing (check your Stripe account for yours):

| Method | Fee | Arrives |
|---|---|---|
| Cards | 2.9% + 30¢ | Immediately |
| ACH Direct Debit | 0.8%, capped at $5 | About 4 business days |
| Bank Transfers | 0.5%, capped at $5 | When the customer's transfer arrives |

## Payment link mode

Choose **Payment link** under **Settings → Online payments** to paste a URL from any payment service
on each invoice (**Payment link** in the invoice form). It is printed and linked on the PDF, and the
email says `Pay online: <link>`. Cosimo doesn't know when such a payment is made; record it as usual.

## Status and checks

`cosimo doctor` checks each org's Stripe key, mode, permissions, payment methods, webhook, last
event, and recent pay-link failures. Instance admins also see an **Online payments** card on the
status page: each org's mode, last event, Stripe entries waiting for review, payouts not yet matched
to a deposit, and customer cash balances. It reads only the org databases and calls no Stripe API.
