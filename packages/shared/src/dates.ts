/** Dates are YYYY-MM-DD strings (civil dates, no timezone). Timestamps are UTC ISO 8601. */
export type IsoDate = string;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(s: unknown): s is IsoDate {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function toIsoDate(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

export function today(): IsoDate {
  return toIsoDate(new Date());
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseIsoDate(s: IsoDate): { year: number; month: number; day: number } {
  const m = DATE_RE.exec(s);
  if (!m) throw new RangeError(`Invalid date: ${s}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

export function addDays(s: IsoDate, days: number): IsoDate {
  const { year, month, day } = parseIsoDate(s);
  return toIsoDate(new Date(Date.UTC(year, month - 1, day + days)));
}

export function addMonths(s: IsoDate, months: number): IsoDate {
  const { year, month, day } = parseIsoDate(s);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const dim = daysInMonth(target.getUTCFullYear(), target.getUTCMonth() + 1);
  target.setUTCDate(Math.min(day, dim));
  return toIsoDate(target);
}

export function diffDays(a: IsoDate, b: IsoDate): number {
  const pa = parseIsoDate(a);
  const pb = parseIsoDate(b);
  return Math.round(
    (Date.UTC(pa.year, pa.month - 1, pa.day) - Date.UTC(pb.year, pb.month - 1, pb.day)) / 86_400_000,
  );
}

export function endOfMonth(s: IsoDate): IsoDate {
  const { year, month } = parseIsoDate(s);
  return `${year}-${String(month).padStart(2, "0")}-${String(daysInMonth(year, month)).padStart(2, "0")}`;
}

/** First day of the fiscal year containing `date`. */
export function fiscalYearStart(date: IsoDate, fiscalStartMonth: number): IsoDate {
  const { year, month } = parseIsoDate(date);
  const y = month >= fiscalStartMonth ? year : year - 1;
  return `${y}-${String(fiscalStartMonth).padStart(2, "0")}-01`;
}

/** Last day of the fiscal year that starts at `start`. */
export function fiscalYearEnd(start: IsoDate): IsoDate {
  return addDays(addMonths(start, 12), -1);
}
