import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { chartOfAccounts } from "./coa.ts";
import {
  type AccountInfo,
  type Balances,
  balanceSheet,
  cashFlow,
  generalLedger,
  profitAndLoss,
  taxLineSummary,
  trialBalance,
} from "./reports.ts";

const accounts: AccountInfo[] = chartOfAccounts("schedule_c").map((t, i) => ({
  id: `a${i}`,
  code: t.code,
  name: t.name,
  type: t.type,
  subtype: t.subtype,
  parentId: null,
  taxLine: t.taxLine ?? null,
  systemKey: t.systemKey ?? null,
}));
// Give one account a parent to exercise subtotals.
const office = accounts.find((a) => a.name.toLowerCase().includes("office"))!;
const supplies = accounts.find(
  (a) => a.type === "expense" && a.id !== office.id && a.subtype !== "cost_of_goods",
)!;
supplies.parentId = office.id;

interface Entry {
  date: string;
  lines: { accountId: string; amount: number }[];
}

const dateArb = fc
  .record({
    y: fc.integer({ min: 2024, max: 2026 }),
    m: fc.integer({ min: 1, max: 12 }),
    d: fc.integer({ min: 1, max: 28 }),
  })
  .map(({ y, m, d }) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);

/** A balanced entry: n-1 random lines plus one balancing line. */
const entryArb: fc.Arbitrary<Entry> = fc
  .record({
    date: dateArb,
    lines: fc.array(
      fc.record({
        idx: fc.integer({ min: 0, max: accounts.length - 1 }),
        amount: fc.integer({ min: -5_000_000, max: 5_000_000 }).filter((n) => n !== 0),
      }),
      { minLength: 1, maxLength: 5 },
    ),
    balIdx: fc.integer({ min: 0, max: accounts.length - 1 }),
  })
  .map(({ date, lines, balIdx }) => {
    const ls = lines.map((l) => ({ accountId: accounts[l.idx]!.id, amount: l.amount }));
    const sum = ls.reduce((s, l) => s + l.amount, 0);
    if (sum !== 0) ls.push({ accountId: accounts[balIdx]!.id, amount: -sum });
    return { date, lines: ls };
  });

function sums(entries: Entry[], from: string | null, to: string | null): Balances {
  const m = new Map<string, number>();
  for (const e of entries) {
    if (from && e.date < from) continue;
    if (to && e.date > to) continue;
    for (const l of e.lines) m.set(l.accountId, (m.get(l.accountId) ?? 0) + l.amount);
  }
  return m;
}

const dayBefore = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
};

describe("reports tie out (property)", () => {
  test("trial balance, balance sheet, P&L, and cash flow always tie", () => {
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 40 }), dateArb, dateArb, (entries, d1, d2) => {
        const [from, to] = d1 <= d2 ? [d1, d2] : [d2, d1];
        const fyStart = `${to.slice(0, 4)}-01-01`;

        const tb = trialBalance(accounts, sums(entries, null, to), to);
        expect(tb.checks.debits_minus_credits).toBe(0);

        const bs = balanceSheet(accounts, [
          {
            label: "now",
            asOf: to,
            balances: sums(entries, null, to),
            priorYears: sums(entries, null, dayBefore(fyStart)),
          },
          {
            label: "from",
            asOf: from,
            balances: sums(entries, null, from),
            priorYears: sums(entries, null, `${Number(from.slice(0, 4)) - 1}-12-31`),
          },
        ]);
        expect(bs.checks.assets_minus_liabilities_equity_0).toBe(0);
        expect(bs.checks.assets_minus_liabilities_equity_1).toBe(0);

        const pl = profitAndLoss(accounts, [{ label: "p", from, to, balances: sums(entries, from, to) }]);
        expect(pl.checks.net_income_0).toBe(0);

        // Net income on the P&L equals the change in equity from operations (retained earnings +
        // current-year net income) between the two balance sheet dates, when both are in the
        // same fiscal year and no entry touches equity accounts directly.
        const cf = cashFlow(accounts, {
          label: "p",
          from,
          to,
          start: sums(entries, null, dayBefore(from)),
          end: sums(entries, null, to),
          period: sums(entries, from, to),
        });
        expect(cf.checks.cash_change_mismatch).toBe(0);
      }),
      { numRuns: 200 },
    );
  });

  test("P&L net income equals the change in equity from operations", () => {
    const pl = accounts.filter((a) => a.type === "income" || a.type === "expense");
    const nonEquityBs = accounts.filter((a) => a.type === "asset" || a.type === "liability");
    const opEntry = fc
      .record({
        date: dateArb.filter((d) => d.startsWith("2025")),
        p: fc.integer({ min: 0, max: pl.length - 1 }),
        b: fc.integer({ min: 0, max: nonEquityBs.length - 1 }),
        amount: fc.integer({ min: -1_000_000, max: 1_000_000 }).filter((n) => n !== 0),
      })
      .map(
        ({ date, p, b, amount }): Entry => ({
          date,
          lines: [
            { accountId: pl[p]!.id, amount },
            { accountId: nonEquityBs[b]!.id, amount: -amount },
          ],
        }),
      );
    fc.assert(
      fc.property(fc.array(opEntry, { maxLength: 30 }), (entries) => {
        const from = "2025-01-01";
        const to = "2025-12-31";
        const p = profitAndLoss(accounts, [{ label: "y", from, to, balances: sums(entries, from, to) }]);
        const net = p.lines.find((l) => l.label === "Net Income")!.values[0]!;
        const bs = balanceSheet(accounts, [
          {
            label: "end",
            asOf: to,
            balances: sums(entries, null, to),
            priorYears: sums(entries, null, "2024-12-31"),
          },
        ]);
        const totalEquity = bs.lines.find((l) => l.label === "Total Equity")!.values[0]!;
        expect(totalEquity).toBe(net);
      }),
      { numRuns: 200 },
    );
  });

  test("tax line summary total equals net of income and expense", () => {
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 25 }), (entries) => {
        const bal = sums(entries, null, null);
        const r = taxLineSummary(accounts, bal, (c) => c ?? "Unmapped", {
          from: "2024-01-01",
          to: "2026-12-31",
        });
        const subtotal = r.lines.filter((l) => l.kind === "subtotal").reduce((s, l) => s + l.values[0]!, 0);
        const expected = accounts
          .filter((a) => a.type === "income" || a.type === "expense")
          .reduce((s, a) => s + (bal.get(a.id) ?? 0) * (a.type === "expense" ? 1 : -1), 0);
        expect(subtotal).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  test("general ledger closing balances equal cumulative balances", () => {
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 25 }), dateArb, (entries, from) => {
        const lines = entries
          .filter((e) => e.date >= from)
          .flatMap((e, i) =>
            e.lines.map((l, j) => ({
              accountId: l.accountId,
              entryId: `e${i}`,
              lineId: `e${i}l${j}`,
              date: e.date,
              memo: null,
              description: null,
              sourceType: "manual",
              amount: l.amount,
              chainSeq: i + 1,
            })),
          );
        const gl = generalLedger(accounts, sums(entries, null, dayBefore(from)), lines);
        const total = sums(entries, null, null);
        for (const g of gl) expect(g.closing).toBe(total.get(g.account.id) ?? 0);
      }),
      { numRuns: 100 },
    );
  });
});

describe("report shapes", () => {
  test("balance sheet folds prior-year P&L into retained earnings and shows current net income", () => {
    const cash = accounts.find((a) => a.subtype === "bank")!;
    const income = accounts.find((a) => a.type === "income")!;
    const re = accounts.find((a) => a.subtype === "retained_earnings")!;
    const entries: Entry[] = [
      {
        date: "2025-06-01",
        lines: [
          { accountId: cash.id, amount: 10000 },
          { accountId: income.id, amount: -10000 },
        ],
      },
      {
        date: "2026-02-01",
        lines: [
          { accountId: cash.id, amount: 2500 },
          { accountId: income.id, amount: -2500 },
        ],
      },
    ];
    const bs = balanceSheet(accounts, [
      {
        label: "x",
        asOf: "2026-03-31",
        balances: sums(entries, null, "2026-03-31"),
        priorYears: sums(entries, null, "2025-12-31"),
      },
    ]);
    expect(bs.lines.find((l) => l.accountId === re.id)!.values[0]).toBe(10000);
    expect(bs.lines.find((l) => l.label.startsWith("Net Income"))!.values[0]).toBe(2500);
    expect(bs.checks.assets_minus_liabilities_equity_0).toBe(0);
  });

  test("P&L renders parent subtotals", () => {
    const cash = accounts.find((a) => a.subtype === "bank")!;
    const entries: Entry[] = [
      {
        date: "2026-01-05",
        lines: [
          { accountId: supplies.id, amount: 700 },
          { accountId: cash.id, amount: -700 },
        ],
      },
      {
        date: "2026-01-06",
        lines: [
          { accountId: office.id, amount: 300 },
          { accountId: cash.id, amount: -300 },
        ],
      },
    ];
    const p = profitAndLoss(accounts, [
      {
        label: "jan",
        from: "2026-01-01",
        to: "2026-01-31",
        balances: sums(entries, "2026-01-01", "2026-01-31"),
      },
    ]);
    const group = p.lines.filter((l) => l.accountId === office.id || l.accountId === supplies.id);
    expect(group.map((l) => [l.kind, l.label, l.depth, l.values[0]])).toEqual([
      ["header", office.name, 1, 0],
      ["account", supplies.name, 2, 700],
      ["account", `${office.name} (Other)`, 2, 300],
      ["subtotal", `Total ${office.name}`, 1, 1000],
    ]);
    expect(p.lines.find((l) => l.label === "Total Expenses")!.values[0]).toBe(1000);
  });

  const jan = (entries: Entry[]) =>
    profitAndLoss(accounts, [
      {
        label: "jan",
        from: "2026-01-01",
        to: "2026-01-31",
        balances: sums(entries, "2026-01-01", "2026-01-31"),
      },
    ]);
  const cashId = () => accounts.find((a) => a.subtype === "bank")!.id;

  test("a parent with no postings of its own gets no (Other) line", () => {
    const p = jan([
      {
        date: "2026-01-05",
        lines: [
          { accountId: supplies.id, amount: 700 },
          { accountId: cashId(), amount: -700 },
        ],
      },
    ]);
    const group = p.lines.filter((l) => l.accountId === office.id || l.accountId === supplies.id);
    expect(group.map((l) => [l.kind, l.label, l.values[0]])).toEqual([
      ["header", office.name, 0],
      ["account", supplies.name, 700],
      ["subtotal", `Total ${office.name}`, 700],
    ]);
  });

  test("a parent whose sub-accounts are all zero prints as a plain account line", () => {
    const p = jan([
      {
        date: "2026-01-06",
        lines: [
          { accountId: office.id, amount: 300 },
          { accountId: cashId(), amount: -300 },
        ],
      },
    ]);
    const group = p.lines.filter((l) => l.accountId === office.id || l.accountId === supplies.id);
    expect(group.map((l) => [l.kind, l.label, l.depth, l.values[0]])).toEqual([
      ["account", office.name, 1, 300],
    ]);
    expect(p.lines.find((l) => l.label === "Total Expenses")!.values[0]).toBe(300);
  });

  test("balance sheet finds Retained Earnings by system key when it has a sub-account", () => {
    const re = accounts.find((a) => a.systemKey === "retained_earnings")!;
    // The child inherits the RE subtype and sorts first, so a subtype lookup would pick it.
    const child: AccountInfo = {
      id: "re-child",
      code: "0001",
      name: "Prior adjustments",
      type: "equity",
      subtype: re.subtype,
      parentId: re.id,
      taxLine: re.taxLine,
      systemKey: null,
    };
    const all = [child, ...accounts];
    const cash = cashId();
    const income = accounts.find((a) => a.type === "income")!;
    const entries: Entry[] = [
      {
        date: "2025-06-01",
        lines: [
          { accountId: cash, amount: 10000 },
          { accountId: income.id, amount: -10000 },
        ],
      },
      {
        date: "2026-01-10",
        lines: [
          { accountId: child.id, amount: 400 },
          { accountId: cash, amount: -400 },
        ],
      },
    ];
    const bs = balanceSheet(all, [
      {
        label: "x",
        asOf: "2026-03-31",
        balances: sums(entries, null, "2026-03-31"),
        priorYears: sums(entries, null, "2025-12-31"),
      },
    ]);
    const group = bs.lines.filter((l) => l.accountId === re.id || l.accountId === child.id);
    expect(group.map((l) => [l.kind, l.label, l.values[0]])).toEqual([
      ["header", re.name, 0],
      ["account", child.name, -400],
      ["account", `${re.name} (Other)`, 10000],
      ["subtotal", `Total ${re.name}`, 9600],
    ]);
    expect(bs.checks.assets_minus_liabilities_equity_0).toBe(0);
  });
});
