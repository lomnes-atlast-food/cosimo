---
name: cosimo-bookkeeping
description: Do bookkeeping in a Cosimo instance over MCP. Covers the monthly close (categorize, reconcile, review, soft lock), invoice follow-up, and the year-end package. Use when the user asks to categorize transactions, close a month, chase invoices, or prepare year-end books in Cosimo.
---

# Bookkeeping with Cosimo

Cosimo is self-hosted double-entry bookkeeping. You work in one organization through its MCP
server (`<instance>/mcp`). Everything you write is a **proposal**: it waits in the review queue
until a person approves it. You can't approve, reject, void, reverse, delete, or change lock dates,
so don't offer to.

## Before anything else

1. `list_orgs`: confirm which organization and role you have. Say so if the role is read-only
   (Accountant or Viewer).
2. Read the resource `org://profile`: what the business does, how it bills, typical customers and
   vendors, and which account to use for recurring items. It is the main source for categorizing.
3. Read `org://notes`: what people and earlier assistants learned about these books.
4. `get_account_balances`: the chart of accounts. Refer to accounts by **code** (for example
   `6100`) in tool calls.

## Conventions

- Money is integer **cents**. `123456` is $1,234.56.
- Journal lines are debit-positive and credit-negative, and every entry's lines sum to zero.
- Bank amounts are positive for money in and negative for money out. When you categorize, give
  positive split amounts that add up to the transaction's absolute amount.
- Every write tool needs a `rationale`: one or two plain sentences a person can check quickly,
  such as "Monthly Adobe subscription; the profile lists Adobe under Software (6150)." Mention the
  evidence, not your confidence.
- Write tools return `status` and `review_item_id`. `pending_review` means waiting for a person;
  anything else means a review policy approved it automatically.

## Monthly close

Work one month at a time, oldest first.

1. **See what's open.** Call `list_uncategorized_transactions` (page with `cursor`) and
   `list_pending_reviews`, so you don't propose something twice.
2. **Categorize.** For each transaction:
   - Match the payee against the profile's recurring items and the notes first.
   - Use `search_transactions` with the payee to see how earlier ones were categorized.
   - Then call `categorize_transaction` with one split, or several for a mixed purchase, and a
     `contact_id` when the payee is a known customer or vendor (`list_contacts`).
   - If you can't tell, leave it and list it for the person with your best guess. Don't guess
     into a real account. Uncategorized is better than wrong.
3. **Rules for repeats.** When the same payee recurs with the same account, propose a rule with
   `create_rule` (conditions `description_contains`, optionally `direction` and
   `bank_account_id`; action `account`). Leave `auto_post` off unless the person asks.
4. **Follow-on entries.** Some categorizations imply another entry. Propose it with
   `create_manual_entry` and explain the link in the rationale. For example:
   - An annual prepaid subscription: book it to Prepaid Expenses, then one amortization entry per
     month.
   - A late payment with a fee: book the fee separately.
   - A loan payment: split it into principal and interest.
5. **Check.** Run `run_report` for `profit_and_loss` (the month) and `balance_sheet` (month end).
   Flag anything odd, such as negative cash, a large uncategorized balance, or an expense account
   far above its usual level.
6. **Hand over.** Tell the person, for example: "I proposed 23 categorizations, 2 rules, and 1
   amortization entry for March. They're in Review. After you approve them, reconcile each account
   against its statement and set a soft lock through March 31." Reconciliation and lock dates are
   done by the person in the web app.
7. **Remember.** When you learn something durable, record it with `append_note`, for example
   "Stripe payouts are gross of fees; fees are booked monthly to 6120." Never put account numbers,
   passwords, or other secrets in notes.

## Invoice follow-up

1. `list_invoices` with `overdue: true`. Sort by days overdue and balance due.
2. For each, draft a short, polite reminder for the person to send. Cosimo already emails weekly
   overdue reminders when SMTP is set up, so don't duplicate those.
3. If a payment arrived in the bank but isn't applied (an uncategorized deposit that matches an
   invoice total), tell the person so they can record the payment against the invoice. Don't
   categorize it to income, which would count the revenue twice.
4. For new work the person describes, propose an invoice with `create_invoice_draft` (customer,
   lines with quantity, unit price in cents, and income account code). Approving it finalizes the
   invoice. Sending it stays with the person.

## Year-end package

1. Make sure every month is closed: no uncategorized transactions, no pending reviews, and each
   bank account reconciled through year end. Ask the person to confirm the reconciliations.
   Transactions still pending at the bank aren't categorizable and don't block this checklist item.
2. Review the year: `run_report` for `profit_and_loss` (the fiscal year, compare `prior_year`),
   `balance_sheet` at year end, `tax_line_summary`, and `vendor_1099` (contractors paid $600 or
   more need a 1099 and a W-9 on file).
3. Propose year-end adjustments with `create_manual_entry`, each with a clear rationale. Examples
   are depreciation, accrued expenses, and a correction to owner's draw.
4. Once the adjustments are approved, tell the person to download the package from Reports →
   Year-end package. It holds the P&L, balance sheet, trial balance, general ledger, tax line
   summary, 1099 summary, AR/AP aging and final-month reconciliations as PDF and CSV. It also
   holds `chain.json` with the ledger's hash-chain head. Suggest keeping it with the tax return.
   The head hash lets anyone later check that the books haven't been rewritten.
5. Suggest a hard lock through year end once the return is filed. Only an owner can set it.

## Things to avoid

- Don't re-propose items that are already pending or were rejected. Read the decision note with
  `get_review_item` and adjust.
- Don't create entries to make a report "look right" without a real transaction or a documented
  reason.
- Don't touch periods before a lock date. The tools will refuse, so tell the person instead.
- Don't paste secrets, full account numbers, or other people's personal data into rationales or
  notes.
