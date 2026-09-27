/**
 * Wave CSV exports: "Export accounting transactions" (one row per transaction line, grouped by
 * Transaction ID; accounts and contacts are derived from it) plus optional customers/vendors exports.
 * Dates are ISO YYYY-MM-DD.
 */
import type { DateFormat } from "../import/types.ts";
import {
  type CsvTable,
  cell,
  col,
  errMessage,
  type FileParseResult,
  guessAccountTypeFromName,
  has,
  type ImportContext,
  isNoiseRow,
  money,
  newPending,
  normName,
  orNull,
  type PendingEntry,
  type ProductImporter,
  parseDateAny,
  requireColumns,
  type TypeGuess,
} from "./common.ts";

const DATES: readonly DateFormat[] = ["YYYY-MM-DD", "YYYY/MM/DD"];

/**
 * Wave Account Group + Account Type → Cosimo type/subtype. The group fixes the type; the account type
 * picks the subtype. Unknown account types fall back to the name heuristic within the group's type.
 */
export function mapWaveType(group: string, accountType: string, name: string): TypeGuess | null {
  const gr = group.toLowerCase().trim();
  const t = accountType.toLowerCase().replace(/\s+/g, " ").trim();
  const n = name.toLowerCase();
  const type = gr.startsWith("asset")
    ? "asset"
    : gr.startsWith("liabilit")
      ? "liability"
      : gr.startsWith("equity")
        ? "equity"
        : gr.startsWith("income") || gr.startsWith("revenue")
          ? "income"
          : gr.startsWith("expense")
            ? "expense"
            : null;
  if (!type) return null;
  const sub = (s: TypeGuess["subtype"]): TypeGuess => ({ type, subtype: s });
  if (/^uncategori[sz]ed/.test(t) || /^uncategori[sz]ed/.test(n))
    return sub(type === "equity" ? "other" : "uncategorized");
  switch (type) {
    case "asset":
      if (t === "cash and bank") return sub("bank");
      if (/accounts receivable|expected payments from customers/.test(t)) return sub("accounts_receivable");
      if (/property, plant|equipment|fixed asset/.test(t)) return sub("fixed_asset");
      if (/depreciation|amortization/.test(t)) return sub("accumulated_depreciation");
      if (/money in transit|inventory|prepayment|short-term|short term/.test(t))
        return sub("other_current_asset");
      return sub("other");
    case "liability":
      if (t === "credit card") return sub("credit_card");
      if (/loan|line of credit|long-term|long term/.test(t)) return sub("long_term_liability");
      if (/accounts payable|expected payments to vendors/.test(t)) return sub("accounts_payable");
      return sub("other_current_liability");
    case "equity":
      if (/retained earnings/.test(t) || /retained earnings/.test(n)) return sub("retained_earnings");
      if (/draw|distribution/.test(n)) return sub("owner_draw");
      if (
        /owner|investment|contribution|drawing|capital/.test(t) ||
        /owner|investment|contribution|capital/.test(n)
      )
        return sub("owner_equity");
      return sub("other");
    case "income":
      if (/other income|gain/.test(t)) return sub("other_income");
      return sub("other");
    case "expense":
      if (/cost of goods/.test(t)) return sub("cost_of_goods");
      if (/loss on|other expense/.test(t)) return sub("other_expense");
      return sub("other");
  }
}

function detect(h: string[]): "accounts" | "contacts" | "ledger" | null {
  if (has(h, "transaction id") && has(h, "account name", "account id")) return "ledger";
  if (has(h, "customer name", "vendor name") && !has(h, "transaction id")) return "contacts";
  return null;
}

function noAccounts(ctx: ImportContext, file: string, table: CsvTable): FileParseResult {
  ctx.error(
    file,
    table.headerRow,
    "Wave has no separate chart-of-accounts import; accounts come from the transactions export",
  );
  return { rows: 0 };
}

function parseContacts(ctx: ImportContext, file: string, table: CsvTable): FileParseResult {
  const h = table.headers;
  const vendor = has(h, "vendor name") && !has(h, "customer name");
  const nameI = col(h, "customer name", "vendor name", "name");
  const emailI = col(h, "email", "email address");
  const phoneI = col(h, "phone", "phone number", "mobile");
  const companyI = col(h, "company", "company name");
  const firstI = col(h, "contact first name", "first name");
  const lastI = col(h, "contact last name", "last name");
  let rows = 0;
  for (const r of table.rows) {
    if (isNoiseRow(r)) continue;
    const name = cell(r.cells, nameI);
    if (!name) continue;
    rows++;
    const person = [cell(r.cells, firstI), cell(r.cells, lastI)].filter(Boolean).join(" ");
    ctx.addContact({
      name,
      kind: vendor ? "vendor" : "customer",
      email: orNull(cell(r.cells, emailI)),
      phone: orNull(cell(r.cells, phoneI)),
      company: orNull(cell(r.cells, companyI)) ?? (person && person !== name ? name : null),
    });
  }
  return { rows };
}

function parseLedger(ctx: ImportContext, file: string, table: CsvTable): FileParseResult {
  const h = table.headers;
  const idI = col(h, "transaction id");
  const dateI = col(h, "transaction date", "date");
  const nameI = col(h, "account name");
  const acctIdI = col(h, "account id");
  const txDescI = col(h, "transaction description");
  const lineDescI = col(h, "transaction line description");
  const oneI = col(h, "amount (one column)", "amount");
  const debitI = col(h, "debit amount (two column approach)", "debit amount", "debit");
  const creditI = col(h, "credit amount (two column approach)", "credit amount", "credit");
  const customerI = col(h, "customer");
  const vendorI = col(h, "vendor");
  const invI = col(h, "invoice number");
  const billI = col(h, "bill number");
  const notesI = col(h, "notes / memo", "notes", "memo");
  const groupI = col(h, "account group");
  const typeI = col(h, "account type");
  const twoCol = debitI >= 0 && creditI >= 0;
  const required: [string, number][] = [
    ["Transaction ID", idI],
    ["Transaction Date", dateI],
    ["Account Name", nameI >= 0 ? nameI : acctIdI],
  ];
  if (!twoCol && oneI < 0) required.push(["Debit Amount / Credit Amount", -1]);
  if (!requireColumns(ctx, file, table, required)) return { rows: 0 };
  if (!twoCol)
    ctx.warn(
      file,
      table.headerRow,
      "No Debit/Credit Amount columns; using Amount (One column) with positive = debit",
    );

  const groups = new Map<string, PendingEntry>();
  let rows = 0;
  for (const r of table.rows) {
    if (isNoiseRow(r)) continue;
    const c = r.cells;
    const id = cell(c, idI);
    const name = cell(c, nameI);
    const acctId = cell(c, acctIdI);
    if (!id && !name && !acctId) continue;
    rows++;
    if (!id) {
      ctx.error(file, r.row, "Line has no Transaction ID; skipped");
      continue;
    }
    let p = groups.get(id);
    const inv = orNull(cell(c, invI));
    const bill = orNull(cell(c, billI));
    if (!p) {
      p = newPending(file, r.row);
      const rawDate = cell(c, dateI);
      p.date = parseDateAny(rawDate, DATES);
      if (!p.date) {
        ctx.error(file, r.row, `Unrecognized date "${rawDate}" (expected YYYY-MM-DD); transaction skipped`);
        p.bad = true;
      }
      p.external_id = id;
      groups.set(id, p);
    }
    p.memo ??= orNull(cell(c, txDescI)) ?? orNull(cell(c, notesI));
    p.reference ??= inv ?? bill;
    p.source_label ??= inv ? "Invoice" : bill ? "Bill" : null;
    let amount: number;
    try {
      amount = twoCol ? money(cell(c, debitI)) - money(cell(c, creditI)) : money(cell(c, oneI));
    } catch (e) {
      ctx.error(file, r.row, `Invalid amount: ${errMessage(e)}; transaction skipped`);
      p.bad = true;
      continue;
    }
    const group = cell(c, groupI);
    const atype = cell(c, typeI);
    const displayName = name || acctId;
    const mapped = group ? (mapWaveType(group, atype, displayName) ?? null) : null;
    const guess = mapped
      ? {
          ...mapped,
          subtype:
            mapped.subtype === "other" && mapped.type === guessAccountTypeFromName(displayName).type
              ? guessAccountTypeFromName(displayName).subtype
              : mapped.subtype,
          label: [group, atype].filter(Boolean).join(" / "),
          key: acctId || normName(displayName),
        }
      : undefined;
    const account = ctx.resolveAccount({ code: null, name: displayName }, file, r.row, guess);
    if (!account) {
      p.bad = true;
      continue;
    }
    const customer = orNull(cell(c, customerI));
    const vendor = orNull(cell(c, vendorI));
    ctx.noteLedgerContact(customer, "customer");
    ctx.noteLedgerContact(vendor, "vendor");
    p.lines.push({
      row: r.row,
      account,
      amount,
      description: orNull(cell(c, lineDescI)),
      contact: customer ?? vendor,
    });
  }
  for (const p of groups.values()) ctx.finishEntry(p);
  return { rows };
}

export const wave: ProductImporter = {
  source: "wave",
  detect,
  accounts: noAccounts,
  contacts: parseContacts,
  ledger: parseLedger,
  warnDerivedContacts: false,
};
