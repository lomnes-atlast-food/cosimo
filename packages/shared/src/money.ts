/**
 * Money is always integer minor units (cents). Floats are never used for money.
 */
declare const CentsBrand: unique symbol;
export type Cents = number & { readonly [CentsBrand]: true };

export function cents(n: number): Cents {
  if (!Number.isSafeInteger(n)) throw new TypeError(`Not an integer cent amount: ${n}`);
  return n as Cents;
}

export function isCents(n: unknown): n is Cents {
  return typeof n === "number" && Number.isSafeInteger(n);
}

const AMOUNT_RE =
  /^\s*(\()?\s*([+-])?\s*([$€£])?\s*(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d*))?\s*(\))?\s*(CR|DR)?\s*$/i;

/**
 * Parse a user-entered or file-supplied amount string straight to integer cents without
 * going through a float. Accepts "1,234.56", "-12.3", "(45.00)", "$9", "12.345" is rejected
 * (more than two decimals) unless `roundHalfEven` is set.
 */
export function parseCents(input: string, opts: { allowExtraDecimals?: boolean } = {}): Cents {
  // AMOUNT_RE's `\s*` runs between optional groups are ambiguous on long runs of whitespace; reject
  // implausibly long input before it ever reaches the regex.
  if (input.length > 64) throw new RangeError(`Invalid amount: ${JSON.stringify(input)}`);
  const m = AMOUNT_RE.exec(input);
  if (!m) throw new RangeError(`Invalid amount: ${JSON.stringify(input)}`);
  const [, openParen, sign, , intPartRaw = "", fracRaw = "", closeParen, crdr] = m;
  if (Boolean(openParen) !== Boolean(closeParen))
    throw new RangeError(`Invalid amount: ${JSON.stringify(input)}`);
  const intPart = intPartRaw.replace(/,/g, "");
  if (intPart === "" && fracRaw === "") throw new RangeError(`Invalid amount: ${JSON.stringify(input)}`);
  let frac = fracRaw;
  let roundUp = false;
  if (frac.length > 2) {
    if (!opts.allowExtraDecimals && /[1-9]/.test(frac.slice(2))) {
      throw new RangeError(`Amount has more than two decimal places: ${JSON.stringify(input)}`);
    }
    // round half away from zero on the third digit
    roundUp = frac.charCodeAt(2) - 48 >= 5;
    frac = frac.slice(0, 2);
  }
  frac = frac.padEnd(2, "0");
  let value = Number(intPart || "0") * 100 + Number(frac);
  if (roundUp) value += 1;
  if (!Number.isSafeInteger(value)) throw new RangeError(`Amount out of range: ${JSON.stringify(input)}`);
  const negative = sign === "-" || Boolean(openParen) || crdr?.toUpperCase() === "DR";
  return (negative && value !== 0 ? -value : value) as Cents;
}

/** Format cents as a plain decimal string ("-1234.56"), for CSV and inputs. */
export function centsToDecimal(c: number): string {
  const neg = c < 0;
  const abs = Math.abs(c);
  const s = `${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return neg ? `-${s}` : s;
}

const formatters = new Map<string, Intl.NumberFormat>();
function formatter(currency: string, locale?: string) {
  const key = `${locale ?? ""}|${currency}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: 2 });
    formatters.set(key, f);
  }
  return f;
}

/**
 * Format cents for display. Uses Intl on the decimal string form so no float arithmetic
 * touches the value beyond what Intl needs for display.
 */
export function formatCents(
  c: number,
  currency = "USD",
  opts: { parens?: boolean; locale?: string; symbol?: boolean } = {},
): string {
  const neg = c < 0;
  const abs = Math.abs(c);
  // Intl.NumberFormat accepts decimal strings exactly (ES2023 "string numeric literal").
  const f = formatter(currency, opts.locale);
  let body = f.format(centsToDecimal(abs) as unknown as number);
  if (opts.symbol === false) body = body.replace(/[^\d.,\s]/g, "").trim();
  if (!neg) return body;
  return opts.parens ? `(${body})` : `-${body}`;
}

/** Sum integer cents safely. */
export function sumCents(values: Iterable<number>): Cents {
  let total = 0;
  for (const v of values) total += v;
  if (!Number.isSafeInteger(total)) throw new RangeError("Cent sum overflow");
  return total as Cents;
}

/**
 * Allocate `total` cents across `weights` proportionally using the largest-remainder method.
 * The result always sums to exactly `total`. Weights may be negative only if all share a sign.
 */
export function allocateCents(total: number, weights: number[]): Cents[] {
  if (weights.length === 0) return [];
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum === 0) {
    const out = weights.map(() => 0 as Cents);
    out[0] = total as Cents;
    return out;
  }
  const sign = total < 0 ? -1 : 1;
  const absTotal = BigInt(Math.abs(total));
  const wsum = BigInt(Math.abs(weightSum));
  const parts = weights.map((w, i) => {
    const num = absTotal * BigInt(Math.abs(w));
    return { i, q: num / wsum, r: num % wsum };
  });
  let allocated = parts.reduce((a, p) => a + p.q, 0n);
  const order = [...parts].sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  let k = 0;
  while (allocated < absTotal) {
    const p = order[k % order.length]!;
    p.q += 1n;
    allocated += 1n;
    k++;
  }
  return parts.map((p) => (sign * Number(p.q)) as Cents);
}
