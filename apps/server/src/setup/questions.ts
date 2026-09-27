/**
 * `cosimo init` question set (SPEC §13.3). This is part of the stable agent contract (§13.4).
 */
import { defaultTemplateForEntity, type EntityType } from "@cosimo/shared";

export const QUESTIONS_SCHEMA_VERSION = 1;

export type QuestionType = "choice" | "string" | "secret" | "email" | "path" | "boolean" | "integer" | "date";
export type Answers = Record<string, unknown>;

export interface Question {
  id: string;
  prompt: string;
  help: string;
  type: QuestionType;
  choices?: string[];
  /** Static default, or a description of a derived default. */
  default: unknown;
  required: boolean;
  secret: boolean;
  /** Condition expression over other answer IDs, e.g. "target == 'docker'". Empty means always. */
  ask_when: string;
  min?: number;
  max?: number;
}

type DefaultFn = (a: Answers, env: InitEnv) => unknown;

export interface InitEnv {
  json: boolean;
  /** Turso CLI discovery, filled lazily by the caller. */
  tursoOrg?: string | null;
  tursoToken?: string | null;
  today: string;
  homeDataDir: string;
}

interface QuestionDef extends Question {
  derive?: DefaultFn;
}

const isServer = (a: Answers) => a.target === "docker" || a.target === "fly";

const DEFS: QuestionDef[] = [
  {
    id: "target",
    prompt: "Where will this run?",
    help: "local: this computer. docker: any Linux server with Docker (automatic HTTPS with Caddy). fly: Fly.io.",
    type: "choice",
    choices: ["local", "docker", "fly"],
    default: "local",
    required: true,
    secret: false,
    ask_when: "",
  },
  {
    id: "domain",
    prompt: "Domain name for this instance (DNS must point to this server)",
    help: "For example books.example.com. Caddy requests a certificate for it automatically.",
    type: "string",
    default: null,
    required: true,
    secret: false,
    ask_when: "target == 'docker'",
  },
  {
    id: "fly_app_name",
    prompt: "Fly.io app name",
    help: "Must be unique across Fly.io. Letters, digits, and dashes.",
    type: "string",
    default: "generated",
    required: false,
    secret: false,
    ask_when: "target == 'fly'",
    derive: () => `cosimo-${Math.random().toString(36).slice(2, 8)}`,
  },
  {
    id: "database",
    prompt: "Database",
    help: "sqlite: local files (simplest). turso: hosted libSQL, one database per organization.",
    type: "choice",
    choices: ["sqlite", "turso"],
    default: "sqlite",
    required: true,
    secret: false,
    ask_when: "",
  },
  {
    id: "turso_org",
    prompt: "Turso organization slug",
    help: "Shown by `turso org list`.",
    type: "string",
    default: "from turso CLI if logged in",
    required: true,
    secret: false,
    ask_when: "database == 'turso'",
    derive: (_a, env) => env.tursoOrg ?? null,
  },
  {
    id: "turso_api_token",
    prompt: "Turso Platform API token (used to create one database per organization)",
    help: "Create one with `turso auth api-tokens mint cosimo`.",
    type: "secret",
    default: "from turso CLI if logged in",
    required: true,
    secret: true,
    ask_when: "database == 'turso'",
    derive: (_a, env) => env.tursoToken ?? null,
  },
  {
    id: "data_dir",
    prompt: "Data directory",
    help: "Where databases, attachments, and backups are stored.",
    type: "path",
    default: "~/.cosimo (local), /data (docker, fly)",
    required: true,
    secret: false,
    ask_when: "database == 'sqlite'",
    derive: (a, env) => (isServer(a) ? "/data" : env.homeDataDir),
  },
  {
    id: "admin_email",
    prompt: "Your email address",
    help: "Used to sign in. You become the instance admin.",
    type: "email",
    default: null,
    required: true,
    secret: false,
    ask_when: "",
  },
  {
    id: "admin_name",
    prompt: "Your name",
    help: "",
    type: "string",
    default: null,
    required: false,
    secret: false,
    ask_when: "",
  },
  {
    id: "admin_auth",
    prompt: "How should you set your password?",
    help: "claim_link: open a one-time link to set it (an agent never sees your password). prompt: type it now.",
    type: "choice",
    choices: ["claim_link", "prompt"],
    default: "claim_link when --json, otherwise prompt",
    required: true,
    secret: false,
    ask_when: "",
    derive: (_a, env) => (env.json ? "claim_link" : "prompt"),
  },
  {
    id: "signup_mode",
    prompt: "Who can create accounts?",
    help: "single_user: only you. invite_only: people you invite. open: anyone (not recommended).",
    type: "choice",
    choices: ["single_user", "invite_only", "open"],
    default: "single_user (local), invite_only (server)",
    required: true,
    secret: false,
    ask_when: "",
    derive: (a) => (isServer(a) ? "invite_only" : "single_user"),
  },
  {
    id: "org_name",
    prompt: "Name of your first business",
    help: "You can add more organizations later.",
    type: "string",
    default: null,
    required: true,
    secret: false,
    ask_when: "",
  },
  {
    id: "entity_type",
    prompt: "Business type",
    help: "Determines the default chart of accounts and tax line mappings.",
    type: "choice",
    choices: ["single_member_llc", "sole_prop", "multi_member_llc", "s_corp", "other"],
    default: "single_member_llc",
    required: true,
    secret: false,
    ask_when: "",
  },
  {
    id: "coa_template",
    prompt: "Chart of accounts",
    help: "schedule_c: sole proprietor / single-member LLC. form_1065: partnership. form_1120s: S corp. minimal: build your own.",
    type: "choice",
    choices: ["schedule_c", "form_1065", "form_1120s", "minimal"],
    default: "derived from entity_type",
    required: true,
    secret: false,
    ask_when: "",
    derive: (a) => defaultTemplateForEntity((a.entity_type as EntityType) ?? "single_member_llc"),
  },
  {
    id: "fiscal_year_start_month",
    prompt: "First month of fiscal year",
    help: "1 = January.",
    type: "integer",
    default: 1,
    required: true,
    secret: false,
    ask_when: "",
    min: 1,
    max: 12,
  },
  {
    id: "basis",
    prompt: "Default reporting basis",
    help: "cash: income when paid. accrual: income when invoiced. You can switch any report either way.",
    type: "choice",
    choices: ["cash", "accrual"],
    default: "cash",
    required: true,
    secret: false,
    ask_when: "",
  },
  {
    id: "books_start_date",
    prompt: "First date for these books",
    help: "YYYY-MM-DD. Usually the first day of the year or the day you switch from another system.",
    type: "date",
    default: "first day of current year",
    required: true,
    secret: false,
    ask_when: "",
    derive: (_a, env) => `${env.today.slice(0, 4)}-01-01`,
  },
  {
    id: "plaid_enabled",
    prompt: "Connect bank feeds with your own Plaid keys now?",
    help: "You can add Plaid keys later, and file import (CSV/OFX/QFX) always works.",
    type: "boolean",
    default: false,
    required: true,
    secret: false,
    ask_when: "",
  },
  {
    id: "plaid_env",
    prompt: "Plaid environment",
    help: "sandbox works immediately with test banks. production requires Plaid's onboarding.",
    type: "choice",
    choices: ["sandbox", "production"],
    default: "sandbox",
    required: true,
    secret: false,
    ask_when: "plaid_enabled",
  },
  {
    id: "plaid_client_id",
    prompt: "Plaid client ID",
    help: "From dashboard.plaid.com → Developers → Keys.",
    type: "string",
    default: null,
    required: true,
    secret: false,
    ask_when: "plaid_enabled",
  },
  {
    id: "plaid_secret",
    prompt: "Plaid secret",
    help: "The secret for the chosen environment.",
    type: "secret",
    default: null,
    required: true,
    secret: true,
    ask_when: "plaid_enabled",
  },
  {
    id: "smtp_enabled",
    prompt: "Configure email for invoices and password resets?",
    help: "Needs an SMTP server (your email provider, Postmark, SES, ...).",
    type: "boolean",
    default: false,
    required: true,
    secret: false,
    ask_when: "",
  },
  {
    id: "smtp_host",
    prompt: "SMTP host",
    help: "",
    type: "string",
    default: null,
    required: true,
    secret: false,
    ask_when: "smtp_enabled",
  },
  {
    id: "smtp_port",
    prompt: "SMTP port",
    help: "587 (STARTTLS) or 465 (TLS).",
    type: "integer",
    default: 587,
    required: true,
    secret: false,
    ask_when: "smtp_enabled",
    min: 1,
    max: 65535,
  },
  {
    id: "smtp_user",
    prompt: "SMTP username",
    help: "",
    type: "string",
    default: null,
    required: false,
    secret: false,
    ask_when: "smtp_enabled",
  },
  {
    id: "smtp_password",
    prompt: "SMTP password",
    help: "",
    type: "secret",
    default: null,
    required: false,
    secret: true,
    ask_when: "smtp_enabled",
  },
  {
    id: "smtp_from",
    prompt: "From address",
    help: "e.g. Books <books@example.com>",
    type: "string",
    default: null,
    required: true,
    secret: false,
    ask_when: "smtp_enabled",
  },
  {
    id: "storage",
    prompt: "Where to store receipts and attachments",
    help: "local: the data directory. s3: any S3-compatible bucket.",
    type: "choice",
    choices: ["local", "s3"],
    default: "local",
    required: true,
    secret: false,
    ask_when: "",
  },
  {
    id: "backups",
    prompt: "Automatic daily backups",
    help: "local: into the data directory's backups folder. s3: to the S3 bucket. off: none (not recommended).",
    type: "choice",
    choices: ["local", "s3", "off"],
    default: "local",
    required: true,
    secret: false,
    ask_when: "",
  },
  {
    id: "s3_endpoint",
    prompt: "S3 endpoint URL",
    help: "AWS: https://s3.<region>.amazonaws.com. GCS: https://storage.googleapis.com. R2: https://<account>.r2.cloudflarestorage.com. B2: https://s3.<region>.backblazeb2.com. MinIO: your URL. See docs/object-storage.md.",
    type: "string",
    default: null,
    required: true,
    secret: false,
    ask_when: "storage == 's3' || backups == 's3'",
  },
  {
    id: "s3_bucket",
    prompt: "S3 bucket",
    help: "",
    type: "string",
    default: null,
    required: true,
    secret: false,
    ask_when: "storage == 's3' || backups == 's3'",
  },
  {
    id: "s3_region",
    prompt: "S3 region",
    help: "R2: auto. GCS: the bucket's location (e.g. us-central1). Others: the bucket's region.",
    type: "string",
    default: "us-east-1",
    required: false,
    secret: false,
    ask_when: "storage == 's3' || backups == 's3'",
  },
  {
    id: "s3_access_key",
    prompt: "S3 access key ID",
    help: "",
    type: "string",
    default: null,
    required: true,
    secret: false,
    ask_when: "storage == 's3' || backups == 's3'",
  },
  {
    id: "s3_secret_key",
    prompt: "S3 secret access key",
    help: "",
    type: "secret",
    default: null,
    required: true,
    secret: true,
    ask_when: "storage == 's3' || backups == 's3'",
  },
  {
    id: "service",
    prompt: "Start automatically at login or boot?",
    help: "Installs a launchd agent (macOS), systemd user unit (Linux), or scheduled task (Windows).",
    type: "boolean",
    default: true,
    required: true,
    secret: false,
    ask_when: "target == 'local'",
  },
  {
    id: "sample_data",
    prompt: "Load a demo organization with sample data?",
    help: "Adds a separate 'Demo Consulting LLC' organization you can delete later.",
    type: "boolean",
    default: false,
    required: true,
    secret: false,
    ask_when: "",
  },
];

export function questionDefs(): readonly QuestionDef[] {
  return DEFS;
}

/** Public, JSON-serializable question list for `cosimo init --questions --json`. */
export function publicQuestions(): Question[] {
  return DEFS.map(({ derive: _d, ...q }) => {
    const out: Question = { ...q };
    if (!q.choices) delete out.choices;
    return out;
  });
}

export function questionsDocument() {
  return { schema_version: QUESTIONS_SCHEMA_VERSION, questions: publicQuestions() };
}

// --------------------------------------------------------------------------- ask_when evaluator

/**
 * Evaluate a tiny condition language: `id`, `!id`, `id == 'v'`, `id != 'v'`, joined with `&&` / `||`
 * (&& binds tighter). An empty expression is true.
 */
export function evalCondition(expr: string, a: Answers): boolean {
  const e = expr.trim();
  if (!e) return true;
  return e.split("||").some((disj) =>
    disj.split("&&").every((term) => {
      const t = term.trim();
      const m = /^([a-z0-9_]+)\s*(==|!=)\s*'([^']*)'$/.exec(t);
      if (m) {
        const v = String(a[m[1]!] ?? "");
        return m[2] === "==" ? v === m[3] : v !== m[3];
      }
      const neg = t.startsWith("!");
      const id = neg ? t.slice(1).trim() : t;
      if (!/^[a-z0-9_]+$/.test(id)) throw new Error(`Bad condition: ${expr}`);
      const truthy = a[id] === true || a[id] === "true";
      return neg ? !truthy : truthy;
    }),
  );
}

export function defaultFor(q: QuestionDef, a: Answers, env: InitEnv): unknown {
  if (q.derive) return q.derive(a, env);
  return q.default;
}
