import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { runReminders } from "../src/jobs/document-jobs.ts";
import type { ActorInfo } from "../src/services/actor.ts";
import { allocateSigned } from "../src/services/cash-basis.ts";
import { lineAmount, voidInvoiceTx } from "../src/services/documents.ts";
import type { Mailer, SentMail } from "../src/services/mailer.ts";
import { addMember, type Client, createOrg, createTestEnv, DB_MODE, login, type TestEnv } from "./harness.ts";

let env: TestEnv;
let owner: Client;
let orgId: string;
let acct: Record<string, string>;
let mail: SentMail[];
let customer: string;
let vendor: string;
const base = () => `/api/v1/orgs/${orgId}`;

async function newInvoice(amounts: number[], date = "2026-01-10", extra: Record<string, unknown> = {}) {
  const r = await owner.json("POST", `${base()}/invoices`, {
    customer_id: customer,
    issue_date: date,
    lines: amounts.map((a, i) => ({
      description: `Service ${i + 1}`,
      quantity_milli: 1000,
      unit_price: a,
      account_id: acct["4000"],
    })),
    ...extra,
  });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body;
}

async function finalize(id: string) {
  return owner.json("POST", `${base()}/invoices/${id}/finalize`, {});
}

async function pay(
  amount: number,
  applications: { document_id: string; amount: number }[],
  date = "2026-02-01",
  direction = "received",
  contact = customer,
) {
  return owner.json("POST", `${base()}/payments`, {
    direction,
    contact_id: contact,
    date,
    amount,
    account_id: acct["1000"],
    applications,
  });
}

async function report(key: string, q: string) {
  return (await owner.json("GET", `${base()}/reports/${key}?${q}`)).body;
}

const line = (r: any, label: string) => r.lines.find((l: any) => l.label === label)?.values[0];

beforeAll(async () => {
  env = await createTestEnv();
  mail = (env.ctx.services.mailer as Mailer).useTestTransport();
  owner = await login(env, "ar-owner@example.com");
  orgId = await createOrg(env, owner, "Docs Co", { basis: "accrual" });
  const r = await owner.json("GET", `${base()}/accounts`);
  acct = Object.fromEntries(r.body.data.map((a: any) => [a.code, a.id]));
  customer = (
    await owner.json("POST", `${base()}/contacts`, {
      kind: "customer",
      name: "Globex",
      email: "ap@globex.test",
    })
  ).body.id;
  vendor = (
    await owner.json("POST", `${base()}/contacts`, {
      kind: "vendor",
      name: "Initech Contractors",
      is_1099_vendor: true,
      tax_id_last4: "4321",
    })
  ).body.id;
});
afterAll(async () => {
  await env.close();
});

describe("pure helpers", () => {
  test("line amounts round half away from zero", () => {
    expect(lineAmount(1000, 1999)).toBe(1999);
    expect(lineAmount(12_500, 15_000)).toBe(187_500);
    expect(lineAmount(333, 100)).toBe(33);
    expect(lineAmount(500, 1)).toBe(1);
    expect(lineAmount(1000, -2000)).toBe(-2000);
  });

  test("signed allocation is exact and proportional", () => {
    expect(allocateSigned(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateSigned(900, [1000, -100])).toEqual([1000, -100]);
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }),
        fc
          .array(
            fc.integer({ min: -100_000, max: 1_000_000 }).filter((n) => n !== 0),
            { minLength: 1, maxLength: 8 },
          )
          .filter((w) => w.reduce((a, b) => a + b, 0) > 0),
        (total, weights) => {
          const out = allocateSigned(total, weights);
          expect(out.reduce((a, b) => a + b, 0)).toBe(total);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe(`invoices (${DB_MODE})`, () => {
  test("drafts are numbered, editable, and post AR against income when finalized", async () => {
    const a = await newInvoice([100_000]);
    const b = await newInvoice([5_000]);
    expect(a.number).toBe("INV-1001");
    expect(b.number).toBe("INV-1002");
    expect(a.status).toBe("draft");
    expect(a.due_date).toBe("2026-02-09");
    const e = await owner.json("PATCH", `${base()}/invoices/${a.id}`, {
      lines: [
        { description: "Design", quantity_milli: 12_500, unit_price: 15_000, account_id: acct["4000"] },
        { description: "Discount", quantity_milli: 1000, unit_price: -7_500, account_id: acct["4000"] },
      ],
    });
    expect(e.body.total).toBe(180_000);
    const f = await finalize(a.id);
    expect(f.status).toBe(200);
    expect(f.body.status).toBe("posted");
    expect(f.body.invoice.status).toBe("sent");
    const entry = (await owner.json("GET", `${base()}/entries/${f.body.invoice.entry_id}`)).body;
    expect(entry.source_type).toBe("invoice");
    expect(entry.lines.find((l: any) => l.account_id === acct["1200"]).amount).toBe(180_000);
    // document entries cannot be edited or reversed through the entry API
    expect((await owner.json("POST", `${base()}/entries/${entry.id}/reverse`, {})).status).toBe(409);
    expect((await owner.json("PATCH", `${base()}/invoices/${a.id}`, { memo: "x" })).status).toBe(409);
    expect((await owner.json("DELETE", `${base()}/invoices/${b.id}`)).status).toBe(200);
  });

  test("quantity must be positive; fractional quantities are accepted", async () => {
    const line = (quantity_milli: number) => ({
      customer_id: customer,
      issue_date: "2026-01-10",
      lines: [{ description: "x", quantity_milli, unit_price: 1_000, account_id: acct["4000"] }],
    });
    expect((await owner.json("POST", `${base()}/invoices`, line(0))).status).toBe(400);
    expect((await owner.json("POST", `${base()}/invoices`, line(-1000))).status).toBe(400);
    expect((await owner.json("POST", `${base()}/invoices`, line(250))).status).toBe(201);
  });

  test("PDF renders and send emails it with the PDF attached", async () => {
    const inv = await newInvoice([25_000]);
    const pdf = await owner.req("GET", `${base()}/invoices/${inv.id}/pdf`);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(new TextDecoder().decode((await pdf.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    const before = mail.length;
    const s = await owner.json("POST", `${base()}/invoices/${inv.id}/send`, {});
    expect(s.status).toBe(200);
    expect(s.body.emailed_to).toBe("ap@globex.test");
    expect(s.body.invoice.status).toBe("sent");
    expect(s.body.invoice.sent_at).toBeTruthy();
    const m = mail[before]!;
    expect(m.subject).toContain(inv.number);
    expect(m.attachments?.[0]?.contentType).toBe("application/pdf");
    expect(m.raw).toContain("application/pdf");
  });

  test("partial, full, and over-payments; credits apply to later invoices", async () => {
    const inv = await newInvoice([100_000]);
    await finalize(inv.id);
    const p1 = await pay(40_000, [{ document_id: inv.id, amount: 40_000 }]);
    expect(p1.status).toBe(201);
    expect((await owner.json("GET", `${base()}/invoices/${inv.id}`)).body.status).toBe("partial");
    const over = await pay(80_000, [{ document_id: inv.id, amount: 80_000 }]);
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe("over_applied");
    const p2 = await pay(80_000, [{ document_id: inv.id, amount: 60_000 }]);
    expect(p2.body.payment.unapplied).toBe(20_000);
    const paid = (await owner.json("GET", `${base()}/invoices/${inv.id}`)).body;
    expect(paid.status).toBe("paid");
    expect(paid.balance_due).toBe(0);

    const credits = await owner.json("GET", `${base()}/payments?with_credit=true&contact_id=${customer}`);
    expect(credits.body.data.map((p: any) => p.id)).toContain(p2.body.payment.id);
    const next = await newInvoice([15_000], "2026-02-10");
    await finalize(next.id);
    const ap = await owner.json("POST", `${base()}/payments/${p2.body.payment.id}/apply`, {
      applications: [{ document_id: next.id, amount: 15_000 }],
      date: "2026-02-15",
    });
    expect(ap.body.unapplied).toBe(5_000);
    expect((await owner.json("GET", `${base()}/invoices/${next.id}`)).body.status).toBe("paid");

    // cannot void an invoice with payments; voiding the payment reopens it
    expect((await owner.json("POST", `${base()}/invoices/${inv.id}/void`, {})).status).toBe(409);
    const vp = await owner.json("POST", `${base()}/payments/${p1.body.payment.id}/void`, {});
    expect(vp.body.voided_at).toBeTruthy();
    expect((await owner.json("GET", `${base()}/invoices/${inv.id}`)).body.status).toBe("partial");
    expect((await owner.json("POST", `${base()}/verify`)).body.ok).toBe(true);
  });

  test("void reverses the invoice entry; AI assistants cannot void", async () => {
    const inv = await newInvoice([7_000]);
    await finalize(inv.id);
    const h = await env.ctx.orgs.mustOpen(orgId);
    const mcp: ActorInfo = { actor: "mcp", role: "owner", userId: owner.userId, proposeOnly: true };
    await expect(h.write((tx) => voidInvoiceTx(tx, orgId, mcp, inv.id))).rejects.toMatchObject({
      status: 403,
    });
    const v = await owner.json("POST", `${base()}/invoices/${inv.id}/void`, {});
    expect(v.body.status).toBe("void");
    const e = (await owner.json("GET", `${base()}/entries/${inv.id ? v.body.entry_id : ""}`)).body;
    expect(e.reversed_by_entry_id).toBeTruthy();
  });

  test("large invoices wait for review; approval posts them, rejection returns them to draft", async () => {
    const big = await newInvoice([300_000]);
    const f = await finalize(big.id);
    expect(f.body.status).toBe("pending_review");
    expect(f.body.invoice.status).toBe("draft");
    expect(f.body.invoice.entry_status).toBe("pending_review");
    expect((await owner.json("POST", `${base()}/invoices/${big.id}/send`, {})).body.emailed_to).toBeNull();
    await owner.json("POST", `${base()}/review/${f.body.review.review_item_id}/approve`, {});
    expect((await owner.json("GET", `${base()}/invoices/${big.id}`)).body.status).toBe("sent");

    const big2 = await newInvoice([400_000]);
    const f2 = await finalize(big2.id);
    await owner.json("POST", `${base()}/review/${f2.body.review.review_item_id}/reject`, {
      note: "wrong customer",
    });
    const back = (await owner.json("GET", `${base()}/invoices/${big2.id}`)).body;
    expect(back.status).toBe("draft");
    expect(back.entry_id).toBeNull();
    expect((await owner.json("PATCH", `${base()}/invoices/${big2.id}`, { memo: "fixed" })).status).toBe(200);
  });

  test("viewers cannot create documents", async () => {
    const v = await login(env, "ar-viewer@example.com");
    await addMember(env, orgId, v.userId, "viewer");
    expect(
      (
        await v.json("POST", `${base()}/invoices`, {
          customer_id: customer,
          issue_date: "2026-01-01",
          lines: [{ description: "x", unit_price: 1, account_id: acct["4000"] }],
        })
      ).status,
    ).toBe(403);
    expect((await v.json("GET", `${base()}/invoices`)).status).toBe(200);
  });
});

describe(`bills, attachments, 1099 (${DB_MODE})`, () => {
  test("bills post AP; payments settle them; attachments are stored and served safely", async () => {
    const expense = (await owner.json("GET", `${base()}/accounts`)).body.data.find(
      (a: any) => a.type === "expense" && a.tax_line === "schc.11",
    );
    const b = await owner.json("POST", `${base()}/bills`, {
      vendor_id: vendor,
      bill_number: "A-77",
      issue_date: "2026-03-01",
      lines: [{ description: "Contract work", amount: 90_000, account_id: expense.id }],
    });
    expect(b.status).toBe(201);
    expect(b.body.bill.status).toBe("open");
    const pdfBytes = new TextEncoder().encode("%PDF-1.4\n% fake bill\n");
    const form = new FormData();
    form.append("file", new File([pdfBytes], "bill A-77.pdf", { type: "application/pdf" }));
    form.append("target_type", "bill");
    form.append("target_id", b.body.bill.id);
    const up = await owner.req("POST", `${base()}/attachments`, form);
    expect(up.status).toBe(201);
    const att = await up.json();
    expect(att.mime_type).toBe("application/pdf");
    const list = await owner.json(
      "GET",
      `${base()}/attachments?target_type=bill&target_id=${b.body.bill.id}`,
    );
    expect(list.body.data).toHaveLength(1);
    const dl = await owner.req("GET", `${base()}/attachments/${att.id}`);
    expect(dl.headers.get("content-disposition")).toStartWith("inline");
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(pdfBytes);
    // an HTML file is never served inline or as HTML
    const f2 = new FormData();
    f2.append("file", new File(["<script>alert(1)</script>"], "x.html", { type: "text/html" }));
    const up2 = await (await owner.req("POST", `${base()}/attachments`, f2)).json();
    expect(up2.mime_type).toBe("application/octet-stream");
    const dl2 = await owner.req("GET", `${base()}/attachments/${up2.id}`);
    expect(dl2.headers.get("content-disposition")).toStartWith("attachment");

    const p = await pay(
      90_000,
      [{ document_id: b.body.bill.id, amount: 90_000 }],
      "2026-03-15",
      "sent",
      vendor,
    );
    expect(p.status).toBe(201);
    expect((await owner.json("GET", `${base()}/bills/${b.body.bill.id}`)).body.status).toBe("paid");

    // paid by card: excluded from the 1099 summary
    const cardBill = await owner.json("POST", `${base()}/bills`, {
      vendor_id: vendor,
      issue_date: "2026-04-01",
      lines: [{ description: "More", amount: 10_000, account_id: expense.id }],
    });
    await owner.json("POST", `${base()}/payments`, {
      direction: "sent",
      contact_id: vendor,
      date: "2026-04-02",
      amount: 10_000,
      account_id: acct["2100"],
      applications: [{ document_id: cardBill.body.bill.id, amount: 10_000 }],
    });
    const r = await report("vendor_1099", "to=2026-12-31");
    const row = r.lines.find((l: any) => l.accountId === vendor);
    expect(row.values[0]).toBe(90_000);
    expect(row.code).toBe("***-**-4321");
  });
});

describe(`cash basis and aging (${DB_MODE})`, () => {
  let cashOrg: string;
  let c: Record<string, string>;
  let cust: string;
  const cb = () => `/api/v1/orgs/${cashOrg}`;

  beforeAll(async () => {
    cashOrg = await createOrg(env, owner, "Cash Co", { basis: "cash" });
    const r = await owner.json("GET", `${cb()}/accounts`);
    c = Object.fromEntries(r.body.data.map((a: any) => [a.code, a.id]));
    cust = (await owner.json("POST", `${cb()}/contacts`, { kind: "customer", name: "Acme" })).body.id;
  });

  test("revenue is recognized when paid on the cash basis, and reports tie out on both bases", async () => {
    const inv = (
      await owner.json("POST", `${cb()}/invoices`, {
        customer_id: cust,
        issue_date: "2026-01-15",
        lines: [
          { description: "A", unit_price: 60_000, account_id: c["4000"] },
          { description: "B", unit_price: 40_000, account_id: c["4000"] },
        ],
      })
    ).body;
    await owner.json("POST", `${cb()}/invoices/${inv.id}/finalize`, {});
    await owner.json("POST", `${cb()}/payments`, {
      direction: "received",
      contact_id: cust,
      date: "2026-02-10",
      amount: 30_000,
      account_id: c["1000"],
      applications: [{ document_id: inv.id, amount: 30_000 }],
    });
    const q = (from: string, to: string, basis: string) =>
      `/reports/profit_and_loss?from=${from}&to=${to}&basis=${basis}`;
    const janAcc = (await owner.json("GET", `${cb()}${q("2026-01-01", "2026-01-31", "accrual")}`)).body;
    const janCash = (await owner.json("GET", `${cb()}${q("2026-01-01", "2026-01-31", "cash")}`)).body;
    const febCash = (await owner.json("GET", `${cb()}${q("2026-02-01", "2026-02-28", "cash")}`)).body;
    expect(line(janAcc, "Total Income")).toBe(100_000);
    expect(line(janCash, "Total Income")).toBe(0);
    expect(line(febCash, "Total Income")).toBe(30_000);
    expect(janCash.meta.basis).toBe("cash");
    // the org default basis is used when none is given
    expect(
      (await owner.json("GET", `${cb()}/reports/profit_and_loss?from=2026-02-01&to=2026-02-28`)).body.meta
        .basis,
    ).toBe("cash");
    for (const basis of ["cash", "accrual"]) {
      for (const key of ["trial_balance", "balance_sheet", "cash_flow", "profit_and_loss"]) {
        const r = (
          await owner.json(
            "GET",
            `${cb()}/reports/${key}?from=2026-01-01&to=2026-12-31&as_of=2026-03-31&basis=${basis}`,
          )
        ).body;
        for (const v of Object.values(r.checks)) expect(v).toBe(0);
      }
    }
    const bsCash = (await owner.json("GET", `${cb()}/reports/balance_sheet?as_of=2026-03-31&basis=cash`))
      .body;
    expect(bsCash.lines.find((l: any) => l.accountId === c["1200"])?.values[0] ?? 0).toBe(0);
  });

  test("AR aging buckets open balances as of a date", async () => {
    const mk = async (date: string, due: string, amount: number) => {
      const inv = (
        await owner.json("POST", `${cb()}/invoices`, {
          customer_id: cust,
          issue_date: date,
          due_date: due,
          lines: [{ description: "x", unit_price: amount, account_id: c["4000"] }],
        })
      ).body;
      await owner.json("POST", `${cb()}/invoices/${inv.id}/finalize`, {});
      return inv;
    };
    await mk("2026-03-01", "2026-03-31", 10_000); // current as of 03-31
    await mk("2026-01-01", "2026-02-15", 20_000); // 44 days past due → 31-60
    const aging = (await owner.json("GET", `${cb()}/reports/ar_aging?as_of=2026-03-31`)).body;
    const acme = aging.lines.find((l: any) => l.label === "Acme");
    // plus the earlier invoice: 100,000 − 30,000 open, due 02-14 → 45 days → 31-60
    expect(acme.values).toEqual([10_000, 0, 90_000, 0, 0, 100_000]);
    // before the partial payment, the first invoice was fully open
    const early = (await owner.json("GET", `${cb()}/reports/ar_aging?as_of=2026-02-01`)).body;
    expect(early.lines.find((l: any) => l.label === "Acme").values[5]).toBe(120_000);
    const pdf = await owner.req("GET", `${cb()}/reports/ar_aging?as_of=2026-03-31&format=pdf`);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
  });

  test("every report exports as PDF", async () => {
    for (const key of [
      "profit_and_loss",
      "balance_sheet",
      "trial_balance",
      "cash_flow",
      "general_ledger",
      "tax_line_summary",
      "ap_aging",
      "vendor_1099",
    ]) {
      const res = await owner.req(
        "GET",
        `${cb()}/reports/${key}?from=2026-01-01&to=2026-12-31&as_of=2026-12-31&format=pdf`,
      );
      expect(res.status).toBe(200);
      expect(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    }
  });
});

describe(`reminders, bank payments (${DB_MODE})`, () => {
  test("overdue reminders are off by default, then sent at most weekly", async () => {
    expect((await runReminders(env.ctx, orgId, "2026-12-01")).sent).toBe(0);
    await owner.json("PATCH", `${base()}`, { reminders_enabled: true });
    const first = await runReminders(env.ctx, orgId, "2026-12-01");
    expect(first.sent).toBeGreaterThan(0);
    expect(mail.at(-1)!.subject).toStartWith("Reminder:");
    expect((await runReminders(env.ctx, orgId, "2026-12-02")).sent).toBe(0);
  });

  test("record a customer payment straight from a bank transaction", async () => {
    const bank = (
      await owner.json("POST", `${base()}/bank-accounts`, {
        name: "Op",
        kind: "checking",
        ledger_account_id: acct["1000"],
      })
    ).body;
    const inv = await newInvoice([12_345], "2026-06-01");
    await finalize(inv.id);
    await owner.json("POST", `${base()}/bank-accounts/${bank.id}/import`, {
      filename: "jun.csv",
      content: `Date,Description,Amount\n2026-06-20,DEPOSIT GLOBEX,123.45\n`,
      profile: {
        hasHeader: true,
        skipRows: 0,
        dateFormat: "YYYY-MM-DD",
        amountMode: "signed",
        signConvention: "positive_is_deposit",
        columns: { date: 0, description: 1, amount: 2 },
      },
    });
    const txn = (await owner.json("GET", `${base()}/bank-transactions?bank_account_id=${bank.id}&status=new`))
      .body.data[0];
    const r = await owner.json("POST", `${base()}/bank-transactions/${txn.id}/record-payment`, {
      contact_id: customer,
      applications: [{ document_id: inv.id, amount: 12_345 }],
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("posted");
    expect((await owner.json("GET", `${base()}/invoices/${inv.id}`)).body.status).toBe("paid");
    const t = (await owner.json("GET", `${base()}/bank-transactions/${txn.id}`)).body;
    expect(t.status).toBe("matched");
    expect(t.entry_id).toBe(r.body.entry.id);
    expect((await owner.json("POST", `${base()}/verify`)).body.ok).toBe(true);
  });
});

describe(`exports (${DB_MODE})`, () => {
  test("audit log exports as CSV and PDF; viewers are refused", async () => {
    const csv = await owner.req("GET", `${base()}/audit/export?format=csv`);
    const text = await csv.text();
    expect(text.split("\r\n")[0]).toBe("seq,at,actor,user,action,target_type,target_id,hash");
    expect(text).toContain("invoice.create");
    expect(text).toContain("ar-owner@example.com");
    const pdf = await owner.req("GET", `${base()}/audit/export?format=pdf`);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    const v = await login(env, "ar-viewer@example.com");
    expect((await v.req("GET", `${base()}/audit/export`)).status).toBe(403);
  });

  test("reconciliation report exports", async () => {
    const start = await owner.json("POST", `${base()}/reconciliations`, {
      account_id: acct["1000"],
      statement_end_date: "2026-12-31",
      statement_ending_balance: 0,
    });
    const csv = await owner.req("GET", `${base()}/reconciliations/${start.body.id}/export?format=csv`);
    expect(csv.status).toBe(200);
    const csvText = await csv.text();
    expect(csvText.split("\r\n")[0]).toMatch(/^Account,/);
    expect(csvText).toContain("date,memo,amount,cleared");
    const pdf = await owner.req("GET", `${base()}/reconciliations/${start.body.id}/export?format=pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
  });
});
