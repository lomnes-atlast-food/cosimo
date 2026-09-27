import { centsToDecimal, formatCents, parseCents } from "@cosimo/shared";

export { centsToDecimal, formatCents, parseCents };

export function money(cents: number | null | undefined, currency = "USD", parens = false) {
  if (cents == null) return "";
  return formatCents(cents, currency, { parens });
}

export function tryParseCents(s: string): number | null {
  try {
    return parseCents(s);
  } catch {
    return null;
  }
}

export function fmtDate(d: string | null | undefined) {
  if (!d) return "";
  const [y, m, day] = d.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, day!)).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function fmtDateTime(d: string | null | undefined) {
  if (!d) return "";
  return new Date(d).toLocaleString();
}

export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
