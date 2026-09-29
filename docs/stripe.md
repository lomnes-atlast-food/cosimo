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

Every permission in the table is needed. **Test connection doesn't catch a missing permission yet**
([#58](https://github.com/steve-lomnes/cosimo/issues/58)). It only proves the key can read, so a key
without, say, Customers write passes. The first customer to open a pay link then gets an error page,
and Stripe's log shows `403 more_permissions_required`. Check the table before you save.

A full secret key (`sk_...`) also works, but a restricted key (`rk_...`) limits what a leaked key can
do. Publishable keys (`pk_...`) are rejected.

Start with a **test mode** key (`rk_test_...`). Pay links then open Stripe's test Checkout, where the
card `4242 4242 4242 4242` with any future date and CVC succeeds. The invoice page and the settings
show a **Test mode** badge. Switch to a live key when you're ready.

Test mode and live mode are separate in Stripe: each has its own keys, payment method settings,
webhooks, and customers. If you switch an organization between a test key and a live key, invoices
for customers who already opened a pay link can fail with "No such customer", because Cosimo reuses
the Stripe customer from the other mode ([#58](https://github.com/steve-lomnes/cosimo/issues/58)). To
test live after testing in test mode, or the other way round, use a new customer contact.

## 2. Add the key to Cosimo

As an org owner, open **Settings → Online payments**, choose **Stripe**, paste the key, and save.
Only owners see this tab; AI assistants can't change it.

- Cosimo checks the key with Stripe before storing it, and **Test connection** checks it again at
  any time.
- The key is encrypted with the instance master key (AES-256-GCM). It never appears in API
  responses, logs, the audit log, or exports.
- Choose the payment methods to offer. Cosimo and the Stripe dashboard use different names for
  them:

  | Stripe dashboard | Cosimo setting | Stripe API type |
  |---|---|---|
  | Cards | card | `card` |
  | ACH Direct Debit | ACH Direct Debit | `us_bank_account` |
  | Bank Transfers | bank transfer | `customer_balance` |

  **Each method you offer must be active in Stripe first**, under **Settings → Payments → Payment
  methods**, in the same mode as the key (test and live are set separately). Stripe rejects the
  whole checkout if any offered method isn't active, so card payments fail too. The error in
  Stripe's log is `The payment method type provided: customer_balance is invalid`. Save doesn't check
  this yet ([#58](https://github.com/steve-lomnes/cosimo/issues/58)).

  **Link**, Stripe's saved-card wallet, can appear with card and is recorded as a card payment.
- On first setup Cosimo creates a **Stripe Clearing** asset account (code 1090, or the next free
  code) and uses **6300 Bank and Merchant Fees** for Stripe's fees, creating it if your chart doesn't
  have it. You can pick other accounts instead.
- **Accept online payment on new invoices by default** turns the link on for new invoices. Each
  invoice has its own switch.

Payment methods are chosen for the whole organization, not per invoice.

## Webhooks, or polling

- **Automatic webhook**: when the instance has a public HTTPS URL (`server.public_url`), saving the
  key registers `https://<your-host>/api/v1/webhooks/payments/stripe/<org-id>` in your Stripe account
  and stores its signing secret. Changing the key or turning Stripe off deletes that endpoint.
- **Manual webhook**: if the key can't create webhook endpoints, add an endpoint for the same URL in
  the Stripe dashboard (events `checkout.session.*`, `payment_intent.succeeded`,
  `payment_intent.payment_failed`, `charge.refunded`, `charge.dispute.created`, `payout.paid`), then
  paste its signing secret (`whsec_...`) under **Settings → Online payments**.
- **Polling**: without a webhook (for example on a local instance), Cosimo asks Stripe every 15
  minutes about invoices with an open or processing checkout. With a webhook it still checks every 6
  hours as a safety net. A customer who finishes Checkout is sent back to the pay link, which
  records the payment right away, webhook or not.

Every webhook's `Stripe-Signature` is checked (HMAC-SHA256 with the signing secret, at most 5 minutes
old); unsigned or altered requests get `401` and are not stored. Each event is stored once, so a
redelivery does nothing.

## What the customer sees

The invoice PDF gets a **PAY ONLINE** section with a clickable link, and the invoice email and
reminders say `Pay online: <link>`. The link is
`https://<your-host>/pay/<org-id>/<token>`:

- For an open invoice it goes straight to Checkout for the **balance due**, so after a partial
  payment the next checkout is for the rest.
- Stripe won't take less than **$0.50** through Checkout. An invoice with a smaller balance due can't
  be paid online, and its link shows an error page. Ask for another payment method instead.
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

**The fee usually arrives later than the payment.** Stripe works out the fee a few seconds after the
charge, often after it has reported the payment. Cosimo then records the payment first and posts the
fee on its next scheduled check, which runs every 6 hours when webhooks are on (every 15 minutes
without). Until then, Stripe Clearing shows the full payment rather than Stripe's net. Making this
immediate is tracked in [#58](https://github.com/steve-lomnes/cosimo/issues/58). Bank payments
settle days later, and their fee is posted the same way once Stripe reports it.

Stripe takes its fee when the customer pays, not when it pays out, so once the fee is posted Stripe
Clearing matches your Stripe balance: payments less fees. A payout then moves that net amount to
your bank with no fee in it. Until payout matching arrives, record each payout as a transfer from
Stripe Clearing to checking when it shows up in the bank feed.

Provider payments auto-approve by default, but the org's review threshold and review policies still
apply (add a policy for the **Payment provider** actor to hold them). A payment that doesn't match an
open invoice always waits in the review queue: an unknown invoice, a void or already paid invoice, or
more than the balance due. An overpayment applies the balance to the invoice and leaves the rest as
customer credit once approved.

The same Stripe payment is never recorded twice, whether the webhook, polling, and the customer's
return all see it: each Stripe payment is written once to `provider_payments` in the same
transaction as the payment.

Refunds, disputes, and payouts are received and stored, but nothing is posted for them yet; handle
them by hand for now.

## When a pay link shows an error

If a customer sees "Online payment isn't working right now", Stripe refused to create the checkout.
Cosimo doesn't show this on the invoice yet
([#58](https://github.com/steve-lomnes/cosimo/issues/58)); to find the reason:

1. Search the server log for `pay link failed`. The message is Stripe's.
2. Or open **Developers → Logs** in the Stripe dashboard (in the key's mode) and find the failed
   `POST /v1/checkout/sessions` or `POST /v1/customers` request.

The usual causes:

| Stripe says | Fix |
|---|---|
| `403 more_permissions_required` | Add the named permission to the restricted key (see the table above). |
| `payment method type provided: … is invalid` | Activate that method in Stripe, or turn it off in Cosimo. |
| The amount is below the minimum | The balance due is under $0.50. Ask for another payment method. |

**After fixing the cause, use Replace link on the invoice** (or wait 24 hours). Cosimo retries with
the same request key, and Stripe returns the stored error for that key for 24 hours, even once the
cause is fixed. Stripe's log shows this as a request with an **Original request** field. A new
link gets a new key. Send the customer the new link, because the old one stops working.

## Typical fees

Stripe's standard US pricing at the time of writing (check your Stripe account for yours):

| Method | Fee | Arrives |
|---|---|---|
| Card | 2.9% + 30¢ | Immediately |
| ACH Direct Debit | 0.8%, capped at $5 | About 4 business days |
| Bank transfer | 0.5%, capped at $5 | When the customer's transfer arrives |

## Payment link mode

Choose **Payment link** under **Settings → Online payments** to paste a URL from any payment service
on each invoice (**Payment link** in the invoice form). It is printed and linked on the PDF, and the
email says `Pay online: <link>`. Cosimo doesn't know when such a payment is made; record it as usual.

## Not yet

Refund and dispute handling, matching Stripe payouts in Categorize, and a Stripe status card for
instance admins come in a later release. `cosimo doctor` already checks each org's Stripe key, mode,
webhook, and last event.

Known gaps, tracked in [#58](https://github.com/steve-lomnes/cosimo/issues/58):

- Test connection and Save don't check write permissions or payment method activation.
- Pay-link errors appear only in the server log.
- Fees wait for the next scheduled check.
- A failed checkout's error is replayed for 24 hours.
- Stripe customers aren't kept per mode.
