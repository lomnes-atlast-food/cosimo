import { formatCents } from "@cosimo/shared";
import { type PDFFont, type RGB, rgb } from "pdf-lib";

// Code points 0x80-0x9F of Windows-1252 that WinAnsi can encode (as Unicode).
const CP1252_EXTRA = new Set(
  [
    0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d,
    0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e,
    0x0178,
  ].map((cp) => String.fromCodePoint(cp)),
);

const REPLACEMENT_TABLE: [number[], string][] = [
  [[0x2018, 0x2019, 0x201a, 0x201b, 0x2032, 0x2039, 0x203a], "'"],
  [[0x201c, 0x201d, 0x201e, 0x201f, 0x2033, 0x00ab, 0x00bb], '"'],
  [[0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0x00b7], "-"],
  [[0x2026], "..."],
  [[0x00a0, 0x2002, 0x2003, 0x2007, 0x2009, 0x202f, 0x0009], " "],
  [[0x00ad], ""],
  [[0x2265], ">="],
  [[0x2264], "<="],
  [[0x2260], "!="],
  [[0x2192], "->"],
  [[0x2190], "<-"],
  [[0x2194], "<->"],
  [[0x21d2], "=>"],
  [[0x2248], "~"],
  [[0x0141], "L"],
  [[0x0142], "l"],
  [[0x0110], "D"],
  [[0x0111], "d"],
  [[0x0131], "i"],
];
const REPLACEMENTS = new Map<string, string>(
  REPLACEMENT_TABLE.flatMap(([cps, to]) => cps.map((cp) => [String.fromCodePoint(cp), to] as const)),
);

// Zero-width characters, variation selectors, emoji tags and combining marks are dropped.
const isInvisible = (ch: string, cp: number) =>
  (cp >= 0x200b && cp <= 0x200f) ||
  (cp >= 0x2060 && cp <= 0x2064) ||
  cp === 0xfeff ||
  (cp >= 0xfe00 && cp <= 0xfe0f) ||
  (cp >= 0xe0000 && cp <= 0xe01ef) ||
  /\p{M}/u.test(ch);

function winAnsiOk(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa1 && cp <= 0xff) || CP1252_EXTRA.has(ch);
}

/**
 * Coerce any string into something Helvetica (WinAnsi) can encode. Keeps "\n" so callers
 * can split lines; other control characters become spaces.
 */
export function toWinAnsi(s: string): string {
  let out = "";
  for (const ch of String(s ?? "").replace(/\r\n?/g, "\n")) {
    if (ch === "\n") {
      out += ch;
      continue;
    }
    const mapped = REPLACEMENTS.get(ch);
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    if (winAnsiOk(ch)) {
      out += ch;
      continue;
    }
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) {
      out += " ";
      continue;
    }
    if (isInvisible(ch, cp)) continue;
    const decomposed = ch.normalize("NFKD").replace(/\p{M}/gu, "");
    if (decomposed && [...decomposed].every((c) => winAnsiOk(c))) {
      out += decomposed;
      continue;
    }
    out += "?";
  }
  return out;
}

function hardBreak(word: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const parts: string[] = [];
  let cur = "";
  for (const ch of word) {
    if (cur && font.widthOfTextAtSize(cur + ch, size) > maxWidth) {
      parts.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

/** Word-wrap to maxWidth; honors "\n" and hard-breaks words that are too long on their own. */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of toWinAnsi(text).split("\n")) {
    const words = para.split(/ +/).filter((w) => w.length > 0);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let cur = "";
    for (const word of words) {
      const candidate = cur ? `${cur} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        cur = candidate;
        continue;
      }
      if (cur) lines.push(cur);
      if (font.widthOfTextAtSize(word, size) <= maxWidth) {
        cur = word;
      } else {
        const pieces = hardBreak(word, font, size, maxWidth);
        cur = pieces.pop() ?? "";
        lines.push(...pieces);
      }
    }
    lines.push(cur);
  }
  return lines;
}

/** Shorten a single line to fit maxWidth, ending in "...". */
export function truncateText(text: string, font: PDFFont, size: number, maxWidth: number): string {
  const s = toWinAnsi(text).replace(/\n/g, " ");
  if (font.widthOfTextAtSize(s, size) <= maxWidth) return s;
  const chars = [...s];
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (font.widthOfTextAtSize(`${chars.slice(0, mid).join("").trimEnd()}...`, size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  if (lo === 0) return font.widthOfTextAtSize("...", size) <= maxWidth ? "..." : "";
  return `${chars.slice(0, lo).join("").trimEnd()}...`;
}

const DEFAULT_COLOR = "#1f3a5f";

export function hexToRgb(hex: string): RGB {
  let m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(hex ?? "").trim());
  if (!m) m = /^#?([0-9a-f]{6})$/i.exec(DEFAULT_COLOR)!;
  let h = m[1]!;
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const n = Number.parseInt(h, 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-01-31" -> "Jan 31, 2026". Unparseable input is returned unchanged. */
export function fmtDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!m) return String(iso ?? "");
  const month = MONTHS[Number(m[2]) - 1];
  const day = Number(m[3]);
  if (!month || day < 1 || day > 31) return String(iso);
  return `${month} ${day}, ${m[1]}`;
}

function groupDigits(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Money for PDFs: formatCents with a WinAnsi-safe fallback (unknown currency, exotic symbols). */
export function fmtMoney(c: number, currency: string, opts: { symbol?: boolean; parens?: boolean } = {}) {
  const neg = c < 0;
  const plain = () => {
    const abs = Math.abs(c);
    const body = `${groupDigits(String(Math.trunc(abs / 100)))}.${String(abs % 100).padStart(2, "0")}`;
    return opts.symbol === false ? body : `${currency} ${body}`;
  };
  let s: string;
  try {
    s = formatCents(Math.abs(c), currency, { locale: "en-US", symbol: opts.symbol ?? true });
    if (toWinAnsi(s).includes("?") || !/\d/.test(s)) s = plain();
  } catch {
    s = plain();
  }
  s = toWinAnsi(s);
  if (!neg) return s;
  return opts.parens === false ? `-${s}` : `(${s})`;
}
