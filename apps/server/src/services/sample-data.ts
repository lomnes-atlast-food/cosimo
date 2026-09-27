/**
 * Demo organization for `cosimo init` with `sample_data: true` (SPEC §13.3): a consulting business
 * with three months of checking and credit card activity, two auto-posting rules, a customer, a
 * vendor, an owner contribution, one paid-for-later invoice, and a few bank transactions left
 * uncategorized so Categorize has work in it. Everything goes through the normal services, so the
 * demo books are posted, chained, and audited like real ones.
 */
import { org } from "@cosimo/db";
import { addDays, addMonths, today } from "@cosimo/shared";
import type { AppContext } from "../context.ts";
import { userActor } from "./actor.ts";
import { createBankAccountTx } from "./banking.ts";
import { createContactTx } from "./contacts.ts";
import { createInvoiceTx, finalizeInvoiceTx } from "./documents.ts";
import { commitImportTx } from "./imports.ts";
import { submitEntryTx } from "./ledger.ts";
import { createRuleTx } from "./rules.ts";

export const SAMPLE_ORG_NAME = "Demo Studio (sample data)";

/** Checking and card activity for one month, relative to its first day. */
function monthRows(first: string) {
  const d = (n: number) => addDays(first, n);
  return {
    checking: [
      [d(2), "NORTHWIND TRADERS ACH PAYMENT", 850000],
      [d(4), "ADOBE *CREATIVE CLOUD", -5999],
      [d(9), "COMCAST BUSINESS INTERNET", -12900],
      [d(14), "CONTOSO LTD WIRE", 420000],
      [d(19), "USPS PO 1234", -1865],
      [d(24), "TRANSFER TO OWNER", -300000],
    ],
    card: [
      [d(3), "FIGMA MONTHLY", -4500],
      [d(11), "BLUE BOTTLE COFFEE", -1275],
      [d(17), "DELTA AIR LINES", -38420],
    ],
  } as const;
}

function csv(rows: readonly (readonly [string, string, number])[]) {
  const body = rows.map(([date, desc, cents]) => `${date},${desc},${(cents / 100).toFixed(2)}`);
  return ["Date,Description,Amount", ...body].join("\n");
}

export async function loadSampleData(ctx: AppContext, adminUserId: string) {
  const existing = await ctx.orgs.listForUser(adminUserId);
  if (existing.some((o) => o.name === SAMPLE_ORG_NAME)) return;
  const start = addMonths(today().slice(0, 8).concat("01"), -3);
  const { id: orgId } = await ctx.orgs.create({
    name: SAMPLE_ORG_NAME,
    createdBy: adminUserId,
    entityType: "single_member_llc",
    coaTemplate: "schedule_c",
    basis: "accrual",
    booksStartDate: start,
  });
  const handle = await ctx.orgs.mustOpen(orgId);
  const a = userActor(adminUserId, "owner");

  await handle.write(async (tx) => {
    const accounts = await tx
      .select({ id: org.accounts.id, code: org.accounts.code })
      .from(org.accounts)
      .all();
    const acct = (code: string) => {
      const found = accounts.find((x) => x.code === code);
      if (!found) throw new Error(`Sample data: account ${code} is missing from the template`);
      return found.id;
    };

    const checking = await createBankAccountTx(tx, orgId, a, {
      name: "Business Checking",
      kind: "checking",
      mask: "4321",
    });
    const card = await createBankAccountTx(tx, orgId, a, {
      name: "Business Card",
      kind: "credit_card",
      mask: "9876",
    });
    const checkingLedger = checking.ledgerAccountId;

    const northwind = await createContactTx(tx, orgId, a, {
      kind: "customer",
      name: "Northwind Traders",
      email: "ap@northwind.example",
    });
    await createContactTx(tx, orgId, a, {
      kind: "vendor",
      name: "Figma",
      default_account_id: acct("6100"),
    });

    // The owner is entering these, so they post rather than wait behind the review threshold.
    await submitEntryTx(
      tx,
      orgId,
      a,
      {
        date: start,
        memo: "Owner's startup contribution",
        lines: [
          { accountId: checkingLedger, amount: 1_500_000 },
          { accountId: acct("3100"), amount: -1_500_000 },
        ],
      },
      { forcePost: true },
    );

    const rule = (name: string, contains: string, code: string) =>
      createRuleTx(tx, orgId, a, {
        name,
        conditions: { description_contains: contains, direction: "out" },
        actions: { account_id: acct(code), auto_post: true },
      });
    await rule("Adobe is software", "ADOBE", "6100");
    await rule("Comcast is internet", "COMCAST", "6195");
    await rule("Figma is software", "FIGMA", "6100");

    const checkingRows: [string, string, number][] = [];
    const cardRows: [string, string, number][] = [];
    for (let m = 0; m < 3; m++) {
      const month = monthRows(addMonths(start, m));
      checkingRows.push(...month.checking.map((r) => [...r] as [string, string, number]));
      cardRows.push(...month.card.map((r) => [...r] as [string, string, number]));
    }
    const past = (r: [string, string, number]) => r[0] <= today();
    await commitImportTx(tx, orgId, a, checking.id, {
      filename: "demo-checking.csv",
      content: csv(checkingRows.filter(past)),
    });
    await commitImportTx(tx, orgId, a, card.id, {
      filename: "demo-card.csv",
      content: csv(cardRows.filter(past)),
    });

    const invoice = await createInvoiceTx(tx, orgId, a, {
      customer_id: northwind.id,
      issue_date: addDays(today(), -10),
      terms: "Net 30",
      memo: "Thank you for your business.",
      lines: [
        {
          description: "Brand strategy workshop",
          quantity_milli: 1000,
          unit_price: 350_000,
          account_id: acct("4010"),
        },
        {
          description: "Design sprint (days)",
          quantity_milli: 3000,
          unit_price: 120_000,
          account_id: acct("4010"),
        },
      ],
    });
    await finalizeInvoiceTx(tx, orgId, a, invoice.id, { forcePost: true });
  });
  return orgId;
}
