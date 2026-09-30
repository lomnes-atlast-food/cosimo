/**
 * Payment terms and due dates. The due date is authoritative (it drives aging and reminders); terms
 * only describe it. A preset such as "Net 30" is a rule that computes a due date. Anything else is
 * custom text, kept as typed and never checked against the due date.
 */
import { addDays, addMonths, diffDays, endOfMonth, type IsoDate } from "./dates.ts";

export const ON_DUE_DATE = "On due date";

export const TERM_PRESETS = [
  "Due on receipt",
  "Net 7",
  "Net 10",
  "Net 15",
  "Net 30",
  "Net 45",
  "Net 60",
  "Net 90",
  "Due end of month",
  "Due end of next month",
  ON_DUE_DATE,
] as const;

export type TermRule = { kind: "days"; days: number } | { kind: "eom"; months: 0 | 1 };

/** A rule, `"on_due_date"` (terms that follow the due date), or `null` for custom text. */
export function parseTerms(text: string | null | undefined): TermRule | "on_due_date" | null {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return null;
  if (/receipt|immediate/.test(t)) return { kind: "days", days: 0 };
  if (/end of next month/.test(t)) return { kind: "eom", months: 1 };
  if (/end of month|\beom\b/.test(t)) return { kind: "eom", months: 0 };
  if (/on due date/.test(t)) return "on_due_date";
  const m = /net\s*(\d{1,3})/.exec(t);
  if (m) return { kind: "days", days: Number(m[1]) };
  return null;
}

export function dueFromRule(issue: IsoDate, rule: TermRule): IsoDate {
  if (rule.kind === "days") return addDays(issue, rule.days);
  return endOfMonth(addMonths(issue, rule.months));
}

const NET_DAYS = [7, 10, 15, 30, 45, 60, 90];

/** The preset that describes this due date, or "On due date" when none fits. */
export function termsFromDates(issue: IsoDate, due: IsoDate): string {
  const days = diffDays(due, issue);
  if (days === 0) return "Due on receipt";
  if (NET_DAYS.includes(days)) return `Net ${days}`;
  if (due === endOfMonth(issue)) return "Due end of month";
  if (due === endOfMonth(addMonths(issue, 1))) return "Due end of next month";
  return ON_DUE_DATE;
}

/** True unless the terms are a rule that gives a different due date. */
export function termsAgree(issue: IsoDate, terms: string | null | undefined, due: IsoDate): boolean {
  const rule = parseTerms(terms);
  if (rule === null || rule === "on_due_date") return true;
  return dueFromRule(issue, rule) === due;
}
