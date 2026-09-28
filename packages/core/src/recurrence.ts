/**
 * Recurring schedules (#24). Pure, shared by the server and the web app.
 *
 * Occurrence n is computed from the start date and n, never by stepping from the previous date. So
 * a monthly schedule on the 31st lands on Jan 31, Feb 28, Mar 31, Apr 30, and doesn't drift to the
 * 28th after February.
 */
import { addDays, daysInMonth, type IsoDate, parseIsoDate } from "@cosimo/shared";

export const RECURRENCE_UNITS = ["day", "week", "month", "year"] as const;
export type RecurrenceUnit = (typeof RECURRENCE_UNITS)[number];

/** `anchor_day` value for the last day of the month. */
export const LAST_DAY = -1;

export interface Schedule {
  unit: RecurrenceUnit;
  /** Every N units, 1 or more. Quarterly is 3 months. */
  interval: number;
  /**
   * Month and year units only: the day of the month (1-31, clamped to short months) or -1 for the
   * last day. Omitted means the start date's day.
   */
  anchor_day?: number | null;
  start_date: IsoDate;
  /** Inclusive. */
  end_date?: IsoDate | null;
  /** How many schedule slots in total, skipped ones included. */
  max_occurrences?: number | null;
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** The anchored day in a given month: clamped to the month's length, or its last day. */
function anchoredDate(year: number, month: number, anchor: number): IsoDate {
  const dim = daysInMonth(year, month);
  return iso(year, month, anchor === LAST_DAY ? dim : Math.min(anchor, dim));
}

/** Year and month `months` after (year, month). */
function shiftMonth(year: number, month: number, months: number) {
  const idx = year * 12 + (month - 1) + months;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

/**
 * Month-based schedules start in the start date's month when the anchored day there is on or after
 * the start date, otherwise in the next period.
 */
function monthBase(s: Schedule) {
  const { year, month, day } = parseIsoDate(s.start_date);
  const anchor = s.anchor_day ?? day;
  const step = s.unit === "year" ? 12 : 1;
  const first = anchoredDate(year, month, anchor);
  const base = first >= s.start_date ? { year, month } : shiftMonth(year, month, step);
  return { ...base, anchor, step };
}

/** Occurrence n (from 0) ignoring the end date and maximum count. */
export function rawOccurrence(s: Schedule, n: number): IsoDate {
  const interval = Math.max(1, Math.trunc(s.interval));
  switch (s.unit) {
    case "day":
      return addDays(s.start_date, n * interval);
    case "week":
      return addDays(s.start_date, n * interval * 7);
    case "month":
    case "year": {
      const b = monthBase(s);
      const m = shiftMonth(b.year, b.month, n * interval * b.step);
      return anchoredDate(m.year, m.month, b.anchor);
    }
  }
}

/** Occurrence n (from 0), or null when it falls after the end date or past the maximum count. */
export function occurrence(s: Schedule, n: number): IsoDate | null {
  if (n < 0) return null;
  if (s.max_occurrences != null && n >= s.max_occurrences) return null;
  const d = rawOccurrence(s, n);
  if (s.end_date && d > s.end_date) return null;
  return d;
}

/**
 * The smallest index whose date is on or after `date`, ignoring the end date and maximum count
 * (check the result with `occurrence`).
 */
export function firstIndexOnOrAfter(s: Schedule, date: IsoDate): number {
  if (date <= s.start_date) return 0;
  const interval = Math.max(1, Math.trunc(s.interval));
  const a = parseIsoDate(s.start_date);
  const b = parseIsoDate(date);
  let n: number;
  switch (s.unit) {
    case "day":
    case "week": {
      const days = (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000;
      n = Math.floor(days / (interval * (s.unit === "week" ? 7 : 1)));
      break;
    }
    default: {
      const months = (b.year - a.year) * 12 + (b.month - a.month);
      n = Math.floor(months / (interval * (s.unit === "year" ? 12 : 1)));
    }
  }
  n = Math.max(0, n - 1);
  while (n > 0 && rawOccurrence(s, n - 1) >= date) n--;
  while (rawOccurrence(s, n) < date) n++;
  return n;
}

/** Up to `count` dates from index `from` on, stopping at the end date or maximum count. */
export function upcoming(s: Schedule, from: number, count: number): { index: number; date: IsoDate }[] {
  const out: { index: number; date: IsoDate }[] = [];
  for (let n = Math.max(0, from); out.length < count; n++) {
    const date = occurrence(s, n);
    if (!date) break;
    out.push({ index: n, date });
  }
  return out;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th"}`;
}

/** "Monthly on the last day", "Every 2 weeks on Monday", "Quarterly on the 31st, 12 times". */
export function describeSchedule(s: Schedule): string {
  const n = Math.max(1, Math.trunc(s.interval));
  const start = parseIsoDate(s.start_date);
  let text: string;
  switch (s.unit) {
    case "day":
      text = n === 1 ? "Daily" : `Every ${n} days`;
      break;
    case "week": {
      const wd = WEEKDAYS[new Date(Date.UTC(start.year, start.month - 1, start.day)).getUTCDay()];
      text = `${n === 1 ? "Weekly" : `Every ${n} weeks`} on ${wd}`;
      break;
    }
    case "month": {
      const anchor = s.anchor_day ?? start.day;
      const day = anchor === LAST_DAY ? "the last day" : `the ${ordinal(anchor)}`;
      const every = n === 1 ? "Monthly" : n === 3 ? "Quarterly" : `Every ${n} months`;
      text = `${every} on ${day}`;
      break;
    }
    case "year": {
      const b = monthBase(s);
      const month = MONTH_NAMES[b.month - 1];
      const day = b.anchor === LAST_DAY ? `the last day of ${month}` : `${month} ${b.anchor}`;
      text = `${n === 1 ? "Yearly" : `Every ${n} years`} on ${day}`;
      break;
    }
  }
  if (s.max_occurrences != null)
    text += `, ${s.max_occurrences} ${s.max_occurrences === 1 ? "time" : "times"}`;
  else if (s.end_date) text += `, until ${s.end_date}`;
  return text;
}

/**
 * Fill period placeholders in a memo or description from an occurrence's scheduled date, so a
 * run that is caught up later still names its own period:
 * `{month}` January, `{year}` 2026, `{quarter}` Q1, `{period}` January 2026, `{date}` 2026-01-31.
 * Month, year, quarter, and period take an offset such as `{month-1}` or `{year+1}`. Unknown tokens
 * are left as typed.
 */
export function renderPeriodText(text: string, date: IsoDate): string {
  const { year, month, day } = parseIsoDate(date);
  return text.replace(
    /\{(month|year|quarter|period|date)([+-]\d{1,3})?\}/g,
    (whole, token: string, off?: string) => {
      const k = off ? Number(off) : 0;
      switch (token) {
        case "month":
          return MONTH_NAMES[shiftMonth(year, month, k).month - 1]!;
        case "year":
          return String(year + k);
        case "quarter": {
          const q = Math.floor((month - 1) / 3) + k;
          return `Q${(((q % 4) + 4) % 4) + 1}`;
        }
        case "period": {
          const m = shiftMonth(year, month, k);
          return `${MONTH_NAMES[m.month - 1]} ${m.year}`;
        }
        case "date":
          return off ? whole : iso(year, month, day);
        default:
          return whole;
      }
    },
  );
}
