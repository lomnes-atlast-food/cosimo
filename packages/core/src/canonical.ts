/**
 * Canonical JSON (see docs/chain-format.md).
 *
 * - Objects: keys sorted by UTF-16 code unit order (all keys used are ASCII), no whitespace.
 * - Numbers: safe integers only. Floats, NaN, and Infinity are rejected.
 * - Strings: escaped exactly as JSON.stringify does (ECMAScript 2019+, well-formed).
 * - `undefined` values are rejected; use null.
 * - Dates must already be `YYYY-MM-DD` / ISO strings; Date objects are rejected.
 */
export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [k: string]: CanonicalValue };

export function canonicalJson(value: unknown): string {
  return write(value, "$");
}

function write(v: unknown, path: string): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(v)) throw new TypeError(`canonicalJson: non-integer number at ${path}`);
      return Object.is(v, -0) ? "0" : String(v);
    case "string":
      return JSON.stringify(v);
    case "object": {
      if (Array.isArray(v)) return `[${v.map((x, i) => write(x, `${path}[${i}]`)).join(",")}]`;
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
        throw new TypeError(`canonicalJson: unsupported object at ${path}`);
      }
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      const parts: string[] = [];
      for (const k of keys) {
        if (obj[k] === undefined) throw new TypeError(`canonicalJson: undefined at ${path}.${k}`);
        parts.push(`${JSON.stringify(k)}:${write(obj[k], `${path}.${k}`)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof v} at ${path}`);
  }
}
