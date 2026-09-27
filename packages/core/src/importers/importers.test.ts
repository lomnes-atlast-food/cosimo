import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { guessAccountTypeFromName } from "./common.ts";
import { detectFile, parseImport } from "./index.ts";
import type { ImportBundle, ImportedEntry, ImportFileInput } from "./types.ts";

const FIX = join(import.meta.dir, "fixtures");
const load = (name: string): ImportFileInput => ({ name, content: readFileSync(join(FIX, name), "utf8") });

const QBO = ["qbo-accounts.csv", "qbo-customers.csv", "qbo-vendors.csv", "qbo-journal.csv"].map(load);
const XERO = ["xero-accounts.csv", "xero-contacts.csv", "xero-journal.csv"].map(load);
const WAVE = ["wave-transactions.csv", "wave-customers.csv"].map(load);

function acct(b: ImportBundle, key: string) {
  const a = b.accounts.find((x) => x.key === key);
  if (!a) throw new Error(`no account ${key}`);
  return a;
}

function contact(b: ImportBundle, name: string) {
  const c = b.contacts.find((x) => x.name === name);
  if (!c) throw new Error(`no contact ${name}`);
  return c;
}

function lines(e: ImportedEntry) {
  return e.lines.map((l) => [l.account, l.amount]);
}

function expectBalanced(b: ImportBundle) {
  for (const e of b.entries) {
    expect(e.lines.reduce((s, l) => s + l.amount, 0)).toBe(0);
    expect(e.lines.length).toBeGreaterThanOrEqual(2);
    expect(e.lines.every((l) => l.amount !== 0 && Number.isInteger(l.amount))).toBe(true);
    for (const l of e.lines) expect(b.accounts.some((a) => a.key === l.account)).toBe(true);
    expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }
}

const errors = (b: ImportBundle) => b.issues.filter((i) => i.level === "error");

describe("detectFile", () => {
  test.each([
    ["qbo-accounts.csv", "qbo", "accounts"],
    ["qbo-customers.csv", "qbo", "contacts"],
    ["qbo-vendors.csv", "qbo", "contacts"],
    ["qbo-journal.csv", "qbo", "ledger"],
    ["xero-accounts.csv", "xero", "accounts"],
    ["xero-contacts.csv", "xero", "contacts"],
    ["xero-journal.csv", "xero", "ledger"],
    ["wave-transactions.csv", "wave", "ledger"],
    ["wave-customers.csv", "wave", "contacts"],
  ])("%s → %s %s", (name, source, kind) => {
    expect(detectFile(load(name))).toEqual({ source: source as never, kind: kind as never });
  });

  test("unknown CSV is null", () => {
    expect(
      detectFile({ name: "bank.csv", content: "Date,Description,Amount\n2026-01-01,Coffee,-4.50\n" }),
    ).toBeNull();
  });
});

describe("QuickBooks Online", () => {
  const b = parseImport(QBO);

  test("source and no errors", () => {
    expect(b.source).toBe("qbo");
    expect(errors(b)).toEqual([]);
  });

  test("accounts map to type/subtype", () => {
    const cases: [string, string, string | null][] = [
      ["1000", "asset", "bank"],
      ["1200", "asset", "accounts_receivable"],
      ["1300", "asset", "other_current_asset"],
      ["1500", "asset", "fixed_asset"],
      ["1590", "asset", "accumulated_depreciation"],
      ["2000", "liability", "accounts_payable"],
      ["2100", "liability", "credit_card"],
      ["2200", "liability", "other_current_liability"],
      ["2700", "liability", "long_term_liability"],
      ["3000", "equity", "opening_balance"],
      ["3100", "equity", "owner_equity"],
      ["3200", "equity", "owner_draw"],
      ["3900", "equity", "retained_earnings"],
      ["4000", "income", "other"],
      ["4900", "income", "other_income"],
      ["5000", "expense", "cost_of_goods"],
      ["6300", "expense", "other"],
      ["6900", "expense", "other_expense"],
      ["6999", "expense", "uncategorized"],
    ];
    for (const [key, type, subtype] of cases) {
      const a = acct(b, key);
      expect([key, a.type, a.subtype]).toEqual([key, type as never, subtype as never]);
    }
    expect(acct(b, "2100")).toMatchObject({
      code: "2100",
      name: "Business Visa",
      description: "Company card ending 4242",
      source_type_label: "Credit Card / Credit Card",
    });
  });

  test("sub-account keeps leaf name and parent key", () => {
    expect(acct(b, "utilities:internet")).toMatchObject({
      code: null,
      name: "Internet",
      parent: "6190",
      full_name: "Utilities:Internet",
      type: "expense",
    });
  });

  test("footer and total rows are not accounts", () => {
    expect(b.accounts.some((a) => /friday|total/i.test(a.name))).toBe(false);
    expect(b.stats.files.find((f) => f.name === "qbo-accounts.csv")?.rows).toBe(23);
  });

  test("ledger-only account is synthesized with a warning", () => {
    expect(acct(b, "meals")).toMatchObject({ type: "expense", subtype: "other", synthesized: true });
    expect(b.issues.some((i) => i.level === "warning" && i.message.includes('"Meals"'))).toBe(true);
  });

  test("contacts: kinds, phone cleanup, 1099", () => {
    expect(contact(b, "Acme Robotics")).toEqual({
      name: "Acme Robotics",
      kind: "customer",
      email: "ap@acme.example.com",
      phone: "(555) 010-2000",
      company: "Acme Robotics Inc.",
    });
    expect(contact(b, "Bluebird Cafe").kind).toBe("both");
    expect(contact(b, "Jordan Park Design")).toMatchObject({ kind: "vendor", is_1099_vendor: true });
    expect(contact(b, "Pixel Supply Co")).toMatchObject({ kind: "vendor", is_1099_vendor: false });
    // Appears only in the journal, on an Expense → vendor.
    expect(contact(b, "Metro Fiber").kind).toBe("vendor");
  });

  test("entries", () => {
    expect(b.entries.length).toBe(8);
    expectBalanced(b);
    const [deposit, invoice, bill, payment, billPayment, fee, internet, je] = b.entries;
    expect(deposit).toMatchObject({
      date: "2026-01-02",
      source_label: "Deposit",
      memo: "Owner contribution",
    });
    expect(lines(deposit!)).toEqual([
      ["1000", 500000],
      ["3100", -500000],
    ]);
    expect(invoice).toMatchObject({ date: "2026-01-05", reference: "1001", source_label: "Invoice" });
    expect(invoice!.lines[0]).toEqual({
      account: "1200",
      amount: 275000,
      description: "Brand identity package",
      contact: "Acme Robotics",
    });
    expect(bill).toMatchObject({ reference: "B-77", source_label: "Bill" });
    expect(lines(bill!)).toEqual([
      ["5000", 32000],
      ["2000", -32000],
    ]);
    expect(payment!.source_label).toBe("Payment");
    expect(billPayment).toMatchObject({
      date: "2026-01-20",
      reference: "5001",
      source_label: "Bill Payment (Check)",
    });
    expect(lines(fee!)).toEqual([
      ["6300", 1500],
      ["1000", -1500],
    ]);
    expect(lines(internet!)).toEqual([
      ["utilities:internet", 8999],
      ["2100", -8999],
    ]);
    // Parenthesized debit is a negative debit (a credit).
    expect(je).toMatchObject({ date: "2026-02-03", reference: "JE-1" });
    expect(lines(je!)).toEqual([
      ["meals", 5250],
      ["6100", -1000],
      ["2100", -4250],
    ]);
  });

  test("stats", () => {
    expect(b.stats.date_range).toEqual({ from: "2026-01-02", to: "2026-02-03" });
    expect(b.stats.total_debits).toBe(500000 + 275000 + 32000 + 275000 + 32000 + 1500 + 8999 + 5250);
    expect(b.stats.files.map((f) => f.kind)).toEqual(["accounts", "contacts", "contacts", "ledger"]);
    expect(b.stats.files.find((f) => f.name === "qbo-journal.csv")?.rows).toBe(17);
  });

  test("journal rows repeating the header fields on every line still group", () => {
    const csv = `Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit
01/05/2026,Expense,,Pixel Supply Co,,Supplies,40.00,
01/05/2026,Expense,,Pixel Supply Co,,Checking,,40.00
01/05/2026,Expense,,Pixel Supply Co,,Supplies,10.00,
01/05/2026,Expense,,Pixel Supply Co,,Checking,,10.00
`;
    const r = parseImport([{ name: "j.csv", content: csv }]);
    expect(r.entries.length).toBe(2);
    expect(acct(r, "checking")).toMatchObject({ type: "asset", subtype: "bank", synthesized: true });
  });

  test("broken journal: unbalanced, bad date, bad amount", () => {
    const csv = `Journal
Northwind Studio LLC

Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit
01/05/2026,Invoice,1001,Acme Robotics,,Accounts Receivable,100.00,
,,,,,Design Income,,90.00

2026.01.07,Expense,,,,Bank Charges,5.00,
,,,,,Checking,,5.00

01/08/2026,Expense,,,,Bank Charges,abc,
,,,,,Checking,,5.00

01/09/2026,Expense,,,,Bank Charges,5.00,
,,,,,Checking,,5.00
`;
    const r = parseImport([{ name: "broken.csv", content: csv }]);
    expect(r.entries.length).toBe(1);
    const errs = errors(r);
    expect(errs.length).toBe(3);
    expect(errs[0]).toMatchObject({ file: "broken.csv", row: 5 });
    expect(errs[0]!.message).toContain("does not balance");
    expect(errs[0]!.message).toContain("10.00");
    expect(errs[1]).toMatchObject({ row: 8 });
    expect(errs[1]!.message).toContain("Unrecognized date");
    expect(errs[2]).toMatchObject({ row: 11 });
    expect(errs[2]!.message).toContain("Invalid amount");
  });

  test("General Ledger report is rejected with a pointer to the Journal report", () => {
    const csv = `General Ledger
Northwind Studio LLC

,Date,Transaction Type,Num,Name,Memo/Description,Split,Amount,Balance
Business Checking,,,,,,,,
,01/02/2026,Deposit,,,,Owner's Investment,"5,000.00","5,000.00"
Total for Business Checking,,,,,,,"5,000.00",
`;
    const r = parseImport([{ name: "gl.csv", content: csv }]);
    expect(r.entries).toEqual([]);
    expect(errors(r)[0]!.message).toContain("Journal");
  });
});

describe("Xero", () => {
  const b = parseImport(XERO);

  test("no errors", () => {
    expect(b.source).toBe("xero");
    expect(errors(b)).toEqual([]);
  });

  test("accounts map to type/subtype", () => {
    const cases: [string, string, string | null][] = [
      ["090", "asset", "bank"],
      ["610", "asset", "accounts_receivable"],
      ["620", "asset", "other_current_asset"],
      ["710", "asset", "fixed_asset"],
      ["711", "asset", "accumulated_depreciation"],
      ["800", "liability", "accounts_payable"],
      ["820", "liability", "other_current_liability"],
      ["900", "liability", "long_term_liability"],
      ["880", "equity", "owner_draw"],
      ["881", "equity", "owner_equity"],
      ["960", "equity", "retained_earnings"],
      ["200", "income", "other"],
      ["270", "income", "other_income"],
      ["310", "expense", "cost_of_goods"],
      ["416", "expense", "other"],
      ["445", "expense", "other"],
    ];
    for (const [key, type, subtype] of cases) {
      const a = acct(b, key);
      expect([key, a.type, a.subtype]).toEqual([key, type as never, subtype as never]);
    }
    expect(acct(b, "445").name).toBe("Light, Power, Heating");
    expect(acct(b, "200").source_type_label).toBe("Revenue");
  });

  test("contacts default to both", () => {
    expect(contact(b, "Acme Robotics")).toEqual({
      name: "Acme Robotics",
      kind: "both",
      email: "ap@acme.example.com",
      phone: "1 555 010-2000",
      company: null,
    });
    expect(contact(b, "Pixel Supply Co").phone).toBe("555-010-4000");
  });

  test("IsCustomer / IsSupplier columns set kind", () => {
    const csv = `*ContactName,EmailAddress,IsCustomer,IsSupplier
Acme Robotics,ap@acme.example.com,true,false
Pixel Supply Co,,false,true
Bluebird Cafe,,true,true
`;
    const r = parseImport([{ name: "contacts.csv", content: csv }]);
    expect(r.contacts.map((c) => [c.name, c.kind])).toEqual([
      ["Acme Robotics", "customer"],
      ["Bluebird Cafe", "both"],
      ["Pixel Supply Co", "vendor"],
    ]);
  });

  test("entries", () => {
    expect(b.entries.length).toBe(8);
    expectBalanced(b);
    const inv = b.entries[1]!;
    expect(inv).toMatchObject({
      date: "2026-01-05",
      reference: "INV-0001",
      source_label: "Receivable Invoice",
      external_id: "2",
    });
    expect(lines(inv)).toEqual([
      ["610", 324500],
      ["200", -300000],
      ["820", -24500],
    ]);
    expect(inv.lines[2]!.description).toBe("Sales tax");
    const dep = b.entries.find((e) => e.reference === "MJ-1")!;
    expect(dep.date).toBe("2026-01-31");
    expect(lines(dep)).toEqual([
      ["416", 10000],
      ["711", -10000],
    ]);
    expect(b.entries.map((e) => e.date)).toEqual([
      "2026-01-02",
      "2026-01-05",
      "2026-01-12",
      "2026-01-15",
      "2026-01-20",
      "2026-01-31",
      "2026-01-31",
      "2026-02-03",
    ]);
    expect(b.stats.total_debits).toBe(1274500);
    expect(b.stats.date_range).toEqual({ from: "2026-01-02", to: "2026-02-03" });
  });

  test("DD/MM/YYYY and ISO dates; grouping by date+reference+source without journal numbers", () => {
    const csv = `Date,Source,Description,Reference,Account Code,Account,Debit,Credit
05/02/2026,Spend Money,Fee,F1,404,Bank Fees,15.00,
05/02/2026,Spend Money,Fee,F1,090,Business Bank Account,,15.00
2026-02-06,Spend Money,Fee,F2,404,Bank Fees,1.00,
2026-02-06,Spend Money,Fee,F2,090,Business Bank Account,,1.00
`;
    const r = parseImport([XERO[0]!, { name: "gl.csv", content: csv }]);
    expect(errors(r)).toEqual([]);
    expect(r.entries.map((e) => [e.date, e.reference])).toEqual([
      ["2026-02-05", "F1"],
      ["2026-02-06", "F2"],
    ]);
  });

  test("broken journal: unbalanced, unknown date format, missing column", () => {
    const csv = `Date,Journal Number,Source,Description,Reference,Account Code,Account,Debit,Credit
2 Jan 2026,1,Manual Journal,,,090,Business Bank Account,100.00,
2 Jan 2026,1,Manual Journal,,,881,Owner A Funds Introduced,,99.99
Jan the 3rd,2,Manual Journal,,,090,Business Bank Account,5.00,
Jan the 3rd,2,Manual Journal,,,881,Owner A Funds Introduced,,5.00
`;
    const r = parseImport([XERO[0]!, { name: "bad.csv", content: csv }]);
    expect(r.entries).toEqual([]);
    const errs = errors(r);
    expect(errs.map((e) => e.row)).toEqual([4, 2]);
    expect(errs[0]!.message).toContain('Unrecognized date "Jan the 3rd"');
    expect(errs[1]!.message).toContain(
      "Transaction on 2026-01-02 does not balance (debits minus credits = 0.01)",
    );
    const missing = parseImport([
      { name: "nodate.csv", content: "Journal Number,Account Code,Account,Debit,Credit\n1,090,Bank,1.00,\n" },
    ]);
    expect(errors(missing)[0]!.message).toContain("Missing required column(s): Date");
  });
});

describe("Wave", () => {
  const b = parseImport(WAVE);

  test("no issues", () => {
    expect(b.source).toBe("wave");
    expect(b.issues).toEqual([]);
  });

  test("accounts derived from Account Group / Account Type", () => {
    const cases: [string, string, string | null, string][] = [
      ["A100", "asset", "bank", "Business Checking"],
      ["A120", "asset", "accounts_receivable", "Accounts Receivable"],
      ["L200", "liability", "accounts_payable", "Accounts Payable"],
      ["L210", "liability", "credit_card", "Visa Card"],
      ["E300", "equity", "owner_equity", "Owner Investment"],
      ["E310", "equity", "owner_draw", "Owner Drawings"],
      ["I400", "income", "other", "Sales"],
      ["I490", "income", "other_income", "Interest Income"],
      ["X630", "expense", "other", "Meals and Entertainment"],
    ];
    for (const [key, type, subtype, name] of cases) {
      const a = acct(b, key);
      expect([key, a.type, a.subtype, a.name]).toEqual([key, type as never, subtype as never, name]);
    }
    expect(acct(b, "A100").source_type_label).toBe("Assets / Cash and Bank");
    expect(b.accounts.length).toBe(12);
  });

  test("contacts from ledger columns and customers export", () => {
    expect(b.contacts.map((c) => [c.name, c.kind])).toEqual([
      ["Acme Robotics", "customer"],
      ["Downtown Office Mart", "vendor"],
      ["Harbor Dental Group", "customer"],
      ["Pixel Supply Co", "vendor"],
    ]);
    expect(contact(b, "Acme Robotics").email).toBe("ap@acme.example.com");
  });

  test("entries incl. 3-way split", () => {
    expect(b.entries.length).toBe(9);
    expectBalanced(b);
    const split = b.entries.find((e) => e.external_id === "1007")!;
    expect(split.date).toBe("2026-02-03");
    expect(split.memo).toBe("Staples and Figma and lunch");
    expect(split.lines).toEqual([
      { account: "X610", amount: 4510, description: "Printer paper", contact: "Downtown Office Mart" },
      { account: "X620", amount: 2999, description: "Figma seat", contact: "Downtown Office Mart" },
      { account: "X630", amount: 6000, description: "Client lunch", contact: "Downtown Office Mart" },
      { account: "L210", amount: -13509, description: null, contact: "Downtown Office Mart" },
    ]);
    const inv = b.entries.find((e) => e.external_id === "1002")!;
    expect(inv).toMatchObject({ reference: "1001", source_label: "Invoice" });
    expect(b.stats.date_range).toEqual({ from: "2026-01-02", to: "2026-02-12" });
    expect(b.stats.total_debits).toBe(500000 + 275000 + 32000 + 275000 + 32000 + 1500 + 13509 + 50000 + 125);
  });

  test("broken export: unbalanced, bad date, missing column, one-line transaction", () => {
    const H =
      "Transaction ID,Transaction Date,Account Name,Debit Amount (Two Column Approach),Credit Amount (Two Column Approach),Account Group,Account Type";
    const csv = `${H}
T1,2026-01-02,Business Checking,100.00,,Assets,Cash and Bank
T1,2026-01-02,Sales,,90.00,Income,Income
T2,01/02/2026,Business Checking,5.00,,Assets,Cash and Bank
T2,01/02/2026,Sales,,5.00,Income,Income
T3,2026-01-04,Business Checking,5.00,,Assets,Cash and Bank
T3,2026-01-04,Sales,0.00,0.00,Income,Income
T3,2026-01-04,Sales,,5.00,Income,Income
T4,2026-01-05,Business Checking,0.00,,Assets,Cash and Bank
`;
    const r = parseImport([{ name: "wave.csv", content: csv }]);
    expect(r.entries.length).toBe(1);
    expect(r.entries[0]!.lines.length).toBe(2); // zero-amount line dropped
    expect(r.issues.map((i) => [i.level, i.row])).toEqual([
      ["error", 4],
      ["error", 2],
      ["warning", 9],
    ]);
    expect(r.issues[1]!.message).toContain("does not balance (debits minus credits = 10.00)");

    const noDate = parseImport([
      { name: "w.csv", content: "Transaction ID,Account Name,Debit Amount,Credit Amount\nT1,Cash,1.00,\n" },
    ]);
    expect(noDate.entries).toEqual([]);
    expect(errors(noDate)[0]!.message).toContain("Transaction Date");
  });
});

describe("parseImport", () => {
  test("mixing products is an error; majority product is read", () => {
    const r = parseImport([...QBO, load("xero-journal.csv")]);
    expect(r.source).toBe("qbo");
    const e = errors(r);
    expect(e.length).toBe(1);
    expect(e[0]!.message).toContain("more than one product");
    expect(e[0]!.message).toContain("xero-journal.csv");
    expect(r.entries.length).toBe(8);
  });

  test("forced source mismatching the files is an error", () => {
    const r = parseImport(WAVE, { source: "qbo" });
    expect(r.entries).toEqual([]);
    expect(errors(r)[0]!.message).toContain("more than one product");
  });

  test("unrecognized files are reported, not thrown", () => {
    const r = parseImport([{ name: "notes.csv", content: "hello,world\n1,2\n" }]);
    expect(errors(r)[0]).toMatchObject({ file: "notes.csv", row: null });
    expect(r.stats.files).toEqual([{ name: "notes.csv", kind: "unknown", rows: 0 }]);
  });

  test("deterministic", () => {
    for (const set of [QBO, XERO, WAVE]) {
      expect(JSON.stringify(parseImport(set))).toBe(JSON.stringify(parseImport(set)));
      expect(JSON.stringify(parseImport([...set].reverse()).entries)).toBe(
        JSON.stringify(parseImport(set).entries),
      );
    }
  });

  test("amounts: separators, currency, parentheses, negatives, CRLF and BOM", () => {
    const csv = `﻿Date,Transaction Type,Num,Name,Memo/Description,Account,Debit,Credit\r
01/05/2026,Journal Entry,J1,,,Checking,"$1,234.50",\r
,,,,,Owner's Equity,-1234.5,\r
,,,,,Checking,(0.06),\r
,,,,,Owner's Equity,,(0.06)\r
`;
    const r = parseImport([{ name: "j.csv", content: csv }]);
    expect(errors(r)).toEqual([]);
    expect(lines(r.entries[0]!)).toEqual([
      ["checking", 123450],
      ["owner's equity", -123450],
      ["checking", -6],
      ["owner's equity", 6],
    ]);
  });
});

describe("guessAccountTypeFromName", () => {
  test.each([
    ["Business Checking", "asset", "bank"],
    ["Chase Visa", "liability", "credit_card"],
    ["Accounts Receivable", "asset", "accounts_receivable"],
    ["Sales Tax Payable", "liability", "other_current_liability"],
    ["Owner's Draw", "equity", "owner_draw"],
    ["Opening Balance Equity", "equity", "opening_balance"],
    ["Consulting Income", "income", "other"],
    ["Interest Income", "income", "other_income"],
    ["Bank Service Charges", "expense", "other"],
    ["Equipment Rental", "expense", "other"],
    ["Office Equipment", "asset", "fixed_asset"],
    ["Stock Photography", "expense", "other"],
    ["Other Current Assets", "asset", "other_current_asset"],
    ["Uncategorized Income", "income", "uncategorized"],
    ["Meals", "expense", "other"],
  ])("%s → %s/%s", (name, type, subtype) => {
    expect(guessAccountTypeFromName(name)).toEqual({ type: type as never, subtype: subtype as never });
  });
});
