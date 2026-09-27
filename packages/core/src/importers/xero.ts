/**
 * Xero CSV exports: Chart of Accounts, Contacts, and the Journal Report (or General Ledger detail with a
 * journal number column). Dates: "5 Jan 2026", DD/MM/YYYY, or ISO.
 */
import type { DateFormat } from "../import/types.ts";
import {
  type CsvTable,
  cell,
  col,
  contactKindFromLabel,
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
  truthy,
} from "./common.ts";

const DATES: readonly DateFormat[] = ["D MMM YYYY", "YYYY-MM-DD", "DD/MM/YYYY", "D/M/YY", "MMM D, YYYY"];

const CARD_RE = /credit card|\bvisa\b|mastercard|\bamex\b|american express/i;

/** Xero account type → Cosimo type/subtype; null for unknown labels (caller falls back to the name). */
export function mapXeroType(typeLabel: string, name: string, code: string | null): TypeGuess | null {
  const t = typeLabel
    .toLowerCase()
    .replace(/[\s-]+/g, " ")
    .trim();
  const n = name.toLowerCase();
  let g: TypeGuess | null = null;
  switch (t) {
    case "bank":
      // Xero keeps credit cards as bank accounts; a card-like name makes it a liability.
      g = CARD_RE.test(n)
        ? { type: "liability", subtype: "credit_card" }
        : { type: "asset", subtype: "bank" };
      break;
    case "credit card":
      g = { type: "liability", subtype: "credit_card" };
      break;
    case "current asset":
    case "current":
      g =
        /receivable|debtors/.test(n) || code === "610"
          ? { type: "asset", subtype: "accounts_receivable" }
          : { type: "asset", subtype: "other_current_asset" };
      break;
    case "inventory":
    case "prepayment":
      g = { type: "asset", subtype: "other_current_asset" };
      break;
    case "fixed asset":
    case "fixed":
      g = {
        type: "asset",
        subtype: /accumulated|depreciation/.test(n) ? "accumulated_depreciation" : "fixed_asset",
      };
      break;
    case "non current asset":
    case "term asset":
      g = {
        type: "asset",
        subtype: /accumulated|depreciation/.test(n) ? "accumulated_depreciation" : "other",
      };
      break;
    case "current liability":
      g =
        /accounts payable|creditors/.test(n) || code === "800"
          ? { type: "liability", subtype: "accounts_payable" }
          : { type: "liability", subtype: "other_current_liability" };
      break;
    case "liability":
      g = { type: "liability", subtype: "other" };
      break;
    case "non current liability":
    case "term liability":
      g = { type: "liability", subtype: "long_term_liability" };
      break;
    case "equity":
      if (/retained earnings/.test(n)) g = { type: "equity", subtype: "retained_earnings" };
      else if (/opening balance/.test(n)) g = { type: "equity", subtype: "opening_balance" };
      else if (/drawing|draw|distribution|dividend/.test(n)) g = { type: "equity", subtype: "owner_draw" };
      else if (/funds introduced|owner|partner|capital|contribution|investment|share/.test(n))
        g = { type: "equity", subtype: "owner_equity" };
      else g = { type: "equity", subtype: "other" };
      break;
    case "revenue":
    case "sales":
      g = { type: "income", subtype: "other" };
      break;
    case "other income":
      g = { type: "income", subtype: "other_income" };
      break;
    case "direct costs":
    case "direct cost":
      g = { type: "expense", subtype: "cost_of_goods" };
      break;
    case "expense":
    case "overhead":
    case "overheads":
    case "depreciation":
      g = { type: "expense", subtype: "other" };
      break;
  }
  if (g && /^uncategori[sz]ed/.test(n) && g.type !== "equity") g = { ...g, subtype: "uncategorized" };
  return g;
}

function detect(h: string[]): "accounts" | "contacts" | "ledger" | null {
  if (
    (has(h, "account code") || has(h, "journal number", "journal #", "journal no.", "journal no")) &&
    has(h, "debit", "credit", "net")
  )
    return "ledger";
  if (has(h, "contactname", "contact name") && !has(h, "debit", "credit")) return "contacts";
  if (has(h, "code") && has(h, "name") && has(h, "type")) return "accounts";
  return null;
}

function parseAccounts(ctx: ImportContext, file: string, table: CsvTable): FileParseResult {
  const h = table.headers;
  const codeI = col(h, "code", "account code");
  const nameI = col(h, "name", "account name");
  const typeI = col(h, "type", "account type");
  const descI = col(h, "description");
  if (
    !requireColumns(ctx, file, table, [
      ["*Name", nameI],
      ["*Type", typeI],
    ])
  )
    return { rows: 0 };
  let rows = 0;
  for (const r of table.rows) {
    if (isNoiseRow(r)) continue;
    const name = cell(r.cells, nameI);
    const typeLabel = cell(r.cells, typeI);
    if (!name || !typeLabel) continue;
    rows++;
    const code = orNull(cell(r.cells, codeI));
    let g = mapXeroType(typeLabel, name, code);
    if (!g) {
      g = guessAccountTypeFromName(name);
      ctx.warn(file, r.row, `Unknown Xero account type "${typeLabel}" for "${name}"; guessed ${g.type}`);
    }
    ctx.addAccount(
      {
        key: code ?? normName(name),
        code,
        name,
        parent: null,
        type: g.type,
        subtype: g.subtype,
        description: orNull(cell(r.cells, descI)),
        source_type_label: typeLabel,
      },
      file,
      r.row,
    );
  }
  return { rows };
}

function parseContacts(ctx: ImportContext, file: string, table: CsvTable): FileParseResult {
  const h = table.headers;
  const nameI = col(h, "contactname", "contact name", "name");
  const emailI = col(h, "emailaddress", "email address", "email");
  const firstI = col(h, "firstname", "first name");
  const lastI = col(h, "lastname", "last name");
  const phoneI = col(h, "phonenumber", "phone number", "phone");
  const areaI = col(h, "phoneareacode", "phone area code");
  const countryI = col(h, "phonecountrycode", "phone country code");
  const mobileI = col(h, "mobilenumber", "mobile number", "mobile");
  const companyI = col(h, "companyname", "company name", "company");
  const custI = col(h, "iscustomer", "is customer", "customer");
  const suppI = col(h, "issupplier", "is supplier", "supplier");
  const t1099I = col(h, "1099", "track 1099", "is1099", "1099 vendor");
  if (!requireColumns(ctx, file, table, [["*ContactName", nameI]])) return { rows: 0 };
  let rows = 0;
  for (const r of table.rows) {
    if (isNoiseRow(r)) continue;
    let name = cell(r.cells, nameI);
    if (!name) name = [cell(r.cells, firstI), cell(r.cells, lastI)].filter(Boolean).join(" ");
    if (!name) continue;
    rows++;
    let kind: "customer" | "vendor" | "both" = "both";
    if (custI >= 0 || suppI >= 0) {
      const c = truthy(cell(r.cells, custI));
      const s = truthy(cell(r.cells, suppI));
      kind = c && !s ? "customer" : s && !c ? "vendor" : "both";
    }
    const number = cell(r.cells, phoneI);
    const phone = number
      ? [cell(r.cells, countryI), cell(r.cells, areaI), number].filter(Boolean).join(" ")
      : cell(r.cells, mobileI);
    ctx.addContact({
      name,
      kind,
      email: orNull(cell(r.cells, emailI)),
      phone: orNull(phone),
      company: orNull(cell(r.cells, companyI)),
      ...(t1099I >= 0 ? { is_1099_vendor: truthy(cell(r.cells, t1099I)) } : {}),
    });
  }
  return { rows };
}

function parseLedger(ctx: ImportContext, file: string, table: CsvTable): FileParseResult {
  const h = table.headers;
  const dateI = col(h, "date", "journal date", "transaction date");
  const jnumI = col(h, "journal number", "journal #", "journal no.", "journal no", "journal");
  const sourceI = col(h, "source", "source type", "type");
  const descI = col(h, "description", "narration", "line description");
  const refI = col(h, "reference", "ref");
  const contactI = col(h, "contact", "contact name", "name");
  const codeI = col(h, "account code", "code");
  const acctI = col(h, "account", "account name");
  const debitI = col(h, "debit");
  const creditI = col(h, "credit");
  const netI = col(h, "net", "net amount");
  const twoCol = debitI >= 0 && creditI >= 0;
  const required: [string, number][] = [
    ["Date", dateI],
    ["Account Code or Account", codeI >= 0 ? codeI : acctI],
  ];
  if (!twoCol && netI < 0) required.push(["Debit and Credit", -1]);
  if (!requireColumns(ctx, file, table, required)) return { rows: 0 };

  const groups = new Map<string, PendingEntry>();
  let lastDate = "";
  let headingJnum = "";
  let lastKey = "";
  let rows = 0;
  for (const r of table.rows) {
    if (isNoiseRow(r)) continue;
    const c = r.cells;
    const code = orNull(cell(c, codeI));
    const acct = orNull(cell(c, acctI));
    const rawD = cell(c, debitI);
    const rawC = cell(c, creditI);
    const rawN = cell(c, netI);
    const rawDate = cell(c, dateI);
    if (!code && !acct) {
      if (rawD || rawC || rawN) continue; // journal subtotal row
      // Journal heading rows ("5 Jan 2026", "#12", "Journal 12") set context for the lines that follow.
      for (const v of c.map((x) => x.trim()).filter(Boolean)) {
        if (parseDateAny(v, DATES)) lastDate = v;
        const m = /^(?:journal\s*)?#\s*(\d+)$|^journal\s+(\d+)$/i.exec(v);
        if (m) headingJnum = m[1] ?? m[2] ?? "";
      }
      continue;
    }
    rows++;
    const dateStr = rawDate || lastDate;
    if (rawDate) lastDate = rawDate;
    let jnum = cell(c, jnumI);
    if (!jnum && jnumI < 0) jnum = headingJnum;
    const source = orNull(cell(c, sourceI));
    const ref = orNull(cell(c, refI));
    const contact = orNull(cell(c, contactI));
    let key: string;
    if (jnum) key = `j:${jnum}`;
    else if (!rawDate && lastKey)
      key = lastKey; // continuation line of the current journal
    else key = `k:${[dateStr, ref, source, contact].join("\u0000")}`;
    lastKey = key;

    let p = groups.get(key);
    if (!p) {
      p = newPending(file, r.row);
      p.date = parseDateAny(dateStr, DATES);
      if (!p.date) {
        ctx.error(
          file,
          r.row,
          dateStr
            ? `Unrecognized date "${dateStr}" (expected e.g. 5 Jan 2026, DD/MM/YYYY or YYYY-MM-DD); transaction skipped`
            : "Line has no date; transaction skipped",
        );
        p.bad = true;
      }
      p.reference = ref;
      p.source_label = source;
      p.external_id = jnum || null;
      groups.set(key, p);
    }
    const desc = orNull(cell(c, descI));
    p.memo ??= desc;
    p.reference ??= ref;
    let amount: number;
    try {
      amount = twoCol ? money(rawD) - money(rawC) : money(rawN);
    } catch (e) {
      ctx.error(file, r.row, `Invalid amount: ${errMessage(e)}; transaction skipped`);
      p.bad = true;
      continue;
    }
    const account = ctx.resolveAccount({ code, name: acct }, file, r.row);
    if (!account) {
      p.bad = true;
      continue;
    }
    ctx.noteLedgerContact(contact, contactKindFromLabel(p.source_label));
    p.lines.push({ row: r.row, account, amount, description: desc, contact });
  }
  for (const p of groups.values()) ctx.finishEntry(p);
  return { rows };
}

export const xero: ProductImporter = {
  source: "xero",
  detect,
  accounts: parseAccounts,
  contacts: parseContacts,
  ledger: parseLedger,
  warnDerivedContacts: true,
};
