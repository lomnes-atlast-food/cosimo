/**
 * Shared plumbing for the product importers: CSV reading with preamble/header sniffing, column lookup,
 * amount/date parsing, account resolution and synthesis, contact merging, and entry validation.
 */
import { type AccountSubtype, type AccountType, centsToDecimal } from "@cosimo/shared";
import Papa from "papaparse";
import { parseCsvAmount, parseDate } from "../import/csv.ts";
import type { DateFormat } from "../import/types.ts";
import type {
  ImportedAccount,
  ImportedContact,
  ImportedEntry,
  ImportedLine,
  ImportIssue,
  ImportSource,
} from "./types.ts";

// ---------- CSV ----------

export interface CsvRow {
  /** 1-based CSV record number. */
  row: number;
  cells: string[];
  blank: boolean;
}

export interface CsvTable {
  /** Record number of the header row. */
  headerRow: number;
  /** Normalized headers (see normHeader). */
  headers: string[];
  rawHeaders: string[];
  /** Rows after the header, including blank ones (flagged). */
  rows: CsvRow[];
}

/** How many leading records are scanned for the real header (report titles, company name, dates...). */
const HEADER_SCAN = 40;

export function readCsv(content: string): CsvRow[] {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const res = Papa.parse<string[]>(text, { skipEmptyLines: false });
  return res.data.map((cells, i) => {
    const cs = Array.isArray(cells) ? cells.map((c) => (c ?? "").toString()) : [];
    return { row: i + 1, cells: cs, blank: cs.every((c) => c.trim() === "") };
  });
}

/** Lowercase, trim, drop Xero's required-field "*", underscores to spaces, collapse whitespace. */
export function normHeader(h: string): string {
  return h
    .replace(/^﻿/, "")
    .trim()
    .replace(/^\*+\s*/, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Find the first record (within the scan window) whose normalized cells satisfy `isHeader`. */
export function findTable(
  rows: CsvRow[],
  isHeader: (headers: string[], raw: string[]) => boolean,
): CsvTable | null {
  const limit = Math.min(rows.length, HEADER_SCAN);
  for (let i = 0; i < limit; i++) {
    const r = rows[i]!;
    if (r.blank) continue;
    const headers = r.cells.map(normHeader);
    if (isHeader(headers, r.cells)) {
      return { headerRow: r.row, headers, rawHeaders: r.cells.map((c) => c.trim()), rows: rows.slice(i + 1) };
    }
  }
  return null;
}

/** Index of the first header equal to one of `aliases` (already normalized), or -1. */
export function col(headers: string[], ...aliases: string[]): number {
  for (const a of aliases) {
    const i = headers.indexOf(a);
    if (i !== -1) return i;
  }
  return -1;
}

export function has(headers: string[], ...aliases: string[]): boolean {
  return col(headers, ...aliases) !== -1;
}

export function cell(cells: string[], idx: number): string {
  return idx < 0 ? "" : (cells[idx] ?? "").trim();
}

export function orNull(s: string): string | null {
  return s === "" ? null : s;
}

const TOTAL_RE = /^(grand\s+)?total(\s+for\b.*|\s*:.*)?$/i;

/**
 * Report total/footer rows: the first non-empty cell is "Total", "TOTAL", "Grand Total", "Total for X" or
 * "Total: ...". A contact named "Total Fitness" is not a total row.
 */
export function isTotalRow(cells: string[]): boolean {
  const first = cells.find((c) => c.trim() !== "");
  return first !== undefined && TOTAL_RE.test(first.trim());
}

const TIME_RE = /\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)\b/i;
const FOOTER_CONTEXT_RE =
  /\b(gmt|utc|cash basis|accrual basis|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

/** Report timestamp footers such as "Friday, March 06, 2026 09:14 AM GMT-08:00" (possibly split on commas). */
export function isFooterRow(cells: string[]): boolean {
  const text = cells
    .map((c) => c.trim())
    .filter(Boolean)
    .join(", ");
  return TIME_RE.test(text) && FOOTER_CONTEXT_RE.test(text) && text.length < 120;
}

/** Blank, total and footer rows are skipped by every parser. */
export function isNoiseRow(r: { blank: boolean; cells: string[] }): boolean {
  return r.blank || isTotalRow(r.cells) || isFooterRow(r.cells);
}

// ---------- values ----------

/** Integer cents from a money cell; 0 for empty. Throws on garbage. Pure string parsing, no floats. */
export function money(raw: string): number {
  const s = raw.trim();
  if (s === "" || s === "-" || s === "--") return 0;
  return parseCsvAmount(s);
}

export function parseDateAny(raw: string, formats: readonly DateFormat[]): string | null {
  const s = raw.trim();
  if (!s) return null;
  for (const f of formats) {
    const d = parseDate(s, f);
    if (d) return d;
  }
  return null;
}

export function truthy(raw: string): boolean {
  return /^(y|yes|true|1|x|checked|on)$/i.test(raw.trim());
}

// ---------- names & type guessing ----------

/** Normalized account name used for keys and lookup: lowercase, trimmed ":" path segments. */
export function normName(s: string): string {
  return s
    .split(":")
    .map((seg) => seg.trim().replace(/\s+/g, " ").toLowerCase())
    .filter((seg) => seg !== "")
    .join(":");
}

export interface TypeGuess {
  type: AccountType;
  subtype: AccountSubtype | null;
}

const NAME_RULES: [RegExp, AccountType, AccountSubtype][] = [
  [/uncategori[sz]ed (income|revenue)/, "income", "uncategorized"],
  [/uncategori[sz]ed|ask my accountant|suspense/, "expense", "uncategorized"],
  [/accumulated (depreciation|amortization)/, "asset", "accumulated_depreciation"],
  [/accounts? receivable|\ba\/r\b|debtors/, "asset", "accounts_receivable"],
  [/accounts? payable|\ba\/p\b|creditors/, "liability", "accounts_payable"],
  [/credit card|\bvisa\b|mastercard|\bamex\b|american express/, "liability", "credit_card"],
  [/opening balance/, "equity", "opening_balance"],
  [/retained earnings/, "equity", "retained_earnings"],
  [/draw|distribution|dividends? paid/, "equity", "owner_draw"],
  [
    /owner'?s? (equity|investment|contribution|capital)|partner|funds introduced|capital|contributions?\b|common stock|preferred stock|paid-in|equity/,
    "equity",
    "owner_equity",
  ],
  [
    /current liabilit|customer deposit|unearned|deferred revenue|sales tax|\bgst\b|\bvat\b|payable|accrued|payroll liabilit/,
    "liability",
    "other_current_liability",
  ],
  [/loan|mortgage|line of credit|notes?\b/, "liability", "long_term_liability"],
  [
    /checking|savings|\bbank\b(?! (fee|charge|service))|petty cash|^cash\b|cash on hand|money market/,
    "asset",
    "bank",
  ],
  [
    /prepaid|prepayment|inventory|undeposited|deposit|receivable|current assets?\b/,
    "asset",
    "other_current_asset",
  ],
  [/cost of (goods|sales)|\bcogs\b|direct cost|purchases|materials/, "expense", "cost_of_goods"],
  [/interest (income|earned)|other income|\bgain\b|dividend income/, "income", "other_income"],
  [/income|revenue|\bsales\b|fees earned|royalt/, "income", "other"],
  [
    /equipment|furniture|vehicle|computer|building|machinery|fixed asset|leasehold|property/,
    "asset",
    "fixed_asset",
  ],
];

/**
 * Guess an account's type from its name alone. Used only for accounts referenced by a ledger but absent
 * from every chart-of-accounts file (QBO/Xero), and as a fallback for unknown product type labels.
 * Rules are checked in order (first match wins): uncategorized, accumulated depreciation, A/R, A/P, credit
 * card, equity words (opening balance, retained earnings, draws, owner/partner capital), current
 * liabilities, loans, bank/cash, other current assets, COGS, other income, income, fixed assets; anything
 * else (rent, fees, meals, software, ...) is an operating expense (expense/other).
 */
export function guessAccountTypeFromName(name: string): TypeGuess {
  const n = name.toLowerCase().replace(/\s+/g, " ");
  // Expense words that would otherwise trip the income/asset rules ("Equipment Rental", "Bank Fees").
  if (/\brent(al)?\b|\blease\b|repairs?|fees?\b|charges?\b|expense|depreciation|guaranteed payment/.test(n)) {
    if (!/accumulated|payable|receivable|prepaid|income|earned/.test(n))
      return { type: "expense", subtype: "other" };
  }
  for (const [re, type, subtype] of NAME_RULES) if (re.test(n)) return { type, subtype };
  return { type: "expense", subtype: "other" };
}

/** Customer/vendor hint from a transaction type label. */
export function contactKindFromLabel(label: string | null): "customer" | "vendor" | null {
  if (!label) return null;
  const l = label.toLowerCase();
  if (/bill|expense|check|cheque|purchase|payable|spend|vendor|supplier/.test(l)) return "vendor";
  if (/invoice|payment|sales receipt|receive|credit memo|receivable|refund receipt|deposit|estimate/.test(l))
    return "customer";
  return null;
}

// ---------- context ----------

export interface PendingLine {
  row: number;
  account: string;
  amount: number;
  description: string | null;
  contact: string | null;
}

export interface PendingEntry {
  file: string;
  row: number;
  date: string | null;
  reference: string | null;
  memo: string | null;
  source_label: string | null;
  external_id: string | null;
  lines: PendingLine[];
  /** Set when a row of the group failed to parse; the group is dropped (the error was already reported). */
  bad: boolean;
}

export function newPending(file: string, row: number): PendingEntry {
  return {
    file,
    row,
    date: null,
    reference: null,
    memo: null,
    source_label: null,
    external_id: null,
    lines: [],
    bad: false,
  };
}

function mergeKind(a: ImportedContact["kind"], b: ImportedContact["kind"] | null): ImportedContact["kind"] {
  if (!b || a === b) return a;
  return "both";
}

export class ImportContext {
  readonly issues: ImportIssue[] = [];
  readonly accounts: ImportedAccount[] = [];
  readonly entries: (ImportedEntry & { order: number })[] = [];
  private readonly byKey = new Map<string, ImportedAccount>();
  private readonly byCode = new Map<string, string>();
  private readonly byFull = new Map<string, string>();
  private readonly byLeaf = new Map<string, string[]>();
  private readonly contacts = new Map<string, ImportedContact>();
  private readonly ledgerContacts = new Map<string, { name: string; kind: ImportedContact["kind"] | null }>();
  private readonly synthWarned = new Set<string>();
  private order = 0;

  constructor(readonly source: ImportSource) {}

  error(file: string, row: number | null, message: string): void {
    this.issues.push({ level: "error", file, row, message });
  }

  warn(file: string, row: number | null, message: string): void {
    this.issues.push({ level: "warning", file, row, message });
  }

  // accounts

  getAccount(key: string): ImportedAccount | undefined {
    return this.byKey.get(key);
  }

  /** Add a chart account. Returns false (and warns) on a duplicate key. */
  addAccount(a: ImportedAccount, file: string, row: number): boolean {
    if (this.byKey.has(a.key)) {
      this.warn(file, row, `Duplicate account "${a.full_name ?? a.name}" (key ${a.key}) ignored`);
      return false;
    }
    this.accounts.push(a);
    this.byKey.set(a.key, a);
    if (a.code) this.byCode.set(a.code.toLowerCase(), a.key);
    const full = normName(a.full_name ?? a.name);
    if (!this.byFull.has(full)) this.byFull.set(full, a.key);
    if (a.code && !this.byFull.has(`${a.code.toLowerCase()} ${full}`))
      this.byFull.set(`${a.code.toLowerCase()} ${full}`, a.key);
    const leaf = normName(a.name);
    this.byLeaf.set(leaf, [...(this.byLeaf.get(leaf) ?? []), a.key]);
    return true;
  }

  /** Look up an existing account by code and/or name as a ledger shows it; never synthesizes. */
  findAccount(code: string | null, name: string | null): string | null {
    if (code) {
      const k = this.byCode.get(code.trim().toLowerCase());
      if (k) return k;
    }
    if (!name) return null;
    const full = normName(name);
    const direct = this.byFull.get(full);
    if (direct) return direct;
    if (this.byCode.has(full)) return this.byCode.get(full)!;
    // "1000 Checking", "6190 Utilities:Internet": try the last path segment, with or without a leading number.
    const segs = full.split(":");
    const last = segs[segs.length - 1] ?? "";
    const m = /^(\S+)\s+(.+)$/.exec(last);
    if (m && segs.length === 1 && this.byCode.has(m[1]!)) return this.byCode.get(m[1]!)!;
    const strippedPath = segs.map((s) => s.replace(/^\d[\d.-]*\s+/, "")).join(":");
    const viaStripped = this.byFull.get(strippedPath);
    if (viaStripped) return viaStripped;
    for (const leaf of [last, m?.[2]]) {
      if (!leaf) continue;
      const ks = this.byLeaf.get(leaf);
      if (ks && ks.length === 1) return ks[0]!;
    }
    return null;
  }

  /**
   * Resolve a ledger account reference, synthesizing an account when no chart file defines it.
   * With `guess` (Wave: Account Group/Type columns) the synthesized account is typed from the ledger and
   * no warning is raised; otherwise the type comes from `guessAccountTypeFromName` and a warning asks the
   * user to review it.
   */
  resolveAccount(
    ref: { code: string | null; name: string | null },
    file: string,
    row: number,
    guess?: { type: AccountType; subtype: AccountSubtype | null; label: string; key?: string },
  ): string | null {
    const found = guess?.key && this.byKey.has(guess.key) ? guess.key : this.findAccount(ref.code, ref.name);
    if (found) return found;
    const rawName = (ref.name ?? "").trim();
    if (!rawName && !ref.code) return null;
    let code = ref.code?.trim() || null;
    let path = rawName.split(":").map((s) => s.trim().replace(/\s+/g, " "));
    if (!code && path.length === 1) {
      const m = /^(\d{3,}[\d.-]*)\s+(.+)$/.exec(path[0]!);
      if (m) [code, path] = [m[1]!, [m[2]!]];
    }
    path = path.map((s) => s.replace(/^\d{3,}[\d.-]*\s+/, ""));
    const fullName = path.join(":") || code!;
    const leaf = path[path.length - 1] || code!;
    const key = guess?.key ?? (code || normName(fullName));
    if (this.byKey.has(key)) return key;
    const parent = path.length > 1 ? this.findAccount(null, path.slice(0, -1).join(":")) : null;
    const t = guess ?? { ...guessAccountTypeFromName(fullName), label: "" };
    this.addAccount(
      {
        key,
        code,
        name: leaf,
        parent,
        type: t.type,
        subtype: t.subtype,
        description: null,
        source_type_label: t.label || "(not in chart of accounts)",
        full_name: fullName,
        synthesized: true,
      },
      file,
      row,
    );
    if (!guess && !this.synthWarned.has(key)) {
      this.synthWarned.add(key);
      this.warn(
        file,
        row,
        `Account "${rawName || code}" is not in the chart of accounts; created as ${t.type}${
          t.subtype ? `/${t.subtype}` : ""
        } from its name. Review its type before importing.`,
      );
    }
    return key;
  }

  // contacts

  addContact(c: ImportedContact): void {
    const k = c.name.trim().toLowerCase();
    if (!k) return;
    const prev = this.contacts.get(k);
    if (!prev) {
      this.contacts.set(k, { ...c, name: c.name.trim() });
      return;
    }
    prev.kind = mergeKind(prev.kind, c.kind);
    prev.email ??= c.email;
    prev.phone ??= c.phone;
    prev.company ??= c.company;
    if (c.is_1099_vendor) prev.is_1099_vendor = true;
    else if (c.is_1099_vendor === false && prev.is_1099_vendor === undefined) prev.is_1099_vendor = false;
  }

  /** Remember a contact name seen on a ledger line (added at finish when no contact file lists it). */
  noteLedgerContact(name: string | null, kind: "customer" | "vendor" | null): void {
    const n = name?.trim();
    if (!n) return;
    const k = n.toLowerCase();
    const prev = this.ledgerContacts.get(k);
    if (!prev) this.ledgerContacts.set(k, { name: n, kind });
    else if (kind) prev.kind = prev.kind ? mergeKind(prev.kind, kind) : kind;
  }

  // entries

  /** Validate and emit a grouped transaction. */
  finishEntry(p: PendingEntry): void {
    if (p.bad) return;
    if (p.lines.length === 0) return;
    const label = p.reference ? ` (${p.reference})` : "";
    if (!p.date) {
      this.error(p.file, p.row, `Transaction${label} has no date; skipped`);
      return;
    }
    const lines: ImportedLine[] = p.lines
      .filter((l) => l.amount !== 0)
      .map((l) => ({ account: l.account, amount: l.amount, description: l.description, contact: l.contact }));
    const diff = lines.reduce((s, l) => s + l.amount, 0);
    if (diff !== 0) {
      this.error(
        p.file,
        p.row,
        `Transaction${label} on ${p.date} does not balance (debits minus credits = ${centsToDecimal(diff)}); skipped`,
      );
      return;
    }
    if (lines.length < 2) {
      this.warn(p.file, p.row, `Transaction${label} on ${p.date} has fewer than 2 non-zero lines; skipped`);
      return;
    }
    this.entries.push({
      date: p.date,
      reference: p.reference,
      memo: p.memo,
      source_label: p.source_label,
      lines,
      external_id: p.external_id,
      file: p.file,
      row: p.row,
      order: this.order++,
    });
  }

  finishContacts(warnDerived: boolean, file: string): ImportedContact[] {
    const derived: string[] = [];
    for (const [k, c] of this.ledgerContacts) {
      if (this.contacts.has(k)) continue;
      this.contacts.set(k, { name: c.name, kind: c.kind ?? "both", email: null, phone: null, company: null });
      derived.push(c.name);
    }
    if (warnDerived && derived.length > 0) {
      this.warn(
        file,
        null,
        `${derived.length} contact(s) appear only in the ledger and were created from it: ${derived.join(", ")}`,
      );
    }
    return [...this.contacts.values()].sort((a, b) => {
      const x = a.name.toLowerCase();
      const y = b.name.toLowerCase();
      return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
  }
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Per-file parse result for stats. */
export interface FileParseResult {
  rows: number;
}

/** Signature of each product's per-kind parser. */
export type KindParser = (ctx: ImportContext, file: string, table: CsvTable) => FileParseResult;

export interface ProductImporter {
  source: ImportSource;
  /** Classify a normalized header row. */
  detect(headers: string[], raw: string[]): "accounts" | "contacts" | "ledger" | null;
  accounts: KindParser;
  contacts: KindParser;
  ledger: KindParser;
  /** Whether ledger-only contacts deserve a warning (true where the product has contact exports). */
  warnDerivedContacts: boolean;
}

/** Report required columns that are missing; returns true when all are present. */
export function requireColumns(
  ctx: ImportContext,
  file: string,
  table: CsvTable,
  required: [label: string, idx: number][],
): boolean {
  const missing = required.filter(([, i]) => i < 0).map(([l]) => l);
  if (missing.length === 0) return true;
  ctx.error(file, table.headerRow, `Missing required column(s): ${missing.join(", ")}; file skipped`);
  return false;
}
