/**
 * QuickBooks Online CSV exports: Account List, Customer/Vendor Contact List, and the Journal report.
 * Dates are MM/DD/YYYY (ISO also accepted). The General Ledger report is detected but rejected with a
 * pointer to the Journal report, because it lists each transaction once per account touched and cannot be
 * regrouped into balanced entries reliably.
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
  isFooterRow,
  isNoiseRow,
  isTotalRow,
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

const DATES: readonly DateFormat[] = ["MM/DD/YYYY", "YYYY-MM-DD", "M/D/YY"];

const NAME_COLS = ["account", "full name", "account full name", "account name", "name"];

/**
 * QBO account type (and detail type) → Cosimo type/subtype. Detail types refine Equity, Fixed Assets and
 * the "Uncategorized ..." system accounts; unknown labels return null (caller falls back to the name).
 */
export function mapQboType(typeLabel: string, detail: string, name: string): TypeGuess | null {
  const t = typeLabel.toLowerCase().replace(/\s+/g, " ").trim();
  const d = detail.toLowerCase();
  const n = name.toLowerCase();
  let g: TypeGuess | null = null;
  if (t === "bank") g = { type: "asset", subtype: "bank" };
  else if (t.startsWith("accounts receivable")) g = { type: "asset", subtype: "accounts_receivable" };
  else if (t.startsWith("other current asset")) g = { type: "asset", subtype: "other_current_asset" };
  else if (t.startsWith("fixed asset") || t === "property, plant and equipment")
    g = {
      type: "asset",
      subtype: /accumulated/.test(d) || /accumulated/.test(n) ? "accumulated_depreciation" : "fixed_asset",
    };
  else if (t.startsWith("other asset")) g = { type: "asset", subtype: "other" };
  else if (t.startsWith("accounts payable")) g = { type: "liability", subtype: "accounts_payable" };
  else if (t.startsWith("credit card")) g = { type: "liability", subtype: "credit_card" };
  else if (t.startsWith("other current liabilit"))
    g = { type: "liability", subtype: "other_current_liability" };
  else if (t.startsWith("long term liabilit") || t.startsWith("long-term liabilit"))
    g = { type: "liability", subtype: "long_term_liability" };
  else if (t === "equity") {
    const s = `${d} ${n}`;
    if (/opening balance/.test(s)) g = { type: "equity", subtype: "opening_balance" };
    else if (/retained earnings/.test(s)) g = { type: "equity", subtype: "retained_earnings" };
    else if (/draw|distribution|dividend/.test(s)) g = { type: "equity", subtype: "owner_draw" };
    else if (/owner|partner|capital|contribution|investment|stock|paid-in|equity/.test(s))
      g = { type: "equity", subtype: "owner_equity" };
    else g = { type: "equity", subtype: "other" };
  } else if (t === "income") g = { type: "income", subtype: "other" };
  else if (t === "other income") g = { type: "income", subtype: "other_income" };
  else if (t === "cost of goods sold") g = { type: "expense", subtype: "cost_of_goods" };
  else if (t === "expenses" || t === "expense") g = { type: "expense", subtype: "other" };
  else if (t === "other expense" || t === "other expenses") g = { type: "expense", subtype: "other_expense" };
  if (g && /^uncategori[sz]ed/.test(n) && g.type !== "equity") g = { ...g, subtype: "uncategorized" };
  return g;
}

function detect(h: string[]): "accounts" | "contacts" | "ledger" | null {
  if (has(h, "transaction type") && has(h, "account", "account full name", "account name", "split"))
    return "ledger";
  if (has(h, "type") && has(h, "detail type") && has(h, ...NAME_COLS)) return "accounts";
  if (
    has(h, "customer", "vendor", "customer full name", "vendor full name") &&
    has(h, "email", "phone numbers", "phone", "full name", "company", "company name")
  )
    return "contacts";
  return null;
}

function parseAccounts(ctx: ImportContext, file: string, table: CsvTable): FileParseResult {
  const h = table.headers;
  const nameI = col(h, ...NAME_COLS);
  const typeI = col(h, "type", "account type");
  const detailI = col(h, "detail type");
  const descI = col(h, "description");
  const numI = col(h, "account #", "account number", "number", "acct #", "acct no.", "account no.");
  if (
    !requireColumns(ctx, file, table, [
      ["Account", nameI],
      ["Type", typeI],
    ])
  )
    return { rows: 0 };
  let rows = 0;
  const parents: { key: string; path: string; row: number }[] = [];
  for (const r of table.rows) {
    if (isNoiseRow(r)) continue;
    const full = cell(r.cells, nameI);
    const typeLabel = cell(r.cells, typeI);
    if (!full || !typeLabel) continue; // report footer ("Monday, ... GMT") or section heading
    rows++;
    const detail = cell(r.cells, detailI);
    const segs = full.split(":").map((s) => s.trim());
    const leaf = segs[segs.length - 1] ?? full;
    const code = orNull(cell(r.cells, numI));
    let g = mapQboType(typeLabel, detail, leaf);
    if (!g) {
      g = guessAccountTypeFromName(leaf);
      ctx.warn(
        file,
        r.row,
        `Unknown QuickBooks account type "${typeLabel}" for "${full}"; guessed ${g.type}`,
      );
    }
    const key = code ?? normName(full);
    const added = ctx.addAccount(
      {
        key,
        code,
        name: leaf,
        parent: null,
        type: g.type,
        subtype: g.subtype,
        description: orNull(cell(r.cells, descI)),
        source_type_label: detail ? `${typeLabel} / ${detail}` : typeLabel,
        full_name: segs.join(":"),
      },
      file,
      r.row,
    );
    if (added && segs.length > 1) parents.push({ key, path: segs.slice(0, -1).join(":"), row: r.row });
  }
  for (const p of parents) {
    const parent = ctx.findAccount(null, p.path);
    const a = ctx.getAccount(p.key)!;
    if (parent && parent !== p.key) a.parent = parent;
    else
      ctx.warn(
        file,
        p.row,
        `Parent account "${p.path}" of "${a.full_name}" not found; imported as top-level`,
      );
  }
  return { rows };
}

function cleanPhone(raw: string): string | null {
  const first = raw.split(/[\n,;]/)[0]?.trim() ?? "";
  const s = first.replace(/^[A-Za-z ]+:\s*/, "").trim();
  return orNull(s);
}

function parseContacts(ctx: ImportContext, file: string, table: CsvTable): FileParseResult {
  const h = table.headers;
  const isVendor = h.some((x) => /^vendor\b/.test(x)) && !h.some((x) => /^customer\b/.test(x));
  const nameI = col(
    h,
    "customer",
    "vendor",
    "name",
    "display name",
    "customer full name",
    "vendor full name",
  );
  const companyI = col(h, "company", "company name");
  const emailI = col(h, "email", "email address");
  const phoneI = col(h, "phone numbers", "phone", "phone number", "mobile");
  const t1099I = col(
    h,
    "track 1099",
    "1099 tracking",
    "track payments for 1099",
    "1099",
    "eligible for 1099",
  );
  if (!requireColumns(ctx, file, table, [[isVendor ? "Vendor" : "Customer", nameI]])) return { rows: 0 };
  let rows = 0;
  for (const r of table.rows) {
    if (isNoiseRow(r)) continue;
    const name = cell(r.cells, nameI);
    if (!name) continue;
    rows++;
    ctx.addContact({
      name,
      kind: isVendor ? "vendor" : "customer",
      email: orNull(cell(r.cells, emailI)),
      phone: cleanPhone(cell(r.cells, phoneI)),
      company: orNull(cell(r.cells, companyI)),
      ...(isVendor && t1099I >= 0 ? { is_1099_vendor: truthy(cell(r.cells, t1099I)) } : {}),
    });
  }
  return { rows };
}

function parseLedger(ctx: ImportContext, file: string, table: CsvTable): FileParseResult {
  const h = table.headers;
  if (has(h, "split") || (has(h, "balance") && !has(h, "debit"))) {
    ctx.error(
      file,
      table.headerRow,
      "This looks like the QuickBooks General Ledger report, which lists each transaction once per account and " +
        "cannot be regrouped into balanced entries reliably. Export Reports → Journal as CSV instead.",
    );
    return { rows: 0 };
  }
  const dateI = col(h, "date", "transaction date");
  const typeI = col(h, "transaction type", "type");
  const numI = col(h, "num", "no.", "ref no.", "ref #", "number", "doc num");
  const nameI = col(h, "name", "customer/vendor", "payee");
  const memoI = col(h, "memo/description", "memo", "description", "line description");
  const acctI = col(h, "account", "account full name", "account name");
  const acctNumI = col(h, "account #", "account number", "acct #");
  const debitI = col(h, "debit");
  const creditI = col(h, "credit");
  const amountI = col(h, "amount");
  const twoCol = debitI >= 0 && creditI >= 0;
  const required: [string, number][] = [
    ["Date", dateI],
    ["Account", acctI],
  ];
  if (!twoCol && amountI < 0) required.push(["Debit and Credit", -1]);
  if (!requireColumns(ctx, file, table, required)) return { rows: 0 };

  let rows = 0;
  let cur: PendingEntry | null = null;
  let curKey = "";
  let curName: string | null = null;
  const close = () => {
    if (cur) ctx.finishEntry(cur);
    cur = null;
  };
  const sum = (p: PendingEntry) => p.lines.reduce((s, l) => s + l.amount, 0);

  for (const r of table.rows) {
    if (r.blank) {
      close();
      continue;
    }
    if (isTotalRow(r.cells) || isFooterRow(r.cells)) {
      close();
      continue;
    }
    const c = r.cells;
    const acct = cell(c, acctI);
    const rawD = cell(c, debitI);
    const rawC = cell(c, creditI);
    const rawA = cell(c, amountI);
    if (!acct) {
      // Per-transaction subtotal row (amounts only) ends the group; anything else is a footer/heading.
      if (rawD || rawC || rawA) close();
      continue;
    }
    rows++;
    const rawDate = cell(c, dateI);
    const type = orNull(cell(c, typeI));
    const num = orNull(cell(c, numI));
    const name = orNull(cell(c, nameI));
    const memo = orNull(cell(c, memoI));
    if (rawDate) {
      const key = [rawDate, type, num, name].join("\u0000");
      const cont: boolean = cur !== null && key === curKey && sum(cur) !== 0;
      if (!cont) {
        close();
        const p = newPending(file, r.row);
        p.date = parseDateAny(rawDate, DATES);
        if (!p.date) {
          ctx.error(file, r.row, `Unrecognized date "${rawDate}" (expected MM/DD/YYYY); transaction skipped`);
          p.bad = true;
        }
        p.reference = num;
        p.source_label = type;
        p.memo = memo;
        cur = p;
        curKey = key;
        curName = name;
      }
    } else if (!cur) {
      ctx.error(file, r.row, "Line has no date and does not continue a transaction; skipped");
      continue;
    }
    const p = cur as PendingEntry | null;
    if (!p) continue;
    p.memo ??= memo;
    let amount: number;
    try {
      amount = twoCol ? money(rawD) - money(rawC) : money(rawA);
    } catch (e) {
      ctx.error(file, r.row, `Invalid amount: ${errMessage(e)}; transaction skipped`);
      p.bad = true;
      continue;
    }
    const account = ctx.resolveAccount({ code: orNull(cell(c, acctNumI)), name: acct }, file, r.row);
    if (!account) {
      p.bad = true;
      continue;
    }
    const contact = name ?? curName;
    ctx.noteLedgerContact(contact, contactKindFromLabel(p.source_label));
    p.lines.push({ row: r.row, account, amount, description: memo, contact });
  }
  close();
  return { rows };
}

export const qbo: ProductImporter = {
  source: "qbo",
  detect,
  accounts: parseAccounts,
  contacts: parseContacts,
  ledger: parseLedger,
  warnDerivedContacts: true,
};
