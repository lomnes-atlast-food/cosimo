# Importing from QuickBooks Online, Xero or Wave

Cosimo can take over your books from QuickBooks Online, Xero or Wave. You export a few CSV files from
the old product and Cosimo reads them. Cosimo shows a dry-run report first and changes nothing until you
confirm.

## What gets imported

- **Chart of accounts**: each account's name, number or code, description and parent account
  (QuickBooks sub-accounts). The product's account type is mapped to a Cosimo type and subtype, such as
  bank, accounts receivable, credit card, owner's draw or cost of goods sold.
- **Contacts**: customers and vendors with email, phone and company. QuickBooks "Track 1099" is kept.
- **History**: every transaction becomes a journal entry with `source_type: import`. It keeps the
  original date, reference number, memo and transaction type (for example "Invoice" or "Bill
  Payment"), and each line keeps its account, amount, description and customer or vendor. The entries
  wait in the review queue as **one batch**: approving it posts them all, and rejecting it rejects them
  all (the same files can then be imported again).

## What does not get imported

- Invoices, bills, estimates and receipts as documents. Their accounting effect arrives as journal
  entries, but you cannot re-send or record payments against an imported invoice. Create open invoices
  and bills again in Cosimo if you still need to collect or pay them.
- Attachments and receipt images.
- Bank connections and bank feed rules. Reconnect your banks in Cosimo (see [plaid.md](plaid.md)).
- Reconciliations and reconciled status.
- Payroll details, inventory quantities, sales tax settings, budgets, tracking categories and classes.

## Before you start

- **Export CSV, not Excel.** Cosimo reads CSV files only. When QuickBooks offers "Export to Excel",
  choose "Export to CSV" instead. If you only have an .xlsx file, open it and save it as CSV.
- Export the **whole history** you want to bring over: set the report period to "All Dates", or from
  your first transaction to today.
- Import files from **one product at a time**. If you mix files from two products, Cosimo reports an
  error and reads only one product's files.
- Menu names can change between product versions. If a menu below looks different, search the product's
  help for the report name.

## QuickBooks Online

Download these three kinds of file:

1. **Account List**: Reports → search "Account List" → run it → Export → Export to CSV.
2. **Customer Contact List** and **Vendor Contact List**: Reports → search "Contact List" → run each
   one → Export to CSV. For 1099 vendors, customize the vendor list to add the "Track 1099" column.
3. **Journal**: Reports → search "Journal" → set the date range to All Dates → Export to CSV.

Use the **Journal** report for history, not the General Ledger report. The General Ledger lists each
transaction once for every account it touches, so it cannot be rebuilt into balanced entries reliably.
Cosimo detects it and asks for the Journal instead.

Leave the report headers (report title, company name, date range) and footers in the file. Cosimo skips
them. Dates must be in the US format `MM/DD/YYYY`.

## Xero

1. **Chart of accounts**: Accounting → Chart of accounts → Export. The file has `*Code`, `*Name`,
   `*Type` columns.
2. **Contacts**: Contacts → All contacts → Export → CSV. Xero doesn't mark contacts as customer or
   supplier in this file, so Cosimo imports them as "both" unless the file has `IsCustomer` and
   `IsSupplier` columns. You can change this afterwards.
3. **Journal Report**: Accounting → Reports → Journal Report → set the date range → Export → CSV.
   Include the journal number, source, reference, account code, debit and credit columns. A
   General Ledger detail export with a journal number column also works.

Dates such as `5 Jan 2026`, `05/01/2026` (day first) and `2026-01-05` are accepted.

## Wave

1. **Accounting transactions**: Settings → Data export → "Export accounting transactions" (CSV).
   Depending on the version, Wave downloads the file or emails you a link. This one file carries the accounts
   (from the Account Name, Account Group and Account Type columns), the transactions (grouped by
   Transaction ID) and the customer and vendor names.
2. Optional: **Customers** and **Vendors**: Sales → Customers → Export, and Purchases → Vendors →
   Export, to also bring over email addresses and phone numbers.

Wave has no account numbers, so accounts are imported without a code.

## Running the import

From the command line:

```sh
cosimo import Account_List.csv Customer_Contact_List.csv Vendor_Contact_List.csv Journal.csv \
  --org <org_id> --dry-run
```

In the web app: Settings → Import & export. Through the API: `POST /api/v1/orgs/{orgId}/imports/product`
with the CSV texts.

The dry-run report shows:

- which product and file type each file was recognized as, and how many rows were read
- the accounts to be created, with their mapped types, and the contacts
- the number of entries, their date range and total debits
- **errors**: files or transactions that will be skipped, with the file name and row number. Examples
  are a transaction whose debits and credits don't match, a date in an unrecognized format, or a
  missing required column.
- **warnings**: things that will be imported but need a look. For example, an account that is used in
  the journal but missing from the chart of accounts. Cosimo creates it and guesses its type from its
  name, such as "Meals" as an expense or "Chase Visa" as a credit card. Check these before you confirm.

Run the import again without `--dry-run` once the report looks right. Accounts and contacts are
created, and the entries go to Review as one batch. Approve it there, or add `--approve` on the command
line to post right away. Importing the same files again adds nothing. Afterwards, compare the Trial
Balance in Cosimo with the old product's trial balance for the same date.
