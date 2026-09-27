import { isIsoDate } from "@cosimo/shared";
import { type Answers, defaultFor, evalCondition, type InitEnv, questionDefs } from "./questions.ts";

export interface ResolvedAnswers {
  answers: Answers;
  missing: string[];
  invalid: { id: string; message: string }[];
  /** IDs that were explicitly supplied (file, stdin, or env), used by --reconfigure. */
  supplied: string[];
}

/** Hidden answers accepted in addition to the published questions. */
export const HIDDEN_ANSWERS = [
  "admin_password",
  "port",
  "public_url",
  "host",
  "fly_region",
  "fly_org",
] as const;

function coerce(type: string, v: unknown): unknown {
  if (v === null || v === undefined || v === "") return null;
  switch (type) {
    case "boolean":
      if (typeof v === "boolean") return v;
      if (/^(true|yes|y|1)$/i.test(String(v))) return true;
      if (/^(false|no|n|0)$/i.test(String(v))) return false;
      return v;
    case "integer":
      if (typeof v === "number") return v;
      return /^-?\d+$/.test(String(v).trim()) ? Number(v) : v;
    default:
      return typeof v === "string" ? v.trim() : v;
  }
}

/**
 * Merge supplied answers with `COSIMO_INIT_<ID>` environment variables (which take precedence) and
 * defaults, drop answers whose question is not asked, and validate.
 */
export function resolveAnswers(
  input: Answers,
  env: Record<string, string | undefined>,
  initEnv: InitEnv,
): ResolvedAnswers {
  const answers: Answers = {};
  const missing: string[] = [];
  const invalid: { id: string; message: string }[] = [];
  const supplied: string[] = [];
  for (const q of questionDefs()) {
    if (!evalCondition(q.ask_when, answers)) continue;
    const envVal = env[`COSIMO_INIT_${q.id.toUpperCase()}`];
    let raw: unknown;
    if (envVal !== undefined) {
      raw = envVal;
      supplied.push(q.id);
    } else if (input[q.id] !== undefined && input[q.id] !== null) {
      raw = input[q.id];
      supplied.push(q.id);
    } else {
      raw = defaultFor(q, answers, initEnv);
    }
    const v = coerce(q.type, raw);
    if (v === null) {
      if (q.required) missing.push(q.id);
      answers[q.id] = null;
      continue;
    }
    const err = validate(q.type, v, q.choices, q.min, q.max);
    if (err) invalid.push({ id: q.id, message: err });
    answers[q.id] = v;
  }
  for (const h of HIDDEN_ANSWERS) {
    const envVal = env[`COSIMO_INIT_${h.toUpperCase()}`];
    const v = envVal ?? input[h];
    if (v !== undefined && v !== null && v !== "") {
      answers[h] = h === "port" ? Number(v) : String(v);
      supplied.push(h);
    }
  }
  const known = new Set([...questionDefs().map((q) => q.id), ...HIDDEN_ANSWERS]);
  for (const k of Object.keys(input)) {
    if (!known.has(k)) invalid.push({ id: k, message: "unknown answer id" });
  }
  return { answers, missing, invalid, supplied };
}

function validate(type: string, v: unknown, choices?: string[], min?: number, max?: number): string | null {
  switch (type) {
    case "choice":
      return choices?.includes(String(v)) ? null : `must be one of: ${choices?.join(", ")}`;
    case "boolean":
      return typeof v === "boolean" ? null : "must be true or false";
    case "integer": {
      if (typeof v !== "number" || !Number.isInteger(v)) return "must be an integer";
      if (min !== undefined && v < min) return `must be at least ${min}`;
      if (max !== undefined && v > max) return `must be at most ${max}`;
      return null;
    }
    case "email":
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v)) ? null : "must be an email address";
    case "date":
      return isIsoDate(v) ? null : "must be a date in YYYY-MM-DD format";
    default:
      return typeof v === "string" ? null : "must be a string";
  }
}
