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
import { listContacts } from "./contacts.ts";
import { createInvoiceTx, type DocLineInput, listInvoices } from "./documents.ts";
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
  description: "The organization this connection can access, with your role in it.",
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
    "Every account (id, code, name, type, subtype, tax line, parent_id) with its posted balance as of a date. Balances are integer cents, debit-positive, and cover the account's own postings only; a parent's balance does not include its sub-accounts (those with parent_id set to it), which share its type, subtype, and tax line. Read org://profile first to learn which accounts this business uses.",
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
    "Run a financial report. Period reports (profit_and_loss, cash_flow, tax_line_summary, general_ledger) use from/to; point-in-time reports (balance_sheet, trial_balance, ar_aging, ap_aging) use as_of; vendor_1099 uses the year of `to`. Amounts are integer cents.",
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
    "Bank and card transactions that are not yet categorized, newest first. Leaves out transactions still pending at the bank (they show up here once posted) and ones already waiting in the review queue (see list_pending_reviews); `pending` gives the count and total of the pending ones. Amounts are integer cents: positive is money in, negative is money out. Pass next_cursor back as cursor for more.",
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
  description: "Search bank transactions by text (description or payee), date range, account, and status.",
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
  description: "A journal entry with its lines (integer cents, debit-positive), status, and source.",
  input: z.object({ entry_id: z.string() }),
  async run(t, i) {
    const e = await getEntry(t.scope.handle.db, i.entry_id);
    if (!e) throw notFound("Entry");
    return e;
  },
});

tool({
  name: "list_entries",
  title: "List journal entries",
  description: "Journal entries in a date range, newest first. Filter by status or source type.",
  input: z.object({
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    status: z.array(z.enum(["draft", "pending_review", "posted", "rejected"])).optional(),
    source_type: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().optional(),
  }),
  async run(t, i) {
    return listEntries(t.scope.handle.db, {
      from: i.from,
      to: i.to,
      status: i.status,
      sourceType: i.source_type,
      limit: i.limit,
      cursor: i.cursor,
    });
  },
});

tool({
  name: "list_contacts",
  title: "List customers and vendors",
  description: "Customers and vendors, optionally filtered by kind or a name search.",
  input: z.object({
    kind: z.enum(["customer", "vendor"]).optional(),
    query: z.string().optional(),
  }),
  async run(t, i) {
    return listContacts(t.scope.handle.db, { kind: i.kind, q: i.query });
  },
});

tool({
  name: "list_invoices",
  title: "List invoices",
  description: "Invoices with status, balance due, and whether they are overdue.",
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
  name: "list_pending_reviews",
  title: "Pending review items",
  description:
    "Proposals waiting for a person to approve, oldest first, including your own. You cannot approve or reject them.",
  input: z.object({ limit: z.number().int().min(1).max(200).default(50), cursor: z.string().optional() }),
  async run(t, i) {
    return listReview(t.scope.handle.db, { status: ["pending"], limit: i.limit, cursor: i.cursor });
  },
});

tool({
  name: "get_review_item",
  title: "Get a review item",
  description:
    "One review item with its status (pending, approved, rejected, expired) and any decision note.",
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
    "Propose the account(s) for a bank transaction. Give one split for the whole amount, or several splits whose positive amounts add up to the transaction's absolute amount. Accounts may be IDs or codes.",
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
    "Propose a rule that categorizes future bank transactions. Conditions: description_contains, description_regex, amount_eq / amount_min / amount_max (absolute cents), direction (in|out), bank_account_id. Actions: account (ID or code), contact_id, memo, auto_post.",
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
    "Propose a balanced journal entry (debits positive, credits negative, integer cents; lines must sum to zero). Use it for adjustments and follow-on entries, such as monthly amortization of a prepaid expense. It goes to the review queue unless a policy approves it.",
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
    "Draft an invoice for a customer. It is held in the review queue; a person approves it (which finalizes it) and decides when to send it. Line amounts are quantity × unit price, in cents.",
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
  name: "append_note",
  title: "Record a bookkeeping note",
  description:
    'Record something durable you learned about how this business keeps its books, for example: "Payments from Acme are retainer billing, account 4010." Notes are dated, attributed to you, and read by future assistants (org://notes). Never include secrets, passwords, or account numbers.',
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
