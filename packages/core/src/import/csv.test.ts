import { describe, expect, test } from "bun:test";
import { applyProfile, guessProfile, parseCsvAmount, parseDate, readCsvTable } from "./csv.ts";
import type { CsvProfile } from "./types.ts";

const CHASE = `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
DEBIT,01/30/2026,"STARBUCKS STORE 12345 SEATTLE WA        01/29",-6.45,DEBIT_CARD,1520.10,,
CREDIT,01/29/2026,"ACME CORP PAYROLL PPD ID: 1234567890",2500.00,ACH_CREDIT,1526.55,,
CHECK,01/28/2026,"CHECK 1041",-120.00,CHECK_PAID,-973.45,1041,
DEBIT,01/27/2026,"AMAZON.COM*AB12CD AMZN.COM/BILLWA",-1234.56,DEBIT_CARD,-853.45,,
`;

const DEBIT_CREDIT = `Date,Description,Debit,Credit,Balance
2026-02-01,Rent February,1500.00,,3500.00
2026-02-03,Client payment INV-1001,,"2,750.00",6250.00
2026-02-04,Bank fee,15.00,,6235.00
2026-02-05,Nothing here,,,6235.00
`;

const AMOUNT_TYPE = `Date,Narrative,Amount,DR/CR
03/02/2026,OFFICE SUPPLIES LTD,45.20,DR
03/05/2026,INTEREST,1.02,CR
03/06/2026,CARD REFUND,9.99,cr
`;

const NO_HEADER = `31/01/2026,TESCO STORES 3321,-23.10
15/01/2026,SALARY,3000.00
02/01/2026,COUNCIL TAX,-120.00
`;

const CC_EXPORT = `Transaction Date,Post Date,Description,Category,Amount
02/10/2026,02/11/2026,UBER *TRIP,Travel,24.50
02/12/2026,02/12/2026,PAYMENT RECEIVED,Payment,-500.00
02/13/2026,02/14/2026,NETFLIX.COM,Entertainment,15.49
`;

const QUOTED = `﻿"Date","Payee","Memo","Amount"\r\n"2026-04-01","Smith, Jones & Co","Invoice ""42"", April","-1,200.50"\r\n"2026-04-02","Widgets, Inc.","","300"\r\n`;

const base = (over: Partial<CsvProfile>): CsvProfile => ({
  hasHeader: true,
  skipRows: 0,
  delimiter: null,
  dateFormat: "YYYY-MM-DD",
  amountMode: "signed",
  signConvention: "positive_is_deposit",
  columns: { date: 0, description: 1, amount: 2 },
  ...over,
});

describe("parseDate", () => {
  test("formats", () => {
    expect(parseDate("2026-01-31", "YYYY-MM-DD")).toBe("2026-01-31");
    expect(parseDate("01/31/2026", "MM/DD/YYYY")).toBe("2026-01-31");
    expect(parseDate("31/01/2026", "DD/MM/YYYY")).toBe("2026-01-31");
    expect(parseDate("1/5/26", "M/D/YY")).toBe("2026-01-05");
    expect(parseDate("1/5/85", "M/D/YY")).toBe("1985-01-05");
    expect(parseDate("5/1/69", "D/M/YY")).toBe("2069-01-05");
    expect(parseDate("20260131", "YYYYMMDD")).toBe("2026-01-31");
    expect(parseDate("31.01.2026", "DD.MM.YYYY")).toBe("2026-01-31");
    expect(parseDate("Jan 5, 2026", "MMM D, YYYY")).toBe("2026-01-05");
    expect(parseDate("September 30, 2026", "MMM D, YYYY")).toBe("2026-09-30");
    expect(parseDate("5 Feb 2026", "D MMM YYYY")).toBe("2026-02-05");
    expect(parseDate("2026-01-31 13:45:00", "YYYY-MM-DD")).toBe("2026-01-31");
  });

  test("rejects invalid calendar dates and wrong formats", () => {
    expect(parseDate("02/30/2026", "MM/DD/YYYY")).toBeNull();
    expect(parseDate("02/29/2026", "MM/DD/YYYY")).toBeNull();
    expect(parseDate("02/29/2028", "MM/DD/YYYY")).toBe("2028-02-29");
    expect(parseDate("13/01/2026", "MM/DD/YYYY")).toBeNull();
    expect(parseDate("2026-01-31", "MM/DD/YYYY")).toBeNull();
    expect(parseDate("Foo 5, 2026", "MMM D, YYYY")).toBeNull();
    expect(parseDate("", "YYYY-MM-DD")).toBeNull();
  });
});

describe("parseCsvAmount", () => {
  test("bank spellings", () => {
    expect(parseCsvAmount("$1,234.56")).toBe(123456);
    expect(parseCsvAmount("(45.00)")).toBe(-4500);
    expect(parseCsvAmount("$-12.34")).toBe(-1234);
    expect(parseCsvAmount("12.34-")).toBe(-1234);
    expect(parseCsvAmount("12,34")).toBe(1234);
    expect(parseCsvAmount("1.234,56")).toBe(123456);
    expect(parseCsvAmount("10.00 CR")).toBe(1000);
    expect(parseCsvAmount("10.00 DR")).toBe(-1000);
    expect(() => parseCsvAmount("abc")).toThrow();
  });
});

describe("readCsvTable", () => {
  test("BOM, CRLF, quoted fields, blank rows", () => {
    const t = readCsvTable(QUOTED);
    expect(t.headers).toEqual(["Date", "Payee", "Memo", "Amount"]);
    expect(t.delimiter).toBe(",");
    expect(t.rows).toEqual([
      ["2026-04-01", "Smith, Jones & Co", 'Invoice "42", April', "-1,200.50"],
      ["2026-04-02", "Widgets, Inc.", "", "300"],
    ]);
  });

  test("skipRows and no header", () => {
    const t = readCsvTable(`Account: 1234\nExported 2026-01-01\n\n${NO_HEADER}`, {
      skipRows: 3,
      hasHeader: false,
    });
    expect(t.headers).toEqual(["Column 1", "Column 2", "Column 3"]);
    expect(t.rows).toHaveLength(3);
  });

  test("semicolon delimiter auto-detected", () => {
    const t = readCsvTable("Date;Text;Amount\n01.02.2026;Miete;-800,00\n02.02.2026;Gehalt;2500,00\n");
    expect(t.delimiter).toBe(";");
    expect(t.rows[0]).toEqual(["01.02.2026", "Miete", "-800,00"]);
  });
});

describe("applyProfile", () => {
  test("(a) Chase-like signed MM/DD/YYYY", () => {
    const r = applyProfile(
      CHASE,
      base({ dateFormat: "MM/DD/YYYY", columns: { date: 1, description: 2, amount: 3 } }),
    );
    expect(r.errors).toEqual([]);
    expect(r.rows.map((t) => [t.date, t.amount, t.row])).toEqual([
      ["2026-01-30", -645, 2],
      ["2026-01-29", 250000, 3],
      ["2026-01-28", -12000, 4],
      ["2026-01-27", -123456, 5],
    ]);
    expect(r.rows[1]?.description).toBe("ACME CORP PAYROLL PPD ID: 1234567890");
    expect(r.rows[1]?.providerId).toBeNull();
  });

  test("(b) debit/credit columns with blanks; both blank is an error", () => {
    const r = applyProfile(
      DEBIT_CREDIT,
      base({ amountMode: "debit_credit", columns: { date: 0, description: 1, debit: 2, credit: 3 } }),
    );
    expect(r.rows.map((t) => t.amount)).toEqual([-150000, 275000, -1500]);
    expect(r.errors).toEqual([{ row: 5, message: "missing amount (debit and credit both blank)" }]);
  });

  test("(c) amount + type column (DR/CR)", () => {
    const r = applyProfile(
      AMOUNT_TYPE,
      base({
        dateFormat: "MM/DD/YYYY",
        amountMode: "amount_type",
        columns: { date: 0, description: 1, amount: 2, type: 3 },
      }),
    );
    expect(r.errors).toEqual([]);
    expect(r.rows.map((t) => t.amount)).toEqual([-4520, 102, 999]);
  });

  test("(d) no header, DD/MM/YYYY", () => {
    const r = applyProfile(NO_HEADER, base({ hasHeader: false, dateFormat: "DD/MM/YYYY" }));
    expect(r.errors).toEqual([]);
    expect(r.rows.map((t) => [t.date, t.amount, t.description, t.row])).toEqual([
      ["2026-01-31", -2310, "TESCO STORES 3321", 1],
      ["2026-01-15", 300000, "SALARY", 2],
      ["2026-01-02", -12000, "COUNCIL TAX", 3],
    ]);
  });

  test("(e) positive_is_withdrawal credit card export", () => {
    const r = applyProfile(
      CC_EXPORT,
      base({
        dateFormat: "MM/DD/YYYY",
        signConvention: "positive_is_withdrawal",
        columns: { date: 0, description: 2, amount: 4 },
      }),
    );
    expect(r.errors).toEqual([]);
    expect(r.rows.map((t) => t.amount)).toEqual([-2450, 50000, -1549]);
  });

  test("(f) quoted fields with commas, BOM, CRLF, payee + memo", () => {
    const r = applyProfile(
      QUOTED,
      base({ columns: { date: 0, description: 1, payee: 1, memo: 2, amount: 3 } }),
    );
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      {
        date: "2026-04-01",
        amount: -120050,
        description: 'Smith, Jones & Co - Invoice "42", April',
        payee: "Smith, Jones & Co",
        providerId: null,
        row: 2,
      },
      {
        date: "2026-04-02",
        amount: 30000,
        description: "Widgets, Inc.",
        payee: "Widgets, Inc.",
        providerId: null,
        row: 3,
      },
    ]);
  });

  test("bad rows become errors with row numbers, not exceptions", () => {
    const csv = `Date,Description,Amount
2026-01-01,OK,1.00

2026-02-30,Bad date,5.00
2026-01-03,Bad amount,abc
2026-01-04,Zero,0.00
2026-01-05,Missing amount,
2026-01-06,Too precise,1.234
2026-01-07,OK again,-2.00
`;
    const r = applyProfile(csv, base({}));
    expect(r.rows.map((t) => [t.row, t.amount])).toEqual([
      [2, 100],
      [9, -200],
    ]);
    expect(r.errors.map((e) => e.row)).toEqual([4, 5, 6, 7, 8]);
    expect(r.errors[0]?.message).toContain("invalid date");
    expect(r.errors[2]?.message).toBe("zero amount");
    expect(r.errors[3]?.message).toBe("missing amount");
  });
});

describe("guessProfile", () => {
  test("(a) Chase-like", () => {
    const g = guessProfile(CHASE);
    expect(g.headers[0]).toBe("Details");
    expect(g.profile).toMatchObject({
      hasHeader: true,
      skipRows: 0,
      dateFormat: "MM/DD/YYYY",
      amountMode: "signed",
      signConvention: "positive_is_deposit",
      columns: { date: 1, description: 2, amount: 3 },
    });
    expect(g.preview).toHaveLength(4);
    expect(applyProfile(CHASE, g.profile).rows).toHaveLength(4);
  });

  test("(b) debit/credit", () => {
    const g = guessProfile(DEBIT_CREDIT);
    expect(g.profile).toMatchObject({
      hasHeader: true,
      dateFormat: "YYYY-MM-DD",
      amountMode: "debit_credit",
      columns: { date: 0, description: 1, debit: 2, credit: 3, amount: null },
    });
  });

  test("(c) amount + type", () => {
    const g = guessProfile(AMOUNT_TYPE);
    expect(g.profile).toMatchObject({
      dateFormat: "MM/DD/YYYY",
      amountMode: "amount_type",
      columns: { date: 0, description: 1, amount: 2, type: 3 },
    });
  });

  test("(d) no header, day-first dates", () => {
    const g = guessProfile(NO_HEADER);
    expect(g.profile).toMatchObject({
      hasHeader: false,
      dateFormat: "DD/MM/YYYY",
      amountMode: "signed",
      columns: { date: 0, description: 1, amount: 2 },
    });
  });

  test("preamble rows are skipped", () => {
    const g = guessProfile(`Account Name : Checking\nAccount Number : 1234\n\n${DEBIT_CREDIT}`);
    expect(g.profile.skipRows).toBe(3);
    expect(g.profile.hasHeader).toBe(true);
    const r = applyProfile(`Account Name : Checking\nAccount Number : 1234\n\n${DEBIT_CREDIT}`, g.profile);
    expect(r.rows).toHaveLength(3);
    expect(r.errors.map((e) => e.row)).toEqual([8]);
  });

  test("Bank of America: summary block above the header, balance row, stray quotes", () => {
    const BOFA = [
      "Description,,Summary Amt.",
      'Beginning balance as of 01/01/2026,,"0.00"',
      'Total credits,,"2,100.00"',
      'Total debits,,"-963.46"',
      'Ending balance as of 03/31/2026,,"1,136.54"',
      "",
      "Date,Description,Amount,Running Bal.",
      '01/01/2026,Beginning balance as of 01/01/2026,,"0.00"',
      '03/08/2026,"MOBILE DEPOSIT","100.00","100.00"',
      '03/16/2026,"Zelle payment from SAM for "Capital contribution"; Conf# abc123","2,000.00","2,100.00"',
      '03/23/2026,"ACME, INC 03/22 PURCHASE DEBIT CARD *1234","-963.46","1,136.54"',
    ].join("\r\n");
    const g = guessProfile(BOFA);
    expect(g.headers).toEqual(["Date", "Description", "Amount", "Running Bal."]);
    expect(g.profile).toMatchObject({
      hasHeader: true,
      skipRows: 6,
      amountMode: "signed",
      columns: { date: 0, description: 1, amount: 2 },
    });
    const r = applyProfile(BOFA, g.profile);
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => [x.date, x.amount])).toEqual([
      ["2026-03-08", 10000],
      ["2026-03-16", 200000],
      ["2026-03-23", -96346],
    ]);
    expect(r.rows[1]?.description).toBe('Zelle payment from SAM for "Capital contribution"; Conf# abc123');
  });

  test("(f) quoted with payee and memo", () => {
    const g = guessProfile(QUOTED);
    expect(g.profile.columns).toMatchObject({ date: 0, amount: 3 });
    expect(g.profile.columns.memo).toBe(2);
  });
});
