import { sha256Hex } from "../hash.ts";
import type { ParsedTxn } from "./types.ts";

const NOISE_PHRASES = [
  "PURCHASE AUTHORIZED ON",
  "RECURRING PAYMENT AUTHORIZED ON",
  "DEBIT CARD PURCHASE",
  "DEBIT CARD",
  "CHECK CARD PURCHASE",
  "CHECKCARD",
  "POS PURCHASE",
  "POS DEBIT",
  "POS",
  "ACH DEBIT",
  "ACH CREDIT",
  "ACH",
  "VISA DDA PUR",
  "CARD PURCHASE",
];
const NOISE_RE = new RegExp(`\\b(?:${NOISE_PHRASES.map((p) => p.replace(/ /g, "\\s+")).join("|")})\\b`, "g");

/**
 * Deterministic normalized form of a bank description used for dedupe and matching: uppercase, masked
 * card numbers, reference numbers (4+ digit runs, #123), short dates (01/31, 01-31) and common
 * card/ACH boilerplate removed, punctuation turned into spaces, whitespace collapsed.
 */
export function normalizeDescription(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\b[X*]{2,}\d*\b/g, " ")
    .replace(/[X*]{4,}\d{2,}/g, " ")
    .replace(/#\s*\d+/g, " ")
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, " ")
    .replace(/\d{4,}/g, " ")
    .replace(/[^A-Z0-9&]+/g, " ")
    .replace(NOISE_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set(["THE", "INC", "LLC", "CO", "CORP", "LTD", "OF", "AND", "&"]);

/** Short key for payee/category suggestions: the first three significant words of the normalized form. */
export function payeeKey(s: string): string {
  return normalizeDescription(s)
    .split(" ")
    .filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w))
    .slice(0, 3)
    .join(" ");
}

/**
 * Dedupe hashes, one per row, in file order.
 *
 *   occurrence = number of EARLIER rows in this batch with the same (date, amount, normalizeDescription)
 *   hash       = sha256Hex(JSON.stringify([bankAccountId, date, amount, normalizeDescription(description), occurrence]))
 *
 * The occurrence index keeps two identical same-day transactions in one file distinct, while re-importing
 * the same file (or an overlapping one listing the same rows in the same order) reproduces the same hashes.
 */
export function dedupeHashes(
  bankAccountId: string,
  rows: Pick<ParsedTxn, "date" | "amount" | "description">[],
): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const norm = normalizeDescription(r.description);
    const key = JSON.stringify([r.date, r.amount, norm]);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    return sha256Hex(JSON.stringify([bankAccountId, r.date, r.amount, norm, occurrence]));
  });
}
