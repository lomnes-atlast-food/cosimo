import { parseCents } from "@cosimo/shared";
import Papa from "papaparse";
import {
  type CsvProfile,
  DATE_FORMATS,
  type DateFormat,
  DEFAULT_OUTFLOW_TYPES,
  type ParsedTxn,
  type ParseError,
  type ParseResult,
} from "./types.ts";

interface CsvRecord {
  /** 1-based record index in the source file, counting skipped and header rows. */
  row: number;
  cells: string[];
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function skipLines(text: string, n: number): string {
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const nl = text.indexOf("\n", pos);
    if (nl === -1) return "";
    pos = nl + 1;
  }
  return text.slice(pos);
}

function isBlank(cells: string[]): boolean {
  return cells.every((c) => c.trim() === "");
}

function readRecords(
  text: string,
  delimiter: string | null | undefined,
  skipRows: number,
): { records: CsvRecord[]; delimiter: string } {
  const body = skipLines(stripBom(text), Math.max(0, skipRows));
  const res = Papa.parse<string[]>(body, { delimiter: delimiter ?? "", skipEmptyLines: false });
  const records: CsvRecord[] = [];
  res.data.forEach((cells, i) => {
    if (!Array.isArray(cells) || isBlank(cells)) return;
    records.push({ row: skipRows + i + 1, cells: cells.map((c) => (c ?? "").toString()) });
  });
  return { records, delimiter: res.meta.delimiter || delimiter || "," };
}

/**
 * Parse CSV text into a table. With `hasHeader` (default true) the first non-blank row after `skipRows`
 * becomes `headers`; otherwise every row is data and `headers` are generic "Column N" labels.
 */
export function readCsvTable(
  text: string,
  opts: { delimiter?: string | null; skipRows?: number; hasHeader?: boolean } = {},
): { headers: string[]; rows: string[][]; delimiter: string } {
  const { records, delimiter } = readRecords(text, opts.delimiter, opts.skipRows ?? 0);
  const hasHeader = opts.hasHeader ?? true;
  const rows = records.map((r) => r.cells);
  if (hasHeader) {
    const [first = [], ...rest] = rows;
    return { headers: first.map((h) => h.trim()), rows: rest, delimiter };
  }
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  return { headers: Array.from({ length: width }, (_, i) => `Column ${i + 1}`), rows, delimiter };
}

// ---------- dates ----------

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function monthFromName(s: string): number | null {
  const k = s.toLowerCase().replace(/\.$/, "");
  return MONTHS[k] ?? MONTHS[k.slice(0, 3)] ?? null;
}

function expandYear(y: string): number {
  const n = Number(y);
  if (y.length === 2) return n < 70 ? 2000 + n : 1900 + n;
  return n;
}

function isValidDate(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1900 || y > 2199 || m < 1 || m > 12 || d < 1) return false;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= dim;
}

const TIME_SUFFIX = String.raw`(?:[T\s]+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:[AaPp][Mm])?\s*(?:Z|[+-]\d{2}:?\d{2})?)?`;
const MON = "([A-Za-z]{3,9}\\.?)";

type Order = "ymd" | "mdy" | "dmy" | "Mdy" | "dMy";
const DATE_PATTERNS: Record<DateFormat, { re: RegExp; order: Order }> = {
  "YYYY-MM-DD": { re: /^(\d{4})-(\d{1,2})-(\d{1,2})/, order: "ymd" },
  "MM/DD/YYYY": { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})/, order: "mdy" },
  "DD/MM/YYYY": { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})/, order: "dmy" },
  "M/D/YY": { re: /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})/, order: "mdy" },
  "D/M/YY": { re: /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})/, order: "dmy" },
  YYYYMMDD: { re: /^(\d{4})(\d{2})(\d{2})/, order: "ymd" },
  "DD.MM.YYYY": { re: /^(\d{1,2})\.(\d{1,2})\.(\d{4})/, order: "dmy" },
  "MMM D, YYYY": { re: new RegExp(`^${MON}\\s+(\\d{1,2}),?\\s+(\\d{4})`), order: "Mdy" },
  "YYYY/MM/DD": { re: /^(\d{4})\/(\d{1,2})\/(\d{1,2})/, order: "ymd" },
  "MM-DD-YYYY": { re: /^(\d{1,2})-(\d{1,2})-(\d{4})/, order: "mdy" },
  "DD-MM-YYYY": { re: /^(\d{1,2})-(\d{1,2})-(\d{4})/, order: "dmy" },
  "D MMM YYYY": { re: new RegExp(`^(\\d{1,2})[\\s-]${MON}[\\s-](\\d{2}|\\d{4})`), order: "dMy" },
};
const DATE_RES = Object.fromEntries(
  Object.entries(DATE_PATTERNS).map(([k, v]) => [k, new RegExp(`${v.re.source}${TIME_SUFFIX}$`)]),
) as Record<DateFormat, RegExp>;

/** Parse a date string in the given format to YYYY-MM-DD, or null if it is not a real calendar date. */
export function parseDate(s: string, fmt: DateFormat): string | null {
  const m = DATE_RES[fmt].exec(s.trim());
  if (!m) return null;
  const [, a = "", b = "", c = ""] = m;
  let y: number;
  let mo: number | null;
  let d: number;
  switch (DATE_PATTERNS[fmt].order) {
    case "ymd":
      [y, mo, d] = [expandYear(a), Number(b), Number(c)];
      break;
    case "mdy":
      [y, mo, d] = [expandYear(c), Number(a), Number(b)];
      break;
    case "dmy":
      [y, mo, d] = [expandYear(c), Number(b), Number(a)];
      break;
    case "Mdy":
      [y, mo, d] = [expandYear(c), monthFromName(a), Number(b)];
      break;
    case "dMy":
      [y, mo, d] = [expandYear(c), monthFromName(b), Number(a)];
      break;
  }
  if (mo === null || !isValidDate(y, mo, d)) return null;
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// ---------- amounts ----------

/** Normalize common bank amount spellings into something parseCents accepts, then parse to cents. */
export function parseCsvAmount(raw: string): number {
  let s = raw.trim().replace(/\s+/g, "");
  s = s.replace(/^(USD|EUR|GBP|CAD|AUD)/i, "").replace(/(USD|EUR|GBP|CAD|AUD)$/i, "");
  // "$-12.34" -> "-$12.34"
  s = s.replace(/^([$€£])([+-])/, "$2$1");
  // trailing minus "12.34-"
  if (/^[^-]+-$/.test(s)) s = `-${s.slice(0, -1)}`;
  // European "1.234,56" or comma decimal "12,34"
  if (/^[+-]?[$€£]?\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else if (/^[+-]?[$€£]?\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".");
  return parseCents(s);
}

// ---------- apply ----------

/** Statement rows that carry a balance, not a transaction (e.g. "Beginning balance as of 01/01/2026"). */
const BALANCE_MARKER = /^(beginning|opening|starting|ending|closing) balance\b/i;

const INFLOW_TYPES = ["credit", "cr", "deposit", "c", "in", "income", "refund"];

function cell(cells: string[], idx: number | null | undefined): string {
  if (idx === null || idx === undefined || idx < 0) return "";
  return (cells[idx] ?? "").trim();
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Apply a column-mapping profile to CSV text. Never throws for row-level problems; they are returned in
 * `errors` with the 1-based source row number.
 *
 * amount_type: when the type cell matches `outflowTypes` the amount is negative, when it matches a known
 * inflow word ("credit", "cr", "deposit", ...) it is positive; otherwise the amount is taken as signed and
 * `signConvention` applies.
 */
export function applyProfile(text: string, p: CsvProfile): ParseResult {
  const { records } = readRecords(text, p.delimiter, p.skipRows);
  const data = p.hasHeader ? records.slice(1) : records;
  const rows: ParsedTxn[] = [];
  const errors: ParseError[] = [];
  const outflow = new Set((p.outflowTypes ?? DEFAULT_OUTFLOW_TYPES).map((t) => t.trim().toLowerCase()));
  const inflow = new Set(INFLOW_TYPES.filter((t) => !outflow.has(t)));
  const flip = p.signConvention === "positive_is_withdrawal" ? -1 : 1;

  for (const { row, cells } of data) {
    try {
      const rawDate = cell(cells, p.columns.date);
      if (!rawDate) throw new Error("missing date");
      const date = parseDate(rawDate, p.dateFormat);
      if (!date) throw new Error(`invalid date ${JSON.stringify(rawDate)} for format ${p.dateFormat}`);

      let amount: number;
      if (p.amountMode === "debit_credit") {
        const d = cell(cells, p.columns.debit);
        const c = cell(cells, p.columns.credit);
        if (!d && !c) throw new Error("missing amount (debit and credit both blank)");
        amount = (c ? Math.abs(parseCsvAmount(c)) : 0) - (d ? Math.abs(parseCsvAmount(d)) : 0);
      } else {
        const a = cell(cells, p.columns.amount);
        if (!a && BALANCE_MARKER.test(cell(cells, p.columns.description))) continue;
        if (!a) throw new Error("missing amount");
        const v = parseCsvAmount(a);
        if (p.amountMode === "amount_type") {
          const t = cell(cells, p.columns.type).toLowerCase();
          if (outflow.has(t)) amount = -Math.abs(v);
          else if (inflow.has(t)) amount = Math.abs(v);
          else amount = v * flip;
        } else {
          amount = v * flip;
        }
      }
      if (amount === 0) throw new Error("zero amount");

      let description = cell(cells, p.columns.description);
      const memo = cell(cells, p.columns.memo);
      if (memo && memo !== description) description = description ? `${description} - ${memo}` : memo;
      const payee = cell(cells, p.columns.payee) || null;
      if (!description && payee) description = payee;

      rows.push({ date, amount, description, payee, providerId: null, row });
    } catch (e) {
      errors.push({ row, message: errMessage(e) });
    }
  }
  return { rows, errors };
}

// ---------- guessing ----------

const SAMPLE = 25;

function isAmountLike(s: string): boolean {
  const t = s.trim();
  if (!t || !/\d/.test(t)) return false;
  try {
    parseCsvAmount(t);
    return true;
  } catch {
    return false;
  }
}

function anyDate(s: string): boolean {
  return DATE_FORMATS.some((f) => parseDate(s, f) !== null);
}

function findHeader(headers: string[], patterns: RegExp[], exclude: Set<number>): number | null {
  for (const re of patterns) {
    const i = headers.findIndex((h, idx) => !exclude.has(idx) && re.test(h));
    if (i !== -1) return i;
  }
  return null;
}

function modeWidth(rows: string[][]): number {
  const counts = new Map<number, number>();
  for (const r of rows) if (r.length > 1) counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
  let best = 0;
  let bestN = -1;
  for (const [w, n] of counts) if (n > bestN || (n === bestN && w > best)) [best, bestN] = [w, n];
  return best;
}

/**
 * Inspect CSV text and propose a profile: preamble rows to skip, header presence, date column and format,
 * description/payee/memo columns and the amount mode. Callers should show `preview` and let the user fix it.
 */
export function guessProfile(text: string): { profile: CsvProfile; headers: string[]; preview: string[][] } {
  const all = readRecords(text, null, 0);
  const allRows = all.records.map((r) => r.cells);
  const width = modeWidth(allRows);
  // Anchor on the first row that holds a date: the header is the text row right above it. This skips
  // a summary block even when it is nearly as wide as the table (Bank of America's is 3 of 4 columns).
  const firstDated = allRows.findIndex((r) => r.length >= 2 && r.some((c) => anyDate(c)));
  const above = allRows[firstDated - 1];
  const headerAbove =
    firstDated > 0 &&
    above !== undefined &&
    above.length >= Math.max(2, width - 1) &&
    !above.some((c) => anyDate(c)) &&
    above.filter((c) => /[A-Za-z]/.test(c)).length >= 2;
  const firstFull = headerAbove
    ? firstDated - 1
    : firstDated > 0
      ? firstDated
      : allRows.findIndex((r) => r.length >= Math.max(2, width - 1));
  const skipRows = firstFull > 0 ? (all.records[firstFull]?.row ?? 1) - 1 : 0;

  const table = readCsvTable(text, { delimiter: all.delimiter, skipRows, hasHeader: false });
  const first = table.rows[0] ?? [];
  const hasHeader =
    first.length > 0 && !first.some((c) => anyDate(c)) && first.some((c) => /[A-Za-z]/.test(c));
  const headers = hasHeader ? first.map((h) => h.trim()) : table.headers;
  const data = (hasHeader ? table.rows.slice(1) : table.rows).slice(0, SAMPLE);
  const ncols = Math.max(headers.length, ...data.map((r) => r.length));
  const hl = headers.map((h) => (hasHeader ? h.toLowerCase() : ""));
  const col = (i: number) => data.map((r) => (r[i] ?? "").trim()).filter((v) => v !== "");

  // Date column and format.
  let dateCol = -1;
  let dateFormat: DateFormat = "MM/DD/YYYY";
  let bestScore = 0;
  for (let i = 0; i < ncols; i++) {
    const vals = col(i);
    if (vals.length === 0) continue;
    for (const f of DATE_FORMATS) {
      const ok = vals.filter((v) => parseDate(v, f) !== null).length / vals.length;
      const score = ok + (/date|posted/.test(hl[i] ?? "") ? 0.05 : 0);
      if (ok >= 0.8 && score > bestScore) [dateCol, dateFormat, bestScore] = [i, f, score];
    }
  }
  if (dateCol === -1) dateCol = 0;

  const used = new Set<number>([dateCol]);
  const numericCols: number[] = [];
  for (let i = 0; i < ncols; i++) {
    if (used.has(i)) continue;
    const vals = col(i);
    if (vals.length > 0 && vals.every(isAmountLike)) numericCols.push(i);
  }
  const balance = findHeader(hl, [/balance|\bbal\b/], used);
  if (balance !== null) used.add(balance);

  let amountMode: CsvProfile["amountMode"] = "signed";
  let amount: number | null = null;
  let debit = findHeader(hl, [/debit|withdrawal|money out|paid out|outflow/], used);
  if (debit !== null && !numericCols.includes(debit)) debit = null;
  let credit = findHeader(hl, [/credit|deposit|money in|paid in|inflow/], new Set([...used, debit ?? -1]));
  if (credit !== null && !numericCols.includes(credit)) credit = null;
  const typeCol = findHeader(
    hl,
    [/^(transaction )?type$/, /dr\/cr|cr\/dr|debit\/credit|credit\/debit|^d\/c$|^c\/d$/],
    used,
  );

  if (debit !== null && credit !== null) {
    amountMode = "debit_credit";
  } else {
    amount = findHeader(hl, [/^amount$/, /amount|amt/], used);
    if (amount === null) {
      const candidates = numericCols.filter((i) => i !== balance);
      const [a, b] = candidates;
      // Two numeric columns that are never both filled in look like debit/credit.
      if (a !== undefined && b !== undefined && !hasHeader) {
        const complementary = data.every((r) => !((r[a] ?? "").trim() && (r[b] ?? "").trim()));
        if (complementary) [amountMode, debit, credit] = ["debit_credit", a, b];
      }
      if (amountMode === "signed") amount = a ?? null;
    }
    if (amountMode === "signed" && amount !== null && typeCol !== null) {
      const anyNegative = col(amount).some((v) => {
        try {
          return parseCsvAmount(v) < 0;
        } catch {
          return false;
        }
      });
      const typeVals = col(typeCol).map((v) => v.toLowerCase());
      const known = new Set([...DEFAULT_OUTFLOW_TYPES, ...INFLOW_TYPES]);
      if (!anyNegative && typeVals.length > 0 && typeVals.every((v) => known.has(v)))
        amountMode = "amount_type";
    }
  }
  for (const i of [amount, debit, credit, amountMode === "amount_type" ? typeCol : null])
    if (i !== null) used.add(i);
  for (const i of numericCols) used.add(i);

  let description = findHeader(
    hl,
    [/^description$/, /description|narrative|details|transaction/, /memo|payee|merchant|name|reference/],
    used,
  );
  if (description === null) {
    let bestLen = -1;
    for (let i = 0; i < ncols; i++) {
      if (used.has(i)) continue;
      const vals = col(i);
      const avg = vals.reduce((n, v) => n + v.length, 0) / Math.max(1, data.length);
      if (avg > bestLen) [description, bestLen] = [i, avg];
    }
  }
  description ??= 0;
  used.add(description);
  const payee = findHeader(hl, [/payee|merchant|^name$/], used);
  if (payee !== null) used.add(payee);
  const memo = findHeader(hl, [/memo|notes?$/], used);

  const profile: CsvProfile = {
    hasHeader,
    skipRows,
    delimiter: table.delimiter,
    dateFormat,
    amountMode,
    signConvention: "positive_is_deposit",
    columns: {
      date: dateCol,
      description,
      amount: amountMode === "debit_credit" ? null : amount,
      debit: amountMode === "debit_credit" ? debit : null,
      credit: amountMode === "debit_credit" ? credit : null,
      type: amountMode === "amount_type" ? typeCol : null,
      payee,
      memo,
    },
  };
  if (amountMode === "amount_type") profile.outflowTypes = [...DEFAULT_OUTFLOW_TYPES];
  return { profile, headers, preview: data.slice(0, 10) };
}
