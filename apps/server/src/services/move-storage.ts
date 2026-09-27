/**
 * Move a stopped SQLite-mode instance to Turso or a self-hosted libSQL server (sqld with
 * namespaces), without losing anything: every table of the system DB and of every org DB
 * (archived ones included) is copied as is, so encrypted secrets stay readable with the same
 * master key and the hash chains keep their heads.
 *
 * The local config and databases are left as they were (apart from the safety backup that
 * `createBackup` records), so the old instance still works if the move is abandoned. The settings
 * needed to run against the new storage go to an env file, never to stdout.
 */
import { createHash } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { connectSystem, system } from "@cosimo/db";
import { type Client, createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import type { Config } from "../config.ts";
import { type AppContext, createContext } from "../context.ts";
import { silentLogger } from "../logger.ts";
import { copyToRemote, TargetNotEmptyError, userTables } from "./archive.ts";
import { createBackup, serverResponds, walkFiles } from "./backup.ts";
import { auditHead, ledgerHead, verifyOrg } from "./chain.ts";
import {
  dbNameForOrg,
  LibsqlNamespaceProvisioner,
  type NamedProvisioner,
  type ProvisionedDb,
  TursoProvisioner,
} from "./provisioning.ts";

export interface MoveStorageOptions {
  to: "turso" | "libsql";
  /** Name of the new system database (default `cosimo-system`). */
  systemName?: string;
  turso?: { org: string; group?: string; apiToken: string; apiUrl?: string };
  libsql?: { adminUrl: string; baseUrl: string; adminToken?: string };
  /** Where to write the `KEY=value` env for the new storage (mode 0600). */
  envOut?: string;
  configPath?: string;
  /** Environment for the safety backup (COSIMO_BACKUP_PASSPHRASE). */
  env?: Record<string, string | undefined>;
  /** Tests: probe fetch, and a provisioner in place of the one built from the options. */
  fetchImpl?: typeof fetch;
  provisioner?: NamedProvisioner;
  progress?: (msg: string) => void;
}

export interface MoveStorageResult {
  status: "ok";
  target: "turso" | "libsql";
  backup: string;
  system: { name: string; url: string; tables: number };
  orgs: {
    id: string;
    name: string;
    archived: boolean;
    db: string;
    url: string;
    tables: number;
    ledger_head: { seq: number; hash: string };
    audit_head: { seq: number; hash: string };
  }[];
  env_file: string | null;
  attachments: { kind: "local" | "s3"; dir: string; files: number };
}

export class MoveStorageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const DEFAULT_SYSTEM_NAME = "cosimo-system";

/** The config the moved instance runs with (same master key, new database settings). */
function targetConfig(cfg: Config, opts: MoveStorageOptions): Config {
  const c = structuredClone(cfg);
  c.database.mode = opts.to;
  c.database.system_url = "";
  c.database.system_auth_token = "";
  if (opts.to === "turso") {
    const t = opts.turso;
    if (!t?.org) throw new MoveStorageError("missing_argument", "--turso-org is required for --to turso");
    if (!t.apiToken)
      throw new MoveStorageError("missing_argument", "Set TURSO_API_TOKEN to a Turso Platform API token");
    c.database.turso_org = t.org;
    c.database.turso_group = t.group || "default";
    c.database.turso_api_token = t.apiToken;
    if (t.apiUrl) c.database.turso_api_url = t.apiUrl;
  } else if (opts.to === "libsql") {
    const l = opts.libsql;
    if (!l?.adminUrl || !l.baseUrl)
      throw new MoveStorageError(
        "missing_argument",
        "--libsql-admin-url and --libsql-base-url are required for --to libsql",
      );
    c.database.libsql_admin_url = l.adminUrl;
    c.database.libsql_base_url = l.baseUrl;
    c.database.libsql_admin_token = l.adminToken ?? "";
  } else {
    throw new MoveStorageError("invalid_argument", "--to must be turso or libsql");
  }
  return c;
}

function provisionerFor(c: Config): NamedProvisioner {
  if (c.database.mode === "turso")
    return new TursoProvisioner({
      apiUrl: c.database.turso_api_url,
      org: c.database.turso_org,
      group: c.database.turso_group,
      apiToken: c.database.turso_api_token,
    });
  return new LibsqlNamespaceProvisioner({
    adminUrl: c.database.libsql_admin_url,
    baseUrl: c.database.libsql_base_url,
    adminToken: c.database.libsql_admin_token || undefined,
  });
}

/** `bigint` ints so large integers survive the copy and the comparison exactly. */
function open(db: ProvisionedDb): Client {
  return createClient({ url: db.url, authToken: db.authToken, intMode: "bigint" });
}

/** A new Turso database can take a moment to answer; retry a trivial query for up to ~30s. */
async function waitReady(c: Client) {
  for (let i = 0; ; i++) {
    try {
      await c.execute("select 1");
      return;
    } catch (e) {
      if (i >= 30) throw e;
      await Bun.sleep(1000);
    }
  }
}

function cell(v: unknown): unknown {
  if (typeof v === "bigint") return `i:${v}`;
  if (v instanceof ArrayBuffer) return `b:${Buffer.from(v).toString("hex")}`;
  return v;
}

/** Row count and a digest of every row (rowid order) of each user table. */
async function tableStats(c: Client): Promise<Map<string, { rows: number; digest: string }>> {
  const out = new Map<string, { rows: number; digest: string }>();
  for (const t of await userTables(c)) {
    const q = `"${t.replace(/"/g, '""')}"`;
    const h = createHash("sha256");
    let rows = 0;
    for (let offset = 0; ; offset += 500) {
      const rs = await c.execute(`select * from ${q} order by rowid limit 500 offset ${offset}`);
      for (const r of rs.rows) h.update(`${JSON.stringify(rs.columns.map((_, i) => cell(r[i])))}\n`);
      rows += rs.rows.length;
      if (rs.rows.length < 500) break;
    }
    out.set(t, { rows, digest: h.digest("hex") });
  }
  return out;
}

/** Throws unless both databases hold the same tables with the same rows. Returns the table count. */
async function compareDbs(label: string, local: Client, remote: Client): Promise<number> {
  const [a, b] = await Promise.all([tableStats(local), tableStats(remote)]);
  const problems: string[] = [];
  for (const [t, s] of a) {
    const r = b.get(t);
    if (!r) problems.push(`${t}: missing`);
    else if (r.rows !== s.rows) problems.push(`${t}: ${s.rows} rows here, ${r.rows} there`);
    else if (r.digest !== s.digest) problems.push(`${t}: row contents differ`);
  }
  for (const t of b.keys()) if (!a.has(t)) problems.push(`${t}: unexpected table`);
  if (problems.length)
    throw new MoveStorageError(
      "verification_failed",
      `${label} did not copy exactly: ${problems.slice(0, 5).join("; ")}`,
    );
  return a.size;
}

function envLines(target: Config, sys: ProvisionedDb): string {
  const d = target.database;
  const env: Record<string, string> = {
    COSIMO_DATABASE_MODE: d.mode,
    COSIMO_DATABASE_SYSTEM_URL: sys.url,
  };
  if (sys.authToken) env.COSIMO_DATABASE_SYSTEM_AUTH_TOKEN = sys.authToken;
  if (d.mode === "turso") {
    env.COSIMO_DATABASE_TURSO_ORG = d.turso_org;
    env.COSIMO_DATABASE_TURSO_GROUP = d.turso_group;
    env.COSIMO_DATABASE_TURSO_API_TOKEN = d.turso_api_token;
  } else {
    env.COSIMO_DATABASE_LIBSQL_ADMIN_URL = d.libsql_admin_url;
    env.COSIMO_DATABASE_LIBSQL_BASE_URL = d.libsql_base_url;
    if (d.libsql_admin_token) env.COSIMO_DATABASE_LIBSQL_ADMIN_TOKEN = d.libsql_admin_token;
  }
  env.COSIMO_MASTER_KEY = target.security.master_key;
  return `${Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`;
}

/**
 * Copy this instance's databases to the target, point the copied org registry at the new org
 * databases, verify everything, and write the env file. On failure, the databases this run created
 * are dropped (best effort) and the error says which could not be.
 */
export async function moveStorage(cfg: Config, opts: MoveStorageOptions): Promise<MoveStorageResult> {
  const say = opts.progress ?? (() => {});
  if (cfg.database.mode !== "sqlite")
    throw new MoveStorageError(
      "unsupported_mode",
      `move-storage moves a SQLite instance; this one already uses ${cfg.database.mode}.`,
    );
  if (await serverResponds(cfg, opts.fetchImpl))
    throw new MoveStorageError(
      "server_running",
      "Stop the server before moving its storage (it is responding on its port).",
    );
  const target = targetConfig(cfg, opts);
  const systemName = opts.systemName || DEFAULT_SYSTEM_NAME;

  const ctx = await createContext(cfg, { configPath: opts.configPath, logger: silentLogger, env: {} });
  try {
    say("Taking a safety backup");
    const backup = await createBackup(ctx, { reason: "move-storage", env: opts.env });
    const provisioner = opts.provisioner ?? provisionerFor(target);
    const created: string[] = [];
    try {
      const result = await copyAll(ctx, target, provisioner, systemName, created, say);
      if (opts.envOut) {
        writeFileSync(opts.envOut, envLines(target, result.sys), { mode: 0o600 });
        chmodSync(opts.envOut, 0o600);
      }
      const attachments =
        cfg.storage.kind === "s3"
          ? { kind: "s3" as const, dir: `s3://${cfg.storage.s3_bucket}`, files: 0 }
          : { kind: "local" as const, dir: cfg.storage.dir, files: walkFiles(cfg.storage.dir).length };
      return {
        status: "ok",
        target: opts.to,
        backup: backup.file,
        system: { name: systemName, url: result.sys.url, tables: result.systemTables },
        orgs: result.orgs,
        env_file: opts.envOut ?? null,
        attachments,
      };
    } catch (e) {
      const cleaned: string[] = [];
      const notCleaned: string[] = [];
      for (const name of [...created].reverse()) {
        try {
          await provisioner.destroyNamed(name);
          cleaned.push(name);
        } catch {
          notCleaned.push(name);
        }
      }
      const msg = (e as Error).message;
      const tail = notCleaned.length
        ? ` Could not drop ${notCleaned.join(", ")}; delete them by hand before retrying.`
        : created.length
          ? ` Dropped the ${created.length} database(s) this run created.`
          : "";
      const code = e instanceof MoveStorageError || e instanceof TargetNotEmptyError ? e.code : "move_failed";
      throw new MoveStorageError(code, `${msg}${tail} Local data is unchanged.`, {
        cleaned,
        not_cleaned: notCleaned,
      });
    }
  } finally {
    await ctx.close();
  }
}

async function copyAll(
  ctx: AppContext,
  target: Config,
  provisioner: NamedProvisioner,
  systemName: string,
  created: string[],
  say: (msg: string) => void,
) {
  // System DB: copied exactly, including the org registry with its local file URLs for now.
  say(`Creating ${systemName}`);
  const sys = await provisioner.createNamed(systemName);
  created.push(systemName);
  const localSys = createClient({ url: ctx.config.database.system_url, intMode: "bigint" });
  const remoteSys = open(sys);
  let systemTables: number;
  try {
    await waitReady(remoteSys);
    say("Copying the system database");
    await copyToRemote(localSys, remoteSys);
    systemTables = await compareDbs("The system database", localSys, remoteSys);
  } finally {
    localSys.close();
    remoteSys.close();
  }

  // Org DBs, archived ones included.
  const orgs: MoveStorageResult["orgs"] = [];
  const provisioned = new Map<string, ProvisionedDb>();
  for (const o of await ctx.orgs.list({ includeArchived: true })) {
    const db = dbNameForOrg(o.id);
    say(`Copying ${o.name} to ${db}`);
    const prov = await provisioner.create(o.id);
    created.push(db);
    provisioned.set(o.id, prov);
    const local = createClient({ url: o.dbUrl, intMode: "bigint" });
    const remote = open(prov);
    try {
      await waitReady(remote);
      await copyToRemote(local, remote);
      const tables = await compareDbs(`${o.name} (${o.id})`, local, remote);
      const h = await ctx.orgs.mustOpen(o.id);
      orgs.push({
        id: o.id,
        name: o.name,
        archived: Boolean(o.archivedAt),
        db,
        url: prov.url,
        tables,
        ledger_head: await ledgerHead(h.db, o.id),
        audit_head: await auditHead(h.db, o.id),
      });
    } finally {
      local.close();
      remote.close();
    }
  }

  // Point the copied registry at the new org databases (tokens encrypted as in OrgService.create).
  say("Pointing the organization registry at the new databases");
  const reg = connectSystem(sys.url, sys.authToken);
  try {
    await reg.write(async (tx) => {
      for (const [id, prov] of provisioned)
        await tx
          .update(system.organizations)
          .set({ dbUrl: prov.url, dbTokenEnc: prov.authToken ? ctx.secrets.encrypt(prov.authToken) : null })
          .where(eq(system.organizations.id, id));
    });
  } finally {
    reg.close();
  }

  // Open the new storage the way `cosimo serve` will, and check it end to end.
  say("Verifying the new storage");
  const moved = structuredClone(target);
  moved.database.system_url = sys.url;
  moved.database.system_auth_token = sys.authToken ?? "";
  const rctx = await createContext(moved, { logger: silentLogger, env: {}, provisioner });
  try {
    const listed = await rctx.orgs.list({ includeArchived: true });
    if (listed.length !== orgs.length)
      throw new MoveStorageError(
        "verification_failed",
        `The new registry lists ${listed.length} organization(s), expected ${orgs.length}.`,
      );
    for (const o of orgs) {
      const reg = listed.find((r) => r.id === o.id);
      if (reg?.dbUrl !== o.url)
        throw new MoveStorageError("verification_failed", `${o.name} is not registered at its new database.`);
      // Open through the registry (decrypting the stored token) as the server will.
      const h = await rctx.orgs.mustOpen(o.id);
      const v = await verifyOrg(h.db, o.id);
      const lh = await ledgerHead(h.db, o.id);
      const ah = await auditHead(h.db, o.id);
      const same =
        lh.seq === o.ledger_head.seq &&
        lh.hash === o.ledger_head.hash &&
        ah.seq === o.audit_head.seq &&
        ah.hash === o.audit_head.hash;
      if (!v.ok || !same)
        throw new MoveStorageError(
          "verification_failed",
          `${o.name} (${o.id}): ${v.ok ? "chain heads differ from the local ones" : "chains do not verify"}.`,
        );
    }
    // The encrypted instance secrets decrypt with the same master key.
    for (const key of ["plaid", "smtp"] as const) {
      const [a, b] = [await ctx.settings.get(key), await rctx.settings.get(key)];
      if (JSON.stringify(a) !== JSON.stringify(b))
        throw new MoveStorageError("verification_failed", `The ${key} settings differ after the move.`);
    }
  } finally {
    await rctx.close();
  }

  return { sys, systemTables, orgs };
}
