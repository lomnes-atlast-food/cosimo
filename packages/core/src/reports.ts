/**
 * Pure report builders (SPEC §9). Inputs are per-account sums of posted journal lines (debit
 * positive, credit negative) for the relevant period; outputs are generic line/column structures
 * that the server renders to JSON, CSV, and PDF.
 */
import type { AccountType } from "@cosimo/shared";

export interface AccountInfo {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  parentId: string | null;
  taxLine: string | null;
  systemKey?: string | null;
}

/** accountId → raw (debit-positive) sum. */
export type Balances = Map<string, number>;

export interface ReportColumn {
  label: string;
  from?: string | null;
  to?: string | null;
  asOf?: string | null;
}

export interface ReportLine {
  kind: "header" | "account" | "subtotal" | "total" | "check";
  label: string;
  depth: number;
  accountId?: string;
  code?: string;
  values: number[];
}

export interface Report {
  key: string;
  title: string;
  columns: ReportColumn[];
  lines: ReportLine[];
  /** Tie-out checks; each should be zero. */
  checks: Record<string, number>;
}

/** Normalize negative zero so JSON, CSV, and equality checks never see -0. */
function done(r: Report): Report {
  for (const l of r.lines) l.values = l.values.map((v) => v || 0);
  for (const k of Object.keys(r.checks)) r.checks[k] = r.checks[k] || 0;
  return r;
}

const byCode = (a: AccountInfo, b: AccountInfo) => a.code.localeCompare(b.code, undefined, { numeric: true });

function sign(t: AccountType): 1 | -1 {
  return t === "asset" || t === "expense" ? 1 : -1;
}

/** Children by parent id, in code order. Accounts whose parent is outside the list are roots (null). */
function childrenOf(accounts: AccountInfo[]): Map<string | null, AccountInfo[]> {
  const ids = new Set(accounts.map((a) => a.id));
  const children = new Map<string | null, AccountInfo[]>();
  for (const a of accounts) {
    const p = a.parentId && ids.has(a.parentId) ? a.parentId : null;
    const list = children.get(p) ?? [];
    list.push(a);
    children.set(p, list);
  }
  for (const list of children.values()) list.sort(byCode);
  return children;
}

/**
 * Emit account lines for a section, rolling sub-accounts up into their parent. `values(accountId)`
 * returns the display values (already sign-adjusted) per column. Accounts whose subtree is all zero
 * are omitted unless `showZero`.
 *
 * A parent with at least one shown sub-account becomes a group: a header, its sub-accounts, the
 * parent's own postings as "<name> (Other)" (when nonzero), and a "Total <name>" subtotal. A parent
 * whose sub-accounts are all hidden prints as a plain account line.
 */
function sectionLines(
  accounts: AccountInfo[],
  values: (id: string) => number[],
  ncols: number,
  baseDepth: number,
  showZero = false,
): { lines: ReportLine[]; total: number[] } {
  const lines: ReportLine[] = [];
  const children = childrenOf(accounts);
  const zeros = () => new Array(ncols).fill(0) as number[];
  const add = (acc: number[], v: number[]) => {
    for (let i = 0; i < ncols; i++) acc[i]! += v[i] ?? 0;
  };
  const nonzero = (v: number[]) => v.some((x) => x !== 0);
  // Subtree sums, memoized; the depth guard stops a corrupt cycle.
  const rolled = new Map<string, number[]>();
  const rollup = (a: AccountInfo, depth = 0): number[] => {
    const hit = rolled.get(a.id);
    if (hit) return hit;
    const acc = zeros();
    add(acc, values(a.id));
    if (depth < 50) for (const c of children.get(a.id) ?? []) add(acc, rollup(c, depth + 1));
    rolled.set(a.id, acc);
    return acc;
  };
  const emit = (a: AccountInfo, depth: number) => {
    const sub = rollup(a);
    if (!showZero && !nonzero(sub)) return;
    const own = values(a.id);
    const kids = depth < 50 ? (children.get(a.id) ?? []).filter((c) => showZero || nonzero(rollup(c))) : [];
    const d = baseDepth + depth;
    if (!kids.length) {
      lines.push({ kind: "account", label: a.name, depth: d, accountId: a.id, code: a.code, values: own });
      return;
    }
    lines.push({ kind: "header", label: a.name, depth: d, accountId: a.id, code: a.code, values: zeros() });
    for (const c of kids) emit(c, depth + 1);
    if (showZero || nonzero(own))
      lines.push({
        kind: "account",
        label: `${a.name} (Other)`,
        depth: d + 1,
        accountId: a.id,
        code: a.code,
        values: own,
      });
    lines.push({ kind: "subtotal", label: `Total ${a.name}`, depth: d, accountId: a.id, values: sub });
  };
  const total = zeros();
  for (const a of children.get(null) ?? []) {
    add(total, rollup(a));
    emit(a, 0);
  }
  return { lines, total };
}

// ----------------------------------------------------------------------------- trial balance

export function trialBalance(accounts: AccountInfo[], balances: Balances, asOf: string): Report {
  const lines: ReportLine[] = [];
  let debit = 0;
  let credit = 0;
  for (const a of [...accounts].sort(byCode)) {
    const v = balances.get(a.id) ?? 0;
    if (v === 0) continue;
    const d = v > 0 ? v : 0;
    const c = v < 0 ? -v : 0;
    debit += d;
    credit += c;
    lines.push({ kind: "account", label: a.name, code: a.code, accountId: a.id, depth: 0, values: [d, c] });
  }
  lines.push({ kind: "total", label: "Total", depth: 0, values: [debit, credit] });
  return done({
    key: "trial_balance",
    title: "Trial Balance",
    columns: [
      { label: "Debit", asOf },
      { label: "Credit", asOf },
    ],
    lines,
    checks: { debits_minus_credits: debit - credit },
  });
}

// ----------------------------------------------------------------------------- profit and loss

export interface Period {
  label: string;
  from: string;
  to: string;
  balances: Balances;
}

export function profitAndLoss(accounts: AccountInfo[], periods: Period[]): Report {
  const n = periods.length;
  const vals = (id: string, t: AccountType) => periods.map((p) => (p.balances.get(id) ?? 0) * sign(t));
  const income = accounts.filter((a) => a.type === "income");
  const cogs = accounts.filter((a) => a.type === "expense" && a.subtype === "cost_of_goods");
  const expense = accounts.filter((a) => a.type === "expense" && a.subtype !== "cost_of_goods");
  const lines: ReportLine[] = [];

  lines.push({ kind: "header", label: "Income", depth: 0, values: new Array(n).fill(0) });
  const inc = sectionLines(income, (id) => vals(id, "income"), n, 1);
  lines.push(...inc.lines, { kind: "subtotal", label: "Total Income", depth: 0, values: inc.total });

  let gross = inc.total;
  if (cogs.some((a) => periods.some((p) => (p.balances.get(a.id) ?? 0) !== 0))) {
    lines.push({ kind: "header", label: "Cost of Goods Sold", depth: 0, values: new Array(n).fill(0) });
    const cg = sectionLines(cogs, (id) => vals(id, "expense"), n, 1);
    lines.push(...cg.lines, {
      kind: "subtotal",
      label: "Total Cost of Goods Sold",
      depth: 0,
      values: cg.total,
    });
    gross = inc.total.map((v, i) => v - cg.total[i]!);
    lines.push({ kind: "subtotal", label: "Gross Profit", depth: 0, values: gross });
  }

  lines.push({ kind: "header", label: "Expenses", depth: 0, values: new Array(n).fill(0) });
  const ex = sectionLines(expense, (id) => vals(id, "expense"), n, 1);
  lines.push(...ex.lines, { kind: "subtotal", label: "Total Expenses", depth: 0, values: ex.total });

  const net = gross.map((v, i) => v - ex.total[i]!);
  lines.push({ kind: "total", label: "Net Income", depth: 0, values: net });

  // Check: net income equals minus the sum of all income/expense raw balances.
  const raw = periods.map(
    (p) => -[...income, ...cogs, ...expense].reduce((s, a) => s + (p.balances.get(a.id) ?? 0), 0),
  );
  return done({
    key: "profit_and_loss",
    title: "Profit and Loss",
    columns: periods.map((p) => ({ label: p.label, from: p.from, to: p.to })),
    lines,
    checks: Object.fromEntries(raw.map((r, i) => [`net_income_${i}`, r - net[i]!])),
  });
}

// ----------------------------------------------------------------------------- balance sheet

export interface BalanceSheetColumn {
  label: string;
  asOf: string;
  /** Cumulative raw balances of every account through asOf. */
  balances: Balances;
  /** Cumulative raw balances of income/expense accounts before the current fiscal year start. */
  priorYears: Balances;
}

export function balanceSheet(accounts: AccountInfo[], cols: BalanceSheetColumn[]): Report {
  const n = cols.length;
  const bal = (id: string, t: AccountType) => cols.map((c) => (c.balances.get(id) ?? 0) * sign(t));
  const assets = accounts.filter((a) => a.type === "asset");
  const liabilities = accounts.filter((a) => a.type === "liability");
  const equity = accounts.filter((a) => a.type === "equity");
  const pl = accounts.filter((a) => a.type === "income" || a.type === "expense");

  const priorRE = cols.map((c) => -pl.reduce((s, a) => s + (c.priorYears.get(a.id) ?? 0), 0));
  const totalPL = cols.map((c) => -pl.reduce((s, a) => s + (c.balances.get(a.id) ?? 0), 0));
  const currentNI = totalPL.map((v, i) => v - priorRE[i]!);

  const lines: ReportLine[] = [];
  lines.push({ kind: "header", label: "Assets", depth: 0, values: new Array(n).fill(0) });
  const as = sectionLines(assets, (id) => bal(id, "asset"), n, 1);
  lines.push(...as.lines, { kind: "subtotal", label: "Total Assets", depth: 0, values: as.total });

  lines.push({ kind: "header", label: "Liabilities", depth: 0, values: new Array(n).fill(0) });
  const li = sectionLines(liabilities, (id) => bal(id, "liability"), n, 1);
  lines.push(...li.lines, { kind: "subtotal", label: "Total Liabilities", depth: 0, values: li.total });

  lines.push({ kind: "header", label: "Equity", depth: 0, values: new Array(n).fill(0) });
  const reAcct =
    equity.find((a) => a.systemKey === "retained_earnings") ??
    equity.find((a) => a.subtype === "retained_earnings");
  const eqValues = (id: string) => {
    const v = bal(id, "equity");
    // Virtual close: prior years' net income is presented inside Retained Earnings.
    return reAcct && id === reAcct.id ? v.map((x, i) => x + priorRE[i]!) : v;
  };
  const eq = sectionLines(equity, eqValues, n, 1, false);
  const eqLines = eq.lines;
  let eqTotal = eq.total;
  if (!reAcct && priorRE.some((v) => v !== 0)) {
    eqLines.push({ kind: "account", label: "Retained Earnings", depth: 1, values: priorRE });
    eqTotal = eqTotal.map((v, i) => v + priorRE[i]!);
  }
  eqLines.push({ kind: "account", label: "Net Income (current year)", depth: 1, values: currentNI });
  eqTotal = eqTotal.map((v, i) => v + currentNI[i]!);
  lines.push(...eqLines, { kind: "subtotal", label: "Total Equity", depth: 0, values: eqTotal });

  const le = li.total.map((v, i) => v + eqTotal[i]!);
  lines.push({ kind: "total", label: "Total Liabilities and Equity", depth: 0, values: le });

  return done({
    key: "balance_sheet",
    title: "Balance Sheet",
    columns: cols.map((c) => ({ label: c.label, asOf: c.asOf })),
    lines,
    checks: Object.fromEntries(as.total.map((v, i) => [`assets_minus_liabilities_equity_${i}`, v - le[i]!])),
  });
}

// ----------------------------------------------------------------------------- cash flow

export function isCashAccount(a: AccountInfo): boolean {
  return a.type === "asset" && a.subtype === "bank";
}

/**
 * Cash flow statement, indirect method. `start` and `end` are cumulative raw balances before the
 * period and at its end; `period` holds income/expense activity within the period.
 * Every non-cash balance sheet account contributes minus its change, so sections always sum to the
 * change in cash.
 */
export function cashFlow(
  accounts: AccountInfo[],
  col: { label: string; from: string; to: string; start: Balances; end: Balances; period: Balances },
): Report {
  const delta = (id: string) => (col.end.get(id) ?? 0) - (col.start.get(id) ?? 0);
  const pl = accounts.filter((a) => a.type === "income" || a.type === "expense");
  const netIncome = -pl.reduce((s, a) => s + (col.period.get(a.id) ?? 0), 0);
  const lines: ReportLine[] = [];
  const section = (label: string, items: AccountInfo[], extra: ReportLine[] = []) => {
    const rows: ReportLine[] = [...extra];
    let total = extra.reduce((s, l) => s + (l.values[0] ?? 0), 0);
    for (const a of [...items].sort(byCode)) {
      const v = -delta(a.id);
      if (v === 0) continue;
      const verb =
        a.type === "asset"
          ? a.subtype === "accumulated_depreciation"
            ? "Depreciation ("
            : "Change in "
          : "Change in ";
      rows.push({
        kind: "account",
        label: verb === "Depreciation (" ? `Depreciation (${a.name})` : `${verb}${a.name}`,
        depth: 1,
        accountId: a.id,
        code: a.code,
        values: [v],
      });
      total += v;
    }
    lines.push({ kind: "header", label, depth: 0, values: [0] }, ...rows, {
      kind: "subtotal",
      label: `Net cash from ${label.toLowerCase()}`,
      depth: 0,
      values: [total],
    });
    return total;
  };
  const nonCash = accounts.filter((a) => !isCashAccount(a) && a.type !== "income" && a.type !== "expense");
  const isInvesting = (a: AccountInfo) => a.type === "asset" && a.subtype === "fixed_asset";
  const isFinancing = (a: AccountInfo) =>
    a.subtype === "long_term_liability" || (a.type === "equity" && a.subtype !== "retained_earnings");
  const operating = nonCash.filter((a) => !isInvesting(a) && !isFinancing(a));
  const op = section("Operating activities", operating, [
    { kind: "account", label: "Net income", depth: 1, values: [netIncome] },
  ]);
  const inv = section("Investing activities", nonCash.filter(isInvesting));
  const fin = section("Financing activities", nonCash.filter(isFinancing));
  const cash = accounts.filter(isCashAccount);
  const cashStart = cash.reduce((s, a) => s + (col.start.get(a.id) ?? 0), 0);
  const cashEnd = cash.reduce((s, a) => s + (col.end.get(a.id) ?? 0), 0);
  const net = op + inv + fin;
  lines.push(
    { kind: "total", label: "Net change in cash", depth: 0, values: [net] },
    { kind: "account", label: "Cash at beginning of period", depth: 0, values: [cashStart] },
    { kind: "total", label: "Cash at end of period", depth: 0, values: [cashStart + net] },
  );
  return done({
    key: "cash_flow",
    title: "Cash Flow",
    columns: [{ label: col.label, from: col.from, to: col.to }],
    lines,
    checks: { cash_change_mismatch: net - (cashEnd - cashStart) },
  });
}

// ----------------------------------------------------------------------------- tax line summary

export function taxLineSummary(
  accounts: AccountInfo[],
  balances: Balances,
  label: (code: string | null) => string,
  col: { from: string; to: string },
): Report {
  const groups = new Map<string, { amount: number; accounts: AccountInfo[] }>();
  for (const a of accounts) {
    if (a.type !== "income" && a.type !== "expense") continue;
    const v = (balances.get(a.id) ?? 0) * sign(a.type);
    if (v === 0) continue;
    const key = a.taxLine ?? "";
    const g = groups.get(key) ?? { amount: 0, accounts: [] };
    g.amount += v;
    g.accounts.push(a);
    groups.set(key, g);
  }
  const lines: ReportLine[] = [];
  const keys = [...groups.keys()].sort((a, b) =>
    a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, undefined, { numeric: true }),
  );
  for (const k of keys) {
    const g = groups.get(k)!;
    lines.push({ kind: "subtotal", label: label(k || null), depth: 0, values: [g.amount] });
    for (const a of g.accounts.sort(byCode)) {
      lines.push({
        kind: "account",
        label: a.name,
        code: a.code,
        accountId: a.id,
        depth: 1,
        values: [(balances.get(a.id) ?? 0) * sign(a.type)],
      });
    }
  }
  return done({
    key: "tax_line_summary",
    title: "Tax Line Summary",
    columns: [{ label: "Amount", ...col }],
    lines,
    checks: {},
  });
}

// ----------------------------------------------------------------------------- general ledger

export interface GlLine {
  accountId: string;
  entryId: string;
  lineId: string;
  date: string;
  memo: string | null;
  description: string | null;
  sourceType: string;
  amount: number;
  chainSeq: number | null;
}

export interface GlAccount {
  account: AccountInfo;
  opening: number;
  lines: (GlLine & { debit: number; credit: number; balance: number })[];
  closing: number;
  totalDebit: number;
  totalCredit: number;
}

/** General ledger detail with running balances (raw, debit-positive). */
export function generalLedger(accounts: AccountInfo[], opening: Balances, lines: GlLine[]): GlAccount[] {
  const byAccount = new Map<string, GlLine[]>();
  for (const l of lines) {
    const k = l.accountId;
    const list = byAccount.get(k) ?? [];
    list.push(l);
    byAccount.set(k, list);
  }
  const out: GlAccount[] = [];
  for (const a of [...accounts].sort(byCode)) {
    const ls = byAccount.get(a.id) ?? [];
    const open = opening.get(a.id) ?? 0;
    if (ls.length === 0 && open === 0) continue;
    let bal = open;
    let td = 0;
    let tc = 0;
    const rows = ls
      .sort(
        (x, y) =>
          x.date.localeCompare(y.date) ||
          (x.chainSeq ?? 0) - (y.chainSeq ?? 0) ||
          x.lineId.localeCompare(y.lineId),
      )
      .map((l) => {
        bal += l.amount;
        const debit = l.amount > 0 ? l.amount : 0;
        const credit = l.amount < 0 ? -l.amount : 0;
        td += debit;
        tc += credit;
        return { ...l, debit, credit, balance: bal };
      });
    out.push({ account: a, opening: open, lines: rows, closing: bal, totalDebit: td, totalCredit: tc });
  }
  return out;
}

// ----------------------------------------------------------------------------- aging

export interface AgingDoc {
  id: string;
  contactId: string;
  contactName: string;
  number: string;
  issueDate: string;
  dueDate: string;
  open: number;
}

export const AGING_BUCKETS = ["Current", "1-30", "31-60", "61-90", "Over 90"] as const;

export function agingBucket(daysPastDue: number): number {
  if (daysPastDue <= 0) return 0;
  if (daysPastDue <= 30) return 1;
  if (daysPastDue <= 60) return 2;
  if (daysPastDue <= 90) return 3;
  return 4;
}

export function aging(
  key: "ar_aging" | "ap_aging",
  docs: AgingDoc[],
  asOf: string,
  daysBetween: (a: string, b: string) => number,
): Report {
  const byContact = new Map<string, { name: string; values: number[] }>();
  for (const d of docs) {
    if (d.open === 0) continue;
    const b = agingBucket(daysBetween(asOf, d.dueDate));
    const row = byContact.get(d.contactId) ?? { name: d.contactName, values: [0, 0, 0, 0, 0, 0] };
    row.values[b]! += d.open;
    row.values[5]! += d.open;
    byContact.set(d.contactId, row);
  }
  const lines: ReportLine[] = [...byContact.entries()]
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .map(([id, r]) => ({
      kind: "account" as const,
      label: r.name,
      depth: 0,
      accountId: id,
      values: r.values,
    }));
  const total = [0, 0, 0, 0, 0, 0];
  for (const l of lines) {
    l.values.forEach((v, i) => {
      total[i]! += v;
    });
  }
  lines.push({ kind: "total", label: "Total", depth: 0, values: total });
  return done({
    key,
    title: key === "ar_aging" ? "Accounts Receivable Aging" : "Accounts Payable Aging",
    columns: [...AGING_BUCKETS.map((b) => ({ label: b, asOf })), { label: "Total", asOf }],
    lines,
    checks: {},
  });
}
