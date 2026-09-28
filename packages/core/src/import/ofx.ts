import { parseCents } from "@cosimo/shared";
import type { ParsedTxn, ParseError, ParseResult } from "./types.ts";

interface OfxNode {
  name: string;
  value: string | null;
  children: OfxNode[];
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent: string) => {
    if (ent[0] === "#") {
      const code =
        ent[1] === "x" || ent[1] === "X" ? Number.parseInt(ent.slice(2), 16) : Number(ent.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? m;
  });
}

const TAG_RE = /<(\/?)([A-Za-z][A-Za-z0-9_.]*)(?![A-Za-z0-9_.])[^>]*?(\/?)>([^<]*)/g;

/**
 * Tolerant OFX tokenizer for both SGML (1.x, unclosed leaf tags) and XML (2.x). An opening tag is an
 * aggregate when it carries no text and a matching closing tag exists somewhere in the document;
 * everything else is a leaf.
 */
function parseTree(text: string): OfxNode {
  const start = text.search(/<OFX[\s>]/i);
  const body = start === -1 ? text : text.slice(start);
  const tokens: { close: boolean; name: string; selfClose: boolean; text: string }[] = [];
  const closed = new Set<string>();
  for (const m of body.matchAll(TAG_RE)) {
    const name = (m[2] ?? "").toUpperCase();
    const close = m[1] === "/";
    if (close) closed.add(name);
    tokens.push({ close, name, selfClose: m[3] === "/", text: m[4] ?? "" });
  }
  const root: OfxNode = { name: "#root", value: null, children: [] };
  const stack: OfxNode[] = [root];
  for (const t of tokens) {
    const top = stack[stack.length - 1] ?? root;
    if (t.close) {
      const idx = stack.findLastIndex((n) => n.name === t.name);
      if (idx > 0) stack.length = idx;
      continue;
    }
    const trimmed = t.text.trim();
    if (!t.selfClose && trimmed === "" && closed.has(t.name)) {
      const node: OfxNode = { name: t.name, value: null, children: [] };
      top.children.push(node);
      stack.push(node);
    } else {
      top.children.push({ name: t.name, value: decodeEntities(trimmed), children: [] });
    }
  }
  return root;
}

function findAll(node: OfxNode, name: string, out: OfxNode[] = []): OfxNode[] {
  for (const c of node.children) {
    if (c.name === name) out.push(c);
    else findAll(c, name, out);
  }
  return out;
}

function find(node: OfxNode | undefined, name: string): OfxNode | undefined {
  if (!node) return undefined;
  return findAll(node, name)[0];
}

/** Value of a leaf directly under `node` (or an empty aggregate, as XML `<MEMO></MEMO>` yields). */
function leaf(node: OfxNode | undefined, name: string): string | null {
  const c = node?.children.find((n) => n.name === name);
  if (!c) return null;
  const v = c.value ?? (c.children.length === 0 ? "" : null);
  return v === null || v === "" ? null : v;
}

export function parseOfxDate(s: string): string | null {
  const m = /^\s*(\d{4})(\d{2})(\d{2})/.exec(s);
  if (!m) return null;
  const [, y = "", mo = "", d = ""] = m;
  const yi = Number(y);
  const mi = Number(mo);
  const di = Number(d);
  if (mi < 1 || mi > 12 || di < 1 || di > new Date(Date.UTC(yi, mi, 0)).getUTCDate()) return null;
  return `${y}-${mo}-${d}`;
}

export function parseOfxAmount(s: string): number {
  let t = s.trim().replace(/\s+/g, "");
  if (!t.includes(".") && /^[+-]?\d+,\d+$/.test(t)) t = t.replace(",", ".");
  return parseCents(t);
}

function describe(name: string | null, memo: string | null): string {
  if (name && memo && memo.toUpperCase() !== name.toUpperCase() && !name.includes(memo)) {
    return `${name} - ${memo}`;
  }
  return name ?? memo ?? "";
}

/**
 * Parse an OFX 1.x (SGML), OFX 2.x (XML) or QFX file. Amounts keep the OFX sign: positive TRNAMT is a
 * credit to the account holder (money in) for both bank and credit card statements.
 */
export function parseOfx(text: string): ParseResult {
  const root = parseTree(text);
  const rows: ParsedTxn[] = [];
  const errors: ParseError[] = [];
  const statements = [...findAll(root, "STMTRS"), ...findAll(root, "CCSTMTRS")];
  if (statements.length === 0) {
    return { rows, errors: [{ row: 0, message: "no bank or credit card statement found in OFX file" }] };
  }

  const first = statements[0];
  const bankFrom = find(first, "BANKACCTFROM");
  const ccFrom = find(first, "CCACCTFROM");
  const acct = bankFrom ?? ccFrom;
  const account: NonNullable<ParseResult["account"]> = {
    bankId: leaf(bankFrom, "BANKID"),
    accountId: leaf(acct, "ACCTID"),
    accountType: bankFrom ? leaf(bankFrom, "ACCTTYPE") : ccFrom ? "CREDITCARD" : null,
    currency: leaf(first, "CURDEF"),
  };

  let ledgerBalance: ParseResult["ledgerBalance"] = null;
  const lb = find(first, "LEDGERBAL");
  const balAmt = leaf(lb, "BALAMT");
  const balDate = parseOfxDate(leaf(lb, "DTASOF") ?? "");
  if (balAmt && balDate) {
    try {
      ledgerBalance = { amount: parseOfxAmount(balAmt), date: balDate };
    } catch {
      ledgerBalance = null;
    }
  }

  let row = 0;
  for (const stmt of statements) {
    for (const t of findAll(stmt, "STMTTRN")) {
      row++;
      try {
        const rawDate = leaf(t, "DTPOSTED") ?? leaf(t, "DTUSER");
        if (!rawDate) throw new Error("missing DTPOSTED");
        const date = parseOfxDate(rawDate);
        if (!date) throw new Error(`invalid date ${JSON.stringify(rawDate)}`);
        const rawAmt = leaf(t, "TRNAMT");
        if (!rawAmt) throw new Error("missing TRNAMT");
        const amount = parseOfxAmount(rawAmt);
        if (amount === 0) throw new Error("zero amount");
        const name = leaf(t, "NAME") ?? leaf(find(t, "PAYEE"), "NAME") ?? leaf(t, "PAYEE");
        const memo = leaf(t, "MEMO");
        const checkNum = leaf(t, "CHECKNUM");
        let description = describe(name, memo);
        if (!description) description = checkNum ? `CHECK ${checkNum}` : (leaf(t, "TRNTYPE") ?? "");
        rows.push({ date, amount, description, payee: name, providerId: leaf(t, "FITID"), row });
      } catch (e) {
        errors.push({ row, message: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return { rows, errors, account, ledgerBalance };
}
