/** Structured JSON logs to stdout with levels. Secrets are redacted by key name. */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY_RE =
  /(password|secret|token|master_key|masterKey|authorization|cookie|access_token|api_key)/i;

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
  recentErrors(): { at: string; msg: string; fields?: Record<string, unknown> }[];
}

export function redact(v: unknown, depth = 0): unknown {
  if (depth > 6 || v == null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = SECRET_KEY_RE.test(k) && val != null && val !== "" ? "********" : redact(val, depth + 1);
  }
  return out;
}

const errorRing: { at: string; msg: string; fields?: Record<string, unknown> }[] = [];

export function createLogger(
  opts: { level?: Level; stream?: (line: string) => void; base?: Record<string, unknown> } = {},
): Logger {
  const min = ORDER[opts.level ?? ((process.env.COSIMO_LOG_LEVEL as Level) || "info")] ?? 20;
  const write = opts.stream ?? ((line: string) => process.stdout.write(`${line}\n`));
  const base = opts.base ?? {};
  const log = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (level === "error") {
      errorRing.push({
        at: new Date().toISOString(),
        msg,
        fields: redact(fields) as Record<string, unknown>,
      });
      if (errorRing.length > 50) errorRing.shift();
    }
    if (ORDER[level] < min) return;
    const rec = { level, time: new Date().toISOString(), msg, ...base, ...(redact(fields ?? {}) as object) };
    write(JSON.stringify(rec, (_k, v) => (v instanceof Error ? { message: v.message, stack: v.stack } : v)));
  };
  return {
    debug: (m, f) => log("debug", m, f),
    info: (m, f) => log("info", m, f),
    warn: (m, f) => log("warn", m, f),
    error: (m, f) => log("error", m, f),
    child: (fields) => createLogger({ ...opts, base: { ...base, ...fields } }),
    recentErrors: () => [...errorRing],
  };
}

export const silentLogger: Logger = createLogger({ stream: () => {} });
