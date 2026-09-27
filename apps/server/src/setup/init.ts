/**
 * Apply `cosimo init` answers (SPEC §13.3–13.4).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CoaTemplate, EntityType, SignupMode } from "@cosimo/shared";
import { type Config, defaultConfig, expandHome, finalize, loadConfig, saveConfig } from "../config.ts";
import { type AppContext, createContext } from "../context.ts";
import { generateMasterKey, SecretBox } from "../crypto.ts";
import { silentLogger } from "../logger.ts";
import { instanceAudit } from "../services/instance-audit.ts";
import { loadSampleData } from "../services/sample-data.ts";
import type { Answers } from "./questions.ts";

export class InitError extends Error {
  constructor(
    readonly exitCode: 1 | 2 | 3 | 4 | 5,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface InitResult {
  status: "ok";
  version: string;
  url: string;
  target: string;
  database: string;
  config_path: string;
  master_key_location: string;
  claim_link: string | null;
  claim_link_expires_at: string | null;
  org_id: string | null;
  next_steps: string[];
  warnings: string[];
  /** Extra fields for server targets (deployment directory etc). */
  [k: string]: unknown;
}

export interface InitOptions {
  configPath?: string;
  reconfigure?: boolean;
  env?: Record<string, string | undefined>;
  log?: (msg: string) => void;
  /** Hook for target-specific work (docker/fly/service). Returns extra result fields. */
  deploy?: (ctx: {
    answers: Answers;
    config: Config;
    configPath: string;
    result: InitResult;
  }) => Promise<void>;
  /** Hook to seed demo data. */
  sampleData?: (ctx: AppContext, adminUserId: string) => Promise<void>;
  /** Environment checks (Docker, flyctl) that run before anything is written. */
  preflight?: (answers: Answers) => Promise<void>;
  /**
   * Inside a server target's container: create the admin, org, and settings in the mounted
   * config's databases without writing any files (the host already wrote them).
   */
  inContainer?: boolean;
}

export function configPathFor(answers: Answers, explicit?: string): string {
  if (explicit) return explicit;
  if (answers.target === "local") {
    const dir = answers.data_dir ? expandHome(String(answers.data_dir)) : join(expandHome("~"), ".cosimo");
    return join(dir, "config.toml");
  }
  // Server targets write a deployment directory; the config lives in ./cosimo/config/config.toml
  // on the host and is mounted at /etc/cosimo/config.toml in the container.
  return join(process.cwd(), "cosimo", "config", "config.toml");
}

export function buildConfig(answers: Answers, base?: Config): Config {
  const cfg = base ? structuredClone(base) : defaultConfig();
  const target = String(answers.target ?? "local") as Config["instance"]["target"];
  cfg.instance.target = target;
  cfg.instance.created_at ||= new Date().toISOString();
  if (answers.data_dir) cfg.database.data_dir = String(answers.data_dir);
  else if (target !== "local") cfg.database.data_dir = "/data";
  if (answers.database === "turso") {
    cfg.database.mode = "turso";
    cfg.database.turso_org = String(answers.turso_org ?? "");
  } else if (answers.database === "sqlite") {
    cfg.database.mode = "sqlite";
    cfg.database.system_url = "";
  }
  if (target === "local") {
    cfg.server.host = String(answers.host ?? "127.0.0.1");
    cfg.server.port = Number(answers.port ?? cfg.server.port ?? 8787);
    cfg.server.public_url = String(answers.public_url ?? `http://localhost:${cfg.server.port}`);
  } else {
    cfg.server.host = "0.0.0.0";
    cfg.server.port = 8787;
    cfg.server.trust_proxy = true;
    if (target === "docker" && answers.domain) cfg.server.public_url = `https://${answers.domain}`;
    if (target === "fly" && answers.fly_app_name)
      cfg.server.public_url = `https://${answers.fly_app_name}.fly.dev`;
    if (answers.public_url) cfg.server.public_url = String(answers.public_url);
  }
  if (answers.storage) cfg.storage.kind = answers.storage as "local" | "s3";
  if (answers.backups) cfg.backups.mode = answers.backups as "local" | "s3" | "off";
  if (answers.s3_bucket) {
    cfg.storage.s3_endpoint = String(answers.s3_endpoint ?? "");
    cfg.storage.s3_bucket = String(answers.s3_bucket ?? "");
    cfg.storage.s3_region = String(answers.s3_region ?? "");
    cfg.storage.s3_access_key = String(answers.s3_access_key ?? "");
  }
  return cfg;
}

/**
 * Create (or reconfigure) an instance. Validation of answers happens before this is called;
 * nothing is changed if this throws before the config is written.
 */
export async function applyInit(answers: Answers, opts: InitOptions): Promise<InitResult> {
  if (opts.inContainer) return applyInContainer(answers, opts);
  const log = opts.log ?? (() => {});
  const env = opts.env ?? process.env;
  const configPath = configPathFor(answers, opts.configPath);
  const existing = existsSync(configPath) ? loadConfig(configPath, {}) : null;
  if (existing && !opts.reconfigure) {
    throw new InitError(
      5,
      "instance_exists",
      `An instance already exists at ${configPath}. Use --reconfigure to change it.`,
      {
        config_path: configPath,
      },
    );
  }
  const warnings: string[] = [];
  const nextSteps: string[] = [];
  const target = String(answers.target ?? existing?.file.instance.target ?? "local");
  if (opts.preflight) await opts.preflight(answers);
  const server = target !== "local";

  // ---------------------------------------------------------------- config file
  // Local: the master key lives in the 0600 config file. Server targets: in a 0600 .env next to
  // the deployment files, so the config the container mounts holds no plaintext secrets.
  let cfg = buildConfig(answers, existing?.file);
  const envFile = join(dirname(dirname(configPath)), ".env");
  const envMasterKey = env.COSIMO_MASTER_KEY;
  let masterKey: string;
  let masterKeyLocation: string;
  if (server) {
    masterKey = cfg.security.master_key || readEnvKey(envFile) || envMasterKey || generateMasterKey();
    cfg.security.master_key = "";
    masterKeyLocation = envFile;
  } else {
    if (!cfg.security.master_key && !envMasterKey) cfg.security.master_key = generateMasterKey();
    masterKey = cfg.security.master_key || envMasterKey!;
    masterKeyLocation =
      envMasterKey && !cfg.security.master_key ? "COSIMO_MASTER_KEY environment variable" : configPath;
  }
  // Secrets in the config file are encrypted with the master key.
  const box = new SecretBox(masterKey);
  if (answers.turso_api_token) cfg.database.turso_api_token = box.encrypt(String(answers.turso_api_token));
  if (answers.s3_secret_key) cfg.storage.s3_secret_key = box.encrypt(String(answers.s3_secret_key));
  log(`${existing ? "Updating" : "Writing"} config ${configPath} (mode ${server ? "0644" : "0600"})`);
  saveConfig(configPath, cfg, server ? { mode: 0o644, secretsInFile: false } : undefined);

  const result: InitResult = {
    status: "ok",
    version: "",
    url: "",
    target,
    database: String(answers.database ?? (cfg.database.mode === "turso" ? "turso" : "sqlite")),
    config_path: configPath,
    master_key_location: masterKeyLocation,
    claim_link: null,
    claim_link_expires_at: null,
    org_id: null,
    next_steps: nextSteps,
    warnings,
  };

  if (server) {
    log(`Writing ${envFile} (mode 0600)`);
    writeEnvKey(envFile, masterKey);
    if (!opts.deploy)
      throw new InitError(1, "unsupported_target", `Target ${result.target} is not available in this build.`);
    // The admin, org, and settings are created inside the container by the deploy step.
    await opts.deploy({ answers, config: cfg, configPath, result });
    nextSteps.push(`Back up ${envFile} somewhere safe. It contains your master key.`);
    return result;
  }

  // ---------------------------------------------------------------- local instance
  cfg = finalize(loadConfig(configPath, env).effective);
  const ctx = await createContext(cfg, { configPath, logger: silentLogger, env });
  try {
    result.version = ctx.version;
    result.url = cfg.server.public_url;
    await createInstanceData(ctx, answers, opts, result);
  } finally {
    await ctx.close();
  }
  if (masterKeyLocation === configPath) {
    nextSteps.push(`Back up ${configPath} somewhere safe. It contains your master key.`);
  } else {
    nextSteps.push(
      "Keep COSIMO_MASTER_KEY somewhere safe. Without it, stored bank connections cannot be recovered.",
    );
  }
  nextSteps.push(`Start the server with \`cosimo serve\` and open ${result.url}.`);
  if (answers.plaid_enabled === false) {
    nextSteps.push("Import bank statements (CSV, OFX, QFX) or add Plaid keys later in Settings.");
  }
  if (opts.deploy) await opts.deploy({ answers, config: cfg, configPath, result });
  return result;
}

function readEnvKey(path: string): string | null {
  if (!existsSync(path)) return null;
  const m = /^COSIMO_MASTER_KEY=(.+)$/m.exec(readFileSync(path, "utf8"));
  return m?.[1]?.trim() || null;
}

function writeEnvKey(path: string, key: string) {
  mkdirSync(dirname(path), { recursive: true });
  let body = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (/^COSIMO_MASTER_KEY=/m.test(body))
    body = body.replace(/^COSIMO_MASTER_KEY=.*$/m, `COSIMO_MASTER_KEY=${key}`);
  else
    body = `# Cosimo secrets for docker compose / fly. Keep private and backed up: without the master key,\n# stored bank connections cannot be recovered.\nCOSIMO_MASTER_KEY=${key}\n${body}`;
  writeFileSync(path, body, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows
  }
}

/** `init --in-container`: the host wrote config and secrets; create the users and data here. */
async function applyInContainer(answers: Answers, opts: InitOptions): Promise<InitResult> {
  const env = opts.env ?? process.env;
  const loaded = loadConfig(opts.configPath, env);
  if (!loaded.effective.security.master_key && !env.COSIMO_MASTER_KEY)
    throw new InitError(3, "no_master_key", "COSIMO_MASTER_KEY is not set in the container.");
  const cfg = loaded.effective;
  const ctx = await createContext(cfg, { configPath: loaded.path, logger: silentLogger, env });
  const result: InitResult = {
    status: "ok",
    version: ctx.version,
    url: cfg.server.public_url,
    target: cfg.instance.target,
    database: cfg.database.mode === "turso" ? "turso" : "sqlite",
    config_path: loaded.path,
    master_key_location: "COSIMO_MASTER_KEY environment variable",
    claim_link: null,
    claim_link_expires_at: null,
    org_id: null,
    next_steps: [],
    warnings: [],
  };
  try {
    await createInstanceData(ctx, answers, opts, result);
  } finally {
    await ctx.close();
  }
  return result;
}

/** Settings, admin user (with a claim link unless a password was given), first org, demo data. */
async function createInstanceData(ctx: AppContext, answers: Answers, opts: InitOptions, result: InitResult) {
  const log = opts.log ?? (() => {});
  await applyInstanceAnswers(ctx, answers, opts.reconfigure ? new Set(Object.keys(answers)) : null);

  const email = String(answers.admin_email ?? "");
  let admin = email ? await ctx.users.byEmail(email) : null;
  if (!admin && email) {
    log(`Creating admin user ${email}`);
    const password =
      answers.admin_auth === "prompt" ? (answers.admin_password as string | undefined) : undefined;
    admin = await ctx.users.create({
      email,
      name: String(answers.admin_name ?? ""),
      password: password ?? null,
      isInstanceAdmin: true,
    });
    await instanceAudit(ctx.system, {
      userId: admin.id,
      action: "user.create.init",
      targetType: "user",
      targetId: admin.id,
    });
    if (!password) {
      const link = await ctx.users.issueClaimLink(admin.id);
      result.claim_link = `${ctx.config.server.public_url}/claim/${link.token}`;
      result.claim_link_expires_at = link.expiresAt;
      result.next_steps.push("Open the claim link to set your password.");
    }
  } else if (admin) {
    result.warnings.push(`User ${email} already exists; not changed.`);
  }

  if (admin && answers.org_name) {
    const existingOrgs = await ctx.orgs.listForUser(admin.id);
    const same = existingOrgs.find((o) => o.name === answers.org_name);
    if (same) {
      result.org_id = same.id;
    } else {
      log(`Creating organization "${answers.org_name}"`);
      const created = await ctx.orgs.create({
        name: String(answers.org_name),
        createdBy: admin.id,
        entityType: answers.entity_type as EntityType,
        coaTemplate: answers.coa_template as CoaTemplate,
        fiscalYearStartMonth: Number(answers.fiscal_year_start_month ?? 1),
        basis: (answers.basis as "cash" | "accrual") ?? "cash",
        booksStartDate: String(answers.books_start_date),
      });
      result.org_id = created.id;
    }
  }
  if (admin && answers.sample_data === true) {
    log("Loading demo organization");
    await (opts.sampleData ?? loadSampleData)(ctx, admin.id);
  }
}

/** Instance-level settings stored in the system DB. With `only`, apply just those answer IDs. */
export async function applyInstanceAnswers(ctx: AppContext, a: Answers, only: Set<string> | null) {
  const has = (id: string) => (only ? only.has(id) : a[id] !== undefined && a[id] !== null);
  if (has("signup_mode") && a.signup_mode) await ctx.settings.set("signup_mode", a.signup_mode as SignupMode);
  if (has("smtp_enabled") || has("smtp_host")) {
    if (a.smtp_enabled) {
      await ctx.settings.set("smtp", {
        enabled: true,
        host: String(a.smtp_host ?? ""),
        port: Number(a.smtp_port ?? 587),
        user: String(a.smtp_user ?? ""),
        password: String(a.smtp_password ?? ""),
        from: String(a.smtp_from ?? ""),
        secure: Number(a.smtp_port) === 465,
      });
    } else if (a.smtp_enabled === false) {
      await ctx.settings.set("smtp", { enabled: false });
    }
  }
  if (has("plaid_enabled") || has("plaid_client_id")) {
    if (a.plaid_enabled) {
      await ctx.settings.set("plaid", {
        enabled: true,
        env: (a.plaid_env as "sandbox" | "production") ?? "sandbox",
        client_id: String(a.plaid_client_id ?? ""),
        secret: String(a.plaid_secret ?? ""),
      });
    } else if (a.plaid_enabled === false) {
      await ctx.settings.set("plaid", { enabled: false });
    }
  }
}
