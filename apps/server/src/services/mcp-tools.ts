/**
 * MCP tools (SPEC §10.2). Each tool validates its input with zod (which also yields the JSON Schema
 * published in `tools/list`) and calls the same services as the REST API, as the `mcp` actor.
 *
 * Writes go through the review policy like any other writer; for the `mcp` actor the default is
 * review, and OAuth grants are always propose-only. Every write tool takes a `rationale` and
 * returns the review item ID and status. There is no tool to approve, reject, void, reverse,
 * delete, or move lock dates.
 */
import type { LineInput } from "@cosimo/core";
import { org } from "@cosimo/db";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context.ts";
import { forbidden, notFound, unprocessable } from "../http/errors.ts";
import type { OrgScope } from "../http/types.ts";
import { listAccounts } from "./accounts.ts";
import {
  categorizeTx,
  countBankTxns,
  listBankAccounts,
  listBankTxns,
  mustGetBankTxn,
  type Split,
} from "./banking.ts";
import { holdBillDraftTx } from "./bill-review.ts";
import { listContacts } from "./contacts.ts";
import { dashboard } from "./dashboard.ts";
import {
  createBillTx,
  createInvoiceTx,
  type DocLineInput,
  finalizeBillTx,
  listBills,
  listInvoices,
  listPayments,
} from "./documents.ts";
import { holdInvoiceDraftTx } from "./invoice-review.ts";
import { getEntry, listEntries, submitEntryTx } from "./ledger.ts";
import { appendNoteTx } from "./notes.ts";
import { REPORT_KEYS, runReport } from "./reports.ts";
import { listReview, mustGetReview, reviewView } from "./review.ts";
import { createRuleTx } from "./rules.ts";

export interface ToolCtx {
  ctx: AppContext;
  scope: OrgScope;
}

interface Tool<S extends z.ZodType> {
  name: string;
  title: string;
  description: string;
  input: S;
  write?: boolean;
  run(t: ToolCtx, input: z.output<S>): Promise<unknown>;
}

const tools: Tool<z.ZodType>[] = [];
function tool<S extends z.ZodType>(t: Tool<S>) {
  tools.push(t as unknown as Tool<z.ZodType>);
}

const Rationale = z
  .string()
  .min(3)
  .max(2000)
  .describe("Why you are proposing this, shown to the person who reviews it. Required.");
const Cents = z.number().int().describe("Integer cents");
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

function requireWriter(t: ToolCtx) {
  if (t.scope.role !== "owner" && t.scope.role !== "bookkeeper")
    throw forbidden("This connection is read-only (its role is not Owner or Bookkeeper).");
}

/** Accept an account ID or code. */
async function accountId(t: ToolCtx, ref: string) {
  const accounts = await listAccounts(t.scope.handle.db);
  const a = accounts.find((x) => x.id === ref) ?? accounts.find((x) => x.code === ref);
  if (!a)
    throw unprocessable(
      `Unknown account ${ref}. Use an account ID or code from get_account_balances.`,
      "unknown_account",
    );
  return a.id;
}

/** One lookup of every account, keyed by ID, for enriching lines with a code and name. */
async function accountLookup(t: ToolCtx) {
  const accounts = await listAccounts(t.scope.handle.db);
  return new Map(accounts.map((a) => [a.id, a]));
}

/** One query for the names of these contacts, archived ones included (list_contacts hides them, but a line referencing one should still show a name). */
async function contactNames(t: ToolCtx, ids: (string | null | undefined)[]) {
  const uniq = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!uniq.length) return new Map<string, string>();
  const rows = await t.scope.handle.db
    .select({ id: org.contacts.id, name: org.contacts.name })
    .from(org.contacts)
    .where(inArray(org.contacts.id, uniq))
    .all();
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Add account_code/account_name (and contact_name when contact_id is set) to a batch of lines. */
function withNames<L extends { account_id: string; contact_id?: string | null }>(
  lines: L[],
  accounts: Map<string, { code: string; name: string }>,
  contacts: Map<string, string>,
) {
  return lines.map((l) => ({
    ...l,
    account_code: accounts.get(l.account_id)?.code ?? null,
    account_name: accounts.get(l.account_id)?.name ?? null,
    ...(l.contact_id ? { contact_name: contacts.get(l.contact_id) ?? null } : {}),
  }));
}

/** Whether each of these targets (same type) has at least one attachment, in one grouped query. */
async function attachmentFlags(t: ToolCtx, targetType: string, ids: string[]) {
  if (!ids.length) return new Map<string, boolean>();
  const rows = await t.scope.handle.db
    .select({ targetId: org.attachmentLinks.targetId })
    .from(org.attachmentLinks)
    .where(and(eq(org.attachmentLinks.targetType, targetType), inArray(org.attachmentLinks.targetId, ids)))
    .all();
  const withAttachment = new Set(rows.map((r) => r.targetId));
  return new Map(ids.map((id) => [id, withAttachment.has(id)]));
}

function outcome(r: {
  reviewItemId?: string | null;
  review_item_id?: string | null;
  entry?: { id: string; status: string };
}) {
  const reviewId = r.reviewItemId ?? r.review_item_id ?? null;
  return {
    status: reviewId ? "pending_review" : (r.entry?.status ?? "done"),
    review_item_id: reviewId,
    entry_id: r.entry?.id ?? null,
    message: reviewId
      ? "Proposed. It is waiting in the review queue for a person to approve; it does not affect the books until then."
      : "Applied: a review policy approved it automatically.",
  };
}

// ---------------------------------------------------------------------------------- read

tool({
  name: "list_orgs",
  title: "List organizations",
  description:
    "The one organization this connection can access, and your role in it. Call this first if you're unsure which org or role you have. To work with a different org, the person must approve a new connection; there is no tool to switch.",
  input: z.object({}),
  async run(t) {
    const reg = await t.ctx.orgs.get(t.scope.id);
    return {
      orgs: [
        {
          id: t.scope.id,
          name: reg?.name ?? "",
          role: t.scope.role,
          propose_only: t.scope.actor.proposeOnly ?? false,
        },
      ],
    };
  },
});

tool({
  name: "get_account_balances",
  title: "Chart of accounts with balances",
  description:
    "Every account (id, code, name, type, subtype, tax line, parent_id) with its posted balance as of a date. Balances are integer cents, debit-positive, and cover the account's own postings only; a parent's balance excludes its sub-accounts (those with parent_id set to it), which share its type, subtype, and tax line. Use this for the chart of accounts and current balances; for a full P&L or balance sheet, or history over a range, use run_report instead. Read org://profile first to learn which accounts this business uses.",
  input: z.object({
    as_of: IsoDate.optional().describe("Defaults to today"),
    include_inactive: z.boolean().default(false),
  }),
  async run(t, i) {
    const rows = await listAccounts(t.scope.handle.db, { withBalances: true, asOf: i.as_of });
    return { accounts: rows.filter((a) => i.include_inactive || a.is_active) };
  },
});

tool({
  name: "run_report",
  title: "Run a report",
  description:
    "Runs a full financial report: profit_and_loss, balance_sheet, trial_balance, cash_flow, tax_line_summary, general_ledger, ar_aging, ap_aging, or vendor_1099. Period reports (profit_and_loss, cash_flow, tax_line_summary, general_ledger) use from/to; point-in-time reports (balance_sheet, trial_balance, ar_aging, ap_aging) use as_of; vendor_1099 uses the year of `to`. Amounts are integer cents. For a quick balance check, use get_cash_snapshot or get_account_balances instead of a full report.",
  input: z.object({
    report: z.enum(REPORT_KEYS),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    as_of: IsoDate.optional(),
    basis: z.enum(["cash", "accrual"]).optional().describe("Defaults to the organization's basis"),
    compare: z.enum(["none", "prior_period", "prior_year", "monthly"]).optional(),
  }),
  async run(t, i) {
    const reg = await t.ctx.orgs.get(t.scope.id);
    const { report, ...p } = i;
    return runReport(t.scope.handle.db, t.scope.id, reg?.name ?? "", report, p);
  },
});

tool({
  name: "list_uncategorized_transactions",
  title: "Bank transactions needing categorization",
  description:
    "Bank and card transactions that are not yet categorized, newest first: what to work through in the monthly close. Leaves out transactions still pending at the bank (they show up here once posted) and ones already waiting in the review queue (see list_pending_reviews); `pending` gives the count and total of the pending ones. Amounts are integer cents: positive is money in, negative is money out. Pass next_cursor back as cursor for more. To find a specific transaction, already categorized or not, use search_transactions instead.",
  input: z.object({
    bank_account_id: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().optional(),
  }),
  async run(t, i) {
    const r = await listBankTxns(t.scope.handle.db, {
      bankAccountId: i.bank_account_id,
      bucket: ["to_categorize"],
      limit: i.limit,
      cursor: i.cursor,
    });
    const counts = await countBankTxns(t.scope.handle.db, { bankAccountId: i.bank_account_id });
    return { bank_accounts: await listBankAccounts(t.scope.handle.db), pending: counts.pending, ...r };
  },
});

tool({
  name: "search_transactions",
  title: "Search bank transactions",
  description:
    "Search bank and card transactions (the bank feed, not the ledger) by text (description or payee), date range, account, and status. For only what still needs a category, use list_uncategorized_transactions instead; for journal entries once posted, use list_entries or get_entry.",
  input: z.object({
    query: z.string().optional(),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    bank_account_id: z.string().optional(),
    status: z.array(z.enum(["new", "categorized", "matched", "transfer", "excluded"])).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().optional(),
  }),
  async run(t, i) {
    return listBankTxns(t.scope.handle.db, {
      q: i.query,
      from: i.from,
      to: i.to,
      bankAccountId: i.bank_account_id,
      status: i.status as never,
      limit: i.limit,
      cursor: i.cursor,
    });
  },
});

tool({
  name: "get_entry",
  title: "Get a journal entry",
  description:
    "One journal entry: its lines (integer cents, debit-positive) with account code/name and, when set, contact name; status; source; and whether a receipt or other file is attached. For several entries, or to find one, use list_entries.",
  input: z.object({ entry_id: z.string() }),
  async run(t, i) {
    const e = await getEntry(t.scope.handle.db, i.entry_id);
    if (!e) throw notFound("Entry");
    const [accounts, contacts, attach] = await Promise.all([
      accountLookup(t),
      contactNames(
        t,
        e.lines.map((l) => l.contact_id),
      ),
      attachmentFlags(t, "journal_entry", [e.id]),
    ]);
    return { ...e, lines: withNames(e.lines, accounts, contacts), has_attachment: attach.get(e.id) ?? false };
  },
});

tool({
  name: "list_entries",
  title: "List journal entries",
  description:
    "Journal entries in a date range, newest first, filtered by status or source type. Each entry's lines carry account code/name and, when set, contact name, plus whether it has an attachment. For bank and card lines, use search_transactions instead.",
  input: z.object({
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    status: z.array(z.enum(["draft", "pending_review", "posted", "rejected"])).optional(),
    source_type: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().optional(),
  }),
  async run(t, i) {
    const r = await listEntries(t.scope.handle.db, {
      from: i.from,
      to: i.to,
      status: i.status,
      sourceType: i.source_type,
      limit: i.limit,
      cursor: i.cursor,
    });
    const [accounts, contacts, attach] = await Promise.all([
      accountLookup(t),
      contactNames(
        t,
        r.data.flatMap((e) => e.lines.map((l) => l.contact_id)),
      ),
      attachmentFlags(
        t,
        "journal_entry",
        r.data.map((e) => e.id),
      ),
    ]);
    return {
      ...r,
      data: r.data.map((e) => ({
        ...e,
        lines: withNames(e.lines, accounts, contacts),
        has_attachment: attach.get(e.id) ?? false,
      })),
    };
  },
});

tool({
  name: "list_contacts",
  title: "List customers and vendors",
  description:
    "Customers and vendors, optionally filtered by kind or a name search. Archived contacts are left out unless include_archived is true; a contact missing from the default list is often archived, not deleted.",
  input: z.object({
    kind: z.enum(["customer", "vendor"]).optional(),
    query: z.string().optional(),
    include_archived: z.boolean().default(false),
  }),
  async run(t, i) {
    return {
      contacts: await listContacts(t.scope.handle.db, {
        kind: i.kind,
        q: i.query,
        includeArchived: i.include_archived,
      }),
    };
  },
});

tool({
  name: "list_invoices",
  title: "List invoices",
  description:
    "Invoices to customers, with status, balance due, and whether each is overdue. For bills from vendors use list_bills instead; there is no tool yet for payments received against invoices.",
  input: z.object({
    status: z.array(z.enum(["draft", "sent", "partial", "paid", "void"])).optional(),
    customer_id: z.string().optional(),
    overdue: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  async run(t, i) {
    return {
      invoices: await listInvoices(t.scope.handle.db, {
        status: i.status,
        customerId: i.customer_id,
        overdue: i.overdue,
        limit: i.limit,
      }),
    };
  },
});

tool({
  name: "list_bills",
  title: "List bills",
  description:
    "Bills from vendors, with balance due and whether each is overdue. Each line carries account code/name, and each bill whether it has an attachment. For invoices to customers, use list_invoices; for payments already recorded against bills, use list_bill_payments.",
  input: z.object({
    status: z.array(z.enum(["draft", "open", "partial", "paid", "void"])).optional(),
    vendor_id: z.string().optional(),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    overdue: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  async run(t, i) {
    // `overdue` is computed per bill, so filter the full list before applying the limit.
    const bills = await listBills(t.scope.handle.db, {
      status: i.status,
      vendorId: i.vendor_id,
      from: i.from,
      to: i.to,
      limit: i.overdue == null ? i.limit : 1000,
    });
    const filtered = (i.overdue == null ? bills : bills.filter((b) => b.overdue === i.overdue)).slice(
      0,
      i.limit,
    );
    const [accounts, attach] = await Promise.all([
      accountLookup(t),
      attachmentFlags(
        t,
        "bill",
        filtered.map((b) => b.id),
      ),
    ]);
    return {
      bills: filtered.map((b) => ({
        ...b,
        lines: withNames(b.lines, accounts, new Map()),
        has_attachment: attach.get(b.id) ?? false,
      })),
    };
  },
});

tool({
  name: "list_bill_payments",
  title: "List payments sent to vendors",
  description:
    "Payments this business has sent to vendors, each with the bills it was applied to. There is no tool yet for payments received from customers. For the bills themselves, use list_bills.",
  input: z.object({
    vendor_id: z.string().optional(),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  async run(t, i) {
    const payments = await listPayments(t.scope.handle.db, {
      direction: "sent",
      contactId: i.vendor_id,
      // listPayments has no date filter, so filter the full list before applying the limit.
      limit: i.from || i.to ? 1000 : i.limit,
    });
    return {
      payments: payments
        .filter((p) => (!i.from || p.date >= i.from) && (!i.to || p.date <= i.to))
        .slice(0, i.limit),
    };
  },
});

tool({
  name: "get_cash_snapshot",
  title: "Cash and business snapshot",
  description:
    "One overview: cash and card balances, this month's and year-to-date income/expense, review-queue and uncategorized-transaction counts, overdue invoices, and bills overdue or due soon. Good for a quick 'how are we doing' check; for a full P&L or balance sheet use run_report, and for one account's balance use get_account_balances.",
  input: z.object({ as_of: IsoDate.optional().describe("Defaults to today") }),
  async run(t, i) {
    return dashboard(t.scope.handle.db, t.scope.id, i.as_of);
  },
});

tool({
  name: "list_pending_reviews",
  title: "Pending review items",
  description:
    "Proposals waiting for a person to approve, oldest first, including your own. You cannot approve, reject, or otherwise act on them; tell the person what's waiting instead. For one item's status once you have its ID, use get_review_item.",
  input: z.object({ limit: z.number().int().min(1).max(200).default(50), cursor: z.string().optional() }),
  async run(t, i) {
    return listReview(t.scope.handle.db, { status: ["pending"], limit: i.limit, cursor: i.cursor });
  },
});

tool({
  name: "get_review_item",
  title: "Get a review item",
  description:
    "One review item: its status (pending, approved, rejected, expired), the proposed payload, and any decision note left when it was decided. To find items rather than look one up by ID, use list_pending_reviews instead.",
  input: z.object({ review_item_id: z.string() }),
  async run(t, i) {
    return reviewView(await mustGetReview(t.scope.handle.db, i.review_item_id));
  },
});

// ---------------------------------------------------------------------------------- write

tool({
  name: "categorize_transaction",
  title: "Categorize a bank transaction",
  description:
    "Propose the account(s) for a bank or card transaction from list_uncategorized_transactions or search_transactions. Give one split for the whole amount, or several splits whose positive amounts add up to the transaction's absolute amount. Accounts may be IDs or codes. Refuses a transaction that isn't open to categorize (already categorized, matched, or excluded); to fix one of those, tell the person instead.",
  write: true,
  input: z.object({
    transaction_id: z.string(),
    splits: z
      .array(
        z.object({
          account: z.string().describe("Account ID or code"),
          amount: Cents.positive().optional().describe("Positive cents; omit when there is one split"),
          description: z.string().optional(),
          contact_id: z.string().optional(),
        }),
      )
      .min(1),
    memo: z.string().optional(),
    contact_id: z.string().optional(),
    rationale: Rationale,
  }),
  async run(t, i) {
    requireWriter(t);
    const txn = await mustGetBankTxn(t.scope.handle.db, i.transaction_id);
    if (i.splits.length > 1 && i.splits.some((s) => s.amount == null))
      throw unprocessable("Give an amount for every split when there is more than one.", "invalid_amount");
    const splits: Split[] = [];
    for (const s of i.splits)
      splits.push({
        account_id: await accountId(t, s.account),
        amount: s.amount ?? Math.abs(txn.amount),
        description: s.description ?? null,
        contact_id: s.contact_id ?? null,
      });
    const r = await t.scope.handle.write((tx) =>
      categorizeTx(tx, t.scope.id, t.scope.actor, i.transaction_id, {
        splits,
        memo: i.memo ?? null,
        contact_id: i.contact_id ?? null,
        rationale: i.rationale,
      }),
    );
    return outcome(r);
  },
});

tool({
  name: "create_rule",
  title: "Propose a categorization rule",
  description:
    "Propose a rule that categorizes future bank transactions matching its conditions. Conditions: description_contains, description_regex, amount_eq / amount_min / amount_max (absolute cents), direction (in|out), bank_account_id. Actions: account (ID or code), contact_id, memo, auto_post. Use this once a payee recurs with the same category; for a single transaction, use categorize_transaction instead.",
  write: true,
  input: z.object({
    name: z.string().min(1).max(200),
    conditions: z.object({
      description_contains: z.string().optional(),
      description_regex: z.string().max(200).optional(),
      amount_eq: Cents.optional(),
      amount_min: Cents.optional(),
      amount_max: Cents.optional(),
      direction: z.enum(["in", "out"]).optional(),
      bank_account_id: z.string().optional(),
    }),
    actions: z.object({
      account: z.string().optional().describe("Account ID or code"),
      contact_id: z.string().optional(),
      memo: z.string().optional(),
      auto_post: z.boolean().default(false),
    }),
    rationale: Rationale,
  }),
  async run(t, i) {
    requireWriter(t);
    const { account, ...actions } = i.actions;
    const account_id = account ? await accountId(t, account) : undefined;
    const r = await t.scope.handle.write((tx) =>
      createRuleTx(tx, t.scope.id, t.scope.actor, {
        name: i.name,
        conditions: i.conditions,
        actions: { ...actions, account_id },
        rationale: i.rationale,
      }),
    );
    return {
      rule_id: r.rule.id,
      status: r.review_item_id ? "pending_review" : "active",
      review_item_id: r.review_item_id,
      message: r.review_item_id
        ? "Proposed. The rule stays inactive until a person approves it in the review queue."
        : "Created.",
    };
  },
});

tool({
  name: "create_manual_entry",
  title: "Propose a journal entry",
  description:
    "Propose a balanced journal entry (debits positive, credits negative, integer cents; lines must sum to zero). Use it for adjustments and follow-on entries, such as monthly amortization of a prepaid expense. It goes to the review queue unless a policy approves it. To correct an entry that's already posted, explain what's wrong to the person instead; reversing or replacing a posted entry isn't available through MCP yet.",
  write: true,
  input: z.object({
    date: IsoDate,
    memo: z.string().max(500).optional(),
    lines: z
      .array(
        z.object({
          account: z.string().describe("Account ID or code"),
          amount: Cents.describe("Debit positive, credit negative"),
          description: z.string().optional(),
          contact_id: z.string().optional(),
        }),
      )
      .min(2),
    rationale: Rationale,
  }),
  async run(t, i) {
    requireWriter(t);
    const lines: LineInput[] = [];
    for (const l of i.lines)
      lines.push({
        accountId: await accountId(t, l.account),
        amount: l.amount,
        description: l.description ?? null,
        contactId: l.contact_id ?? null,
      });
    const r = await t.scope.handle.write((tx) =>
      submitEntryTx(tx, t.scope.id, t.scope.actor, {
        date: i.date,
        memo: i.memo ?? null,
        lines,
        rationale: i.rationale,
      }),
    );
    return outcome(r);
  },
});

tool({
  name: "create_invoice_draft",
  title: "Propose an invoice draft",
  description:
    "Draft an invoice for a customer. It is held in the review queue; a person approves it (which finalizes it, posting Accounts Receivable) and decides when to send it. Line amounts are quantity × unit price, in cents. For a bill from a vendor use create_bill_draft instead.",
  write: true,
  input: z.object({
    customer_id: z.string(),
    issue_date: IsoDate,
    due_date: IsoDate.optional(),
    memo: z.string().max(2000).optional(),
    lines: z
      .array(
        z.object({
          description: z.string().min(1),
          quantity: z.number().positive().default(1),
          unit_price: Cents.nonnegative(),
          account: z.string().describe("Income account ID or code"),
        }),
      )
      .min(1),
    rationale: Rationale,
  }),
  async run(t, i) {
    requireWriter(t);
    const lines: DocLineInput[] = [];
    for (const l of i.lines)
      lines.push({
        description: l.description,
        quantity_milli: Math.round(l.quantity * 1000),
        unit_price: l.unit_price,
        account_id: await accountId(t, l.account),
      });
    return t.scope.handle.write(async (tx) => {
      const inv = await createInvoiceTx(tx, t.scope.id, t.scope.actor, {
        customer_id: i.customer_id,
        issue_date: i.issue_date,
        due_date: i.due_date ?? null,
        memo: i.memo ?? null,
        lines,
      });
      const reviewId = await holdInvoiceDraftTx(tx, t.scope.id, t.scope.actor, inv.id, i.rationale);
      return {
        invoice_id: inv.id,
        number: inv.number,
        total: inv.total,
        status: "pending_review",
        review_item_id: reviewId,
        message:
          "Drafted. It waits in the review queue; nothing is posted or sent until a person approves it.",
      };
    });
  },
});

tool({
  name: "create_bill_draft",
  title: "Propose a bill draft",
  description:
    "Draft a bill from a vendor. It is held in the review queue; a person approves it (which finalizes it, posting Accounts Payable). Each line is a description, an amount in cents, and an expense (or asset/liability) account. The vendor must be a contact marked vendor or both, not customer-only. For an invoice to a customer use create_invoice_draft instead.",
  write: true,
  input: z.object({
    vendor_id: z.string(),
    bill_number: z.string().optional(),
    issue_date: IsoDate,
    due_date: IsoDate.optional(),
    memo: z.string().max(2000).optional(),
    lines: z
      .array(
        z.object({
          description: z.string().min(1),
          amount: Cents.positive(),
          account: z.string().describe("Expense (or asset/liability) account ID or code"),
        }),
      )
      .min(1),
    rationale: Rationale,
  }),
  async run(t, i) {
    requireWriter(t);
    const lines: DocLineInput[] = [];
    for (const l of i.lines)
      lines.push({ description: l.description, amount: l.amount, account_id: await accountId(t, l.account) });
    return t.scope.handle.write(async (tx) => {
      const { bill } = await createBillTx(tx, t.scope.id, t.scope.actor, {
        vendor_id: i.vendor_id,
        bill_number: i.bill_number ?? null,
        issue_date: i.issue_date,
        due_date: i.due_date ?? null,
        memo: i.memo ?? null,
        lines,
        draft: true,
      });
      const reviewId = await holdBillDraftTx(tx, t.scope.id, t.scope.actor, bill.id, i.rationale);
      if (reviewId)
        return {
          bill_id: bill.id,
          bill_number: bill.billNumber,
          total: bill.total,
          status: "pending_review",
          review_item_id: reviewId,
          entry_id: null,
          message: "Drafted. It waits in the review queue; nothing is posted until a person approves it.",
        };
      // A review policy approved it: finalize now, as approving the review item would.
      const r = await finalizeBillTx(tx, t.scope.id, t.scope.actor, bill.id, { forcePost: true });
      return {
        bill_id: bill.id,
        bill_number: bill.billNumber,
        total: bill.total,
        status: "open",
        review_item_id: null,
        entry_id: r.entry.id,
        message:
          "Applied: a review policy approved it automatically, so the bill is posted to Accounts Payable.",
      };
    });
  },
});

tool({
  name: "append_note",
  title: "Record a bookkeeping note",
  description:
    'Record something durable you learned about how this business keeps its books, for example: "Payments from Acme are retainer billing, account 4010." Notes are dated, attributed to you, and read by future assistants (org://notes). Applies right away; it is not a proposal and does not go to the review queue. Never include secrets, passwords, or account numbers. For something specific to one write, put it in that tool\'s rationale instead of a note.',
  write: true,
  input: z.object({ note: z.string().min(3).max(10_000) }),
  async run(t, i) {
    requireWriter(t);
    const n = await t.scope.handle.write((tx) => appendNoteTx(tx, t.scope.id, t.scope.actor, i.note));
    return { note_id: n.id, created_at: n.created_at, message: "Noted." };
  },
});

export function listTools() {
  return tools.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: z.toJSONSchema(t.input, { io: "input" }),
    annotations: {
      title: t.title,
      readOnlyHint: !t.write,
      destructiveHint: false,
      idempotentHint: !t.write,
      openWorldHint: false,
    },
  }));
}

export function registerMcpTool<S extends z.ZodType>(t: Tool<S>) {
  tool(t);
}

export class ToolInputError extends Error {}

export async function callTool(t: ToolCtx, name: string, args: unknown) {
  const def = tools.find((x) => x.name === name);
  if (!def) return null;
  const parsed = def.input.safeParse(args ?? {});
  if (!parsed.success)
    throw new ToolInputError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "),
    );
  return def.run(t, parsed.data);
}
