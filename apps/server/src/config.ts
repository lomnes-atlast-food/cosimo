/**
 * Instance configuration: one TOML file (SPEC §13.7). Every key can be overridden by an
 * environment variable `COSIMO_<SECTION>_<KEY>`. The master key may also come from
 * `COSIMO_MASTER_KEY`.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";

export interface Config {
  server: {
    host: string;
    port: number;
    public_url: string;
    trust_proxy: boolean;
  };
  database: {
    /** sqlite: local files; turso: Turso Platform; libsql: self-hosted sqld with namespaces */
    mode: "sqlite" | "turso" | "libsql";
    data_dir: string;
    system_url: string;
    system_auth_token: string;
    turso_org: string;
    turso_api_token: string;
    turso_group: string;
    turso_api_url: string;
    libsql_admin_url: string;
    libsql_admin_token: string;
    /** e.g. http://localhost:8080; org namespaces are reached at http://<ns>.localhost:8080 */
    libsql_base_url: string;
  };
  security: {
    master_key: string;
  };
  storage: {
    kind: "local" | "s3";
    dir: string;
    s3_endpoint: string;
    s3_bucket: string;
    s3_region: string;
    s3_access_key: string;
    s3_secret_key: string;
  };
  backups: {
    mode: "local" | "s3" | "off";
    dir: string;
    time: string;
    keep_daily: number;
    keep_weekly: number;
    keep_monthly: number;
    include_secrets: boolean;
  };
  jobs: {
    enabled: boolean;
    plaid_sync_hours: number;
    verify_weekday: number;
  };
  instance: {
    target: "local" | "docker" | "fly";
    created_at: string;
  };
  updates: {
    /** Check GitHub Releases for a newer Cosimo (instance admins only; see services/updates.ts). */
    check: boolean;
    /** For the private repo; unneeded once it's public. */
    github_token: string;
  };
  anchoring: {
    /** Publicly timestamp the chain heads daily (SPEC §6.5, services/anchors.ts). */
    enabled: boolean;
    /** Comma-separated OpenTimestamps calendar URLs; "" skips OpenTimestamps. */
    ots_calendars: string;
    /** RFC 3161 timestamp authority; "" skips RFC 3161. */
    tsa_url: string;
    /** PEM file of extra roots trusted for tsa_url's tokens (FreeTSA's root is built in). */
    tsa_ca_file: string;
    /** Esplora-style block explorer API used to confirm Bitcoin attestations. */
    bitcoin_api: string;
  };
}

/** Keys whose values are secret: shown as ******** and encrypted at rest where possible. */
export const SECRET_KEYS = new Set([
  "security.master_key",
  "database.system_auth_token",
  "database.turso_api_token",
  "database.libsql_admin_token",
  "storage.s3_secret_key",
  "updates.github_token",
]);

export const DEFAULT_OTS_CALENDARS = [
  "https://alice.btc.calendar.opentimestamps.org",
  "https://bob.btc.calendar.opentimestamps.org",
  "https://finney.calendar.eternitywall.com",
].join(",");

export function defaultDataDir(): string {
  return join(homedir(), ".cosimo");
}

export function defaultConfig(dataDir = defaultDataDir()): Config {
  return {
    server: { host: "127.0.0.1", port: 8787, public_url: "http://localhost:8787", trust_proxy: false },
    database: {
      mode: "sqlite",
      data_dir: dataDir,
      system_url: "",
      system_auth_token: "",
      turso_org: "",
      turso_api_token: "",
      turso_group: "default",
      turso_api_url: "https://api.turso.tech",
      libsql_admin_url: "",
      libsql_admin_token: "",
      libsql_base_url: "",
    },
    security: { master_key: "" },
    storage: {
      kind: "local",
      dir: "",
      s3_endpoint: "",
      s3_bucket: "",
      s3_region: "",
      s3_access_key: "",
      s3_secret_key: "",
    },
    backups: {
      mode: "local",
      dir: "",
      time: "03:00",
      keep_daily: 14,
      keep_weekly: 8,
      keep_monthly: 12,
      include_secrets: false,
    },
    jobs: { enabled: true, plaid_sync_hours: 6, verify_weekday: 0 },
    instance: { target: "local", created_at: "" },
    updates: { check: true, github_token: "" },
    anchoring: {
      enabled: true,
      ots_calendars: DEFAULT_OTS_CALENDARS,
      tsa_url: "https://freetsa.org/tsr",
      tsa_ca_file: "",
      bitcoin_api: "https://blockstream.info/api",
    },
  };
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Candidate config paths in precedence order. */
export function resolveConfigPath(explicit?: string): string {
  if (explicit) return resolve(expandHome(explicit));
  if (process.env.COSIMO_CONFIG) return resolve(expandHome(process.env.COSIMO_CONFIG));
  const home = join(defaultDataDir(), "config.toml");
  if (existsSync(home)) return home;
  if (existsSync("/etc/cosimo/config.toml")) return "/etc/cosimo/config.toml";
  return home;
}

function mergeDeep<T>(base: T, over: unknown): T {
  if (over == null || typeof over !== "object") return base;
  const out = structuredClone(base) as Record<string, unknown>;
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    const cur = out[k];
    if (cur && typeof cur === "object" && !Array.isArray(cur) && v && typeof v === "object") {
      out[k] = mergeDeep(cur, v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

function coerce(template: unknown, raw: string): unknown {
  if (typeof template === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`Expected a number, got ${raw}`);
    return n;
  }
  if (typeof template === "boolean") return /^(1|true|yes|on)$/i.test(raw);
  return raw;
}

/** Apply COSIMO_<SECTION>_<KEY> environment overrides. */
export function applyEnv(cfg: Config, env: Record<string, string | undefined> = process.env): Config {
  const out = structuredClone(cfg) as unknown as Record<string, Record<string, unknown>>;
  for (const [section, values] of Object.entries(out)) {
    for (const key of Object.keys(values)) {
      const name = `COSIMO_${section}_${key}`.toUpperCase();
      const v = env[name];
      if (v !== undefined) values[key] = coerce(values[key], v);
    }
  }
  if (env.COSIMO_MASTER_KEY) (out.security as Record<string, unknown>).master_key = env.COSIMO_MASTER_KEY;
  return out as unknown as Config;
}

export interface LoadedConfig {
  path: string;
  exists: boolean;
  /** Values from the file only (no env), used for editing. */
  file: Config;
  /** Effective values after env overrides. */
  effective: Config;
}

export function loadConfig(explicitPath?: string, env = process.env): LoadedConfig {
  const path = resolveConfigPath(explicitPath);
  const exists = existsSync(path);
  const raw = exists ? parse(readFileSync(path, "utf8")) : {};
  const file = mergeDeep(defaultConfig(), raw);
  const effective = finalize(applyEnv(file, env));
  return { path, exists, file, effective };
}

/** Fill derived defaults (paths under data_dir). */
export function finalize(cfg: Config): Config {
  const c = structuredClone(cfg);
  c.database.data_dir = resolve(expandHome(c.database.data_dir || defaultDataDir()));
  if (!c.database.system_url && c.database.mode === "sqlite") {
    c.database.system_url = `file:${join(c.database.data_dir, "data", "system.db")}`;
  }
  if (!c.storage.dir) c.storage.dir = join(c.database.data_dir, "attachments");
  c.storage.dir = resolve(expandHome(c.storage.dir));
  if (!c.backups.dir) c.backups.dir = join(c.database.data_dir, "backups");
  c.backups.dir = resolve(expandHome(c.backups.dir));
  return c;
}

/** TOML text of a config, with a header saying where the master key lives. */
export function renderConfig(cfg: Config, secretsInFile = true): string {
  const header = secretsInFile
    ? "# Cosimo configuration. Contains the master key: keep this file private and backed up.\n"
    : "# Cosimo configuration. The master key is not stored in this file.\n";
  return `${header}${stringify(cfg as unknown as Record<string, unknown>)}\n`;
}

export function saveConfig(
  path: string,
  cfg: Config,
  opts: { mode?: number; secretsInFile?: boolean } = {},
): void {
  const mode = opts.mode ?? 0o600;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const body = renderConfig(cfg, opts.secretsInFile !== false);
  writeFileSync(tmp, body, { mode });
  try {
    chmodSync(tmp, mode);
  } catch {
    // Windows: chmod is a no-op
  }
  renameSync(tmp, path);
}

export function getKey(cfg: Config, dotted: string): unknown {
  const [section, key] = dotted.split(".");
  const s = (cfg as unknown as Record<string, Record<string, unknown>>)[section ?? ""];
  if (!s || !key || !(key in s)) throw new Error(`Unknown config key: ${dotted}`);
  return s[key];
}

export function setKey(cfg: Config, dotted: string, raw: string): Config {
  const out = structuredClone(cfg) as unknown as Record<string, Record<string, unknown>>;
  const [section, key] = dotted.split(".");
  const s = out[section ?? ""];
  if (!s || !key || !(key in s)) throw new Error(`Unknown config key: ${dotted}`);
  s[key] = coerce(s[key], raw);
  return out as unknown as Config;
}

export function listKeys(cfg: Config): { key: string; value: unknown; secret: boolean }[] {
  const out: { key: string; value: unknown; secret: boolean }[] = [];
  for (const [section, values] of Object.entries(cfg as unknown as Record<string, Record<string, unknown>>)) {
    for (const [k, v] of Object.entries(values)) {
      const key = `${section}.${k}`;
      const secret = SECRET_KEYS.has(key);
      out.push({ key, value: secret && v ? "********" : v, secret });
    }
  }
  return out;
}
