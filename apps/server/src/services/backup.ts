/**
 * Backups and restore (SPEC §14.1).
 *
 * A backup is one ZIP: `manifest.json` (checksums, chain heads), `system.db`, `orgs/<id>.db`,
 * `config.toml` with secrets removed, and the attachments when they are stored locally. Secrets
 * are included only when `backups.include_secrets` is on and `COSIMO_BACKUP_PASSPHRASE` is set; they
 * go into `secrets.enc`, encrypted with a key derived from that passphrase (not the master key,
 * which is what a restore may be missing).
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { connectOrg, connectSystem, newId, org, system } from "@cosimo/db";
import { VERSION } from "@cosimo/shared";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { type Config, loadConfig, renderConfig } from "../config.ts";
import type { AppContext } from "../context.ts";
import { checkSums, json, readZip, snapshotDb, writeZip, type ZipSource } from "./archive.ts";
import { auditHead, ledgerHead, verifyOrg } from "./chain.ts";

export const BACKUP_FORMAT = "cosimo-backup";
export const BACKUP_FORMAT_VERSION = 1;
export const NAME_RE = /^cosimo-backup-(\d{8}T\d{6}Z)\.zip$/;

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  format_version: number;
  version: string;
  created_at: string;
  reason: string;
  database_mode: string;
  secrets_omitted: boolean;
  attachments: "included" | "s3" | "none";
  orgs: {
    id: string;
    name: string;
    archived: boolean;
    ledger_head: { seq: number; hash: string };
    audit_head: { seq: number; hash: string };
  }[];
  files: Record<string, { sha256: string; bytes: number }>;
}

export interface BackupResult {
  file: string;
  name: string;
  bytes: number;
  created_at: string;
  destination: "local" | "s3";
  orgs: number;
  secrets_omitted: boolean;
  deleted: string[];
  /** Retention deletes that failed (for example a bucket retention lock); the backup still succeeded. */
  warnings: string[];
}

export interface BucketObject {
  key: string;
  size: number;
  lastModified: string;
}

/**
 * The backup bucket, over `Bun.S3Client` and the `storage.s3_*` settings (backups don't get their
 * own bucket settings). No provider-specific code: every provider goes through this same interface.
 */
export interface BackupBucket {
  write(key: string, file: Bun.BunFile | Blob): Promise<void>;
  list(prefix: string): Promise<BucketObject[]>;
  delete(key: string): Promise<void>;
  download(key: string, dest: string): Promise<void>;
}

const SECRET_KEYS: [keyof Config, string][] = [
  ["security", "master_key"],
  ["database", "system_auth_token"],
  ["database", "turso_api_token"],
  ["database", "libsql_admin_token"],
  ["storage", "s3_secret_key"],
  ["updates", "github_token"],
];

function stamp(d: Date) {
  return d
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/** Config with every secret blanked, plus the removed values. */
export function splitSecrets(cfg: Config): { clean: Config; secrets: Record<string, string> } {
  const clean = structuredClone(cfg);
  const secrets: Record<string, string> = {};
  for (const [section, key] of SECRET_KEYS) {
    const s = clean[section] as unknown as Record<string, string>;
    if (s[key]) secrets[`${section}.${key}`] = s[key]!;
    s[key] = "";
  }
  return { clean, secrets };
}

function encryptWithPassphrase(plain: string, passphrase: string) {
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return JSON.stringify({
    kdf: "scrypt",
    n: 1 << 15,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: c.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  });
}

export function decryptWithPassphrase(blob: string, passphrase: string): string {
  const b = JSON.parse(blob) as { n: number; salt: string; iv: string; tag: string; data: string };
  const key = scryptSync(passphrase, Buffer.from(b.salt, "base64"), 32, {
    N: b.n,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(b.iv, "base64"));
  d.setAuthTag(Buffer.from(b.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(b.data, "base64")), d.final()]).toString("utf8");
}

export function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walkFiles(p) : [p];
  });
}

export function backupBucket(cfg: Config, reveal: (v: string) => string | null): BackupBucket {
  const client = new Bun.S3Client({
    endpoint: cfg.storage.s3_endpoint || undefined,
    bucket: cfg.storage.s3_bucket,
    region: cfg.storage.s3_region || undefined,
    accessKeyId: cfg.storage.s3_access_key,
    secretAccessKey: reveal(cfg.storage.s3_secret_key) ?? "",
  });
  return {
    async write(key, file) {
      await client.write(key, file);
    },
    async list(prefix) {
      const r = await client.list({ prefix });
      return (r.contents ?? []).map((o) => ({
        key: o.key,
        size: o.size ?? 0,
        lastModified: o.lastModified ?? "",
      }));
    },
    async delete(key) {
      await client.delete(key);
    },
    async download(key, dest) {
      const f = client.file(key);
      if (!(await f.exists())) throw new Error(`Not found in the bucket: ${key}`);
      await Bun.write(dest, f);
    },
  };
}

/** Create a backup now. `reason`: scheduled, manual, upgrade. `bucket`: tests pass an in-memory fake. */
export async function createBackup(
  ctx: AppContext,
  opts: { reason?: string; env?: Record<string, string | undefined>; bucket?: BackupBucket } = {},
): Promise<BackupResult> {
  const env = opts.env ?? process.env;
  const cfg = ctx.config;
  const now = new Date();
  const name = `cosimo-backup-${stamp(now)}.zip`;
  let work: string;
  if (cfg.backups.mode === "s3") {
    // The zip goes to the bucket, so `backups.dir` is never created or touched; a scratch dir under
    // the OS tmpdir doesn't depend on that (possibly unwritable, root-owned) directory existing.
    work = mkdtempSync(join(tmpdir(), "cosimo-backup-"));
  } else {
    // Local mode stages next to the destination, because the final `renameSync` below must stay on
    // one filesystem.
    mkdirSync(cfg.backups.dir, { recursive: true, mode: 0o700 });
    work = join(cfg.backups.dir, `.tmp-${stamp(now)}-${process.pid}`);
    mkdirSync(work, { recursive: true, mode: 0o700 });
  }
  try {
    const entries: ZipSource[] = [];
    await snapshotDb(ctx.system.client, cfg.database.system_url, join(work, "system.db"));
    entries.push({ name: "system.db", path: join(work, "system.db") });

    const orgs: BackupManifest["orgs"] = [];
    mkdirSync(join(work, "orgs"));
    for (const o of await ctx.orgs.list({ includeArchived: true })) {
      const h = await ctx.orgs.mustOpen(o.id);
      const out = join(work, "orgs", `${o.id}.db`);
      await snapshotDb(h.client, o.dbUrl, out);
      entries.push({ name: `orgs/${o.id}.db`, path: out });
      orgs.push({
        id: o.id,
        name: o.name,
        archived: Boolean(o.archivedAt),
        ledger_head: await ledgerHead(h.db, o.id),
        audit_head: await auditHead(h.db, o.id),
      });
    }

    const loaded = loadConfig(ctx.configPath || undefined, {});
    const { clean, secrets } = splitSecrets(loaded.exists ? loaded.file : cfg);
    entries.push({ name: "config.toml", data: new TextEncoder().encode(renderConfig(clean, false)) });
    const passphrase = env.COSIMO_BACKUP_PASSPHRASE;
    const withSecrets = cfg.backups.include_secrets && Boolean(passphrase);
    if (withSecrets) {
      const all = { ...secrets, "security.master_key": cfg.security.master_key };
      entries.push({
        name: "secrets.enc",
        data: new TextEncoder().encode(encryptWithPassphrase(JSON.stringify(all), passphrase!)),
      });
    }

    let attachments: BackupManifest["attachments"] = "none";
    if (cfg.storage.kind === "s3") attachments = "s3";
    else {
      const files = walkFiles(cfg.storage.dir);
      if (files.length) attachments = "included";
      for (const f of files)
        entries.push({
          name: `attachments/${relative(cfg.storage.dir, f).replace(/\\/g, "/")}`,
          path: f,
          store: true,
        });
    }

    const final = join(work, name);
    let manifest: BackupManifest | null = null;
    await writeZip(final, entries, (files) => {
      manifest = {
        format: BACKUP_FORMAT,
        format_version: BACKUP_FORMAT_VERSION,
        version: VERSION,
        created_at: now.toISOString(),
        reason: opts.reason ?? "manual",
        database_mode: cfg.database.mode,
        secrets_omitted: !withSecrets,
        attachments,
        orgs,
        files,
      };
      return { name: "manifest.json", data: json(manifest) };
    });
    const reason = (manifest as BackupManifest | null)?.reason ?? "manual";

    let file: string;
    let destination: BackupResult["destination"] = "local";
    if (cfg.backups.mode === "s3") {
      const bucket = opts.bucket ?? backupBucket(cfg, (v) => ctx.secrets.reveal(v));
      await bucket.write(`backups/${name}`, Bun.file(final));
      file = `s3://${cfg.storage.s3_bucket}/backups/${name}`;
      destination = "s3";
    } else {
      file = join(cfg.backups.dir, name);
      renameSync(final, file);
    }
    const bytes = destination === "local" ? statSync(file).size : statSync(final).size;

    // Anchor the chain heads in this backup (SPEC §6.5).
    for (const o of orgs) {
      const h = await ctx.orgs.mustOpen(o.id);
      await h.write(async (tx) => {
        for (const chain of ["ledger", "audit"] as const) {
          const head = chain === "ledger" ? o.ledger_head : o.audit_head;
          await tx.insert(org.chainCheckpoints).values({
            id: newId(),
            chain,
            seq: head.seq,
            headHash: head.hash,
            reason: "backup",
            exportedTo: file,
          });
        }
      });
    }

    const { deleted, warnings } = await applyRetention(ctx, cfg, opts.bucket);
    const result: BackupResult = {
      file,
      name,
      bytes,
      created_at: now.toISOString(),
      destination,
      orgs: orgs.length,
      secrets_omitted: !withSecrets,
      deleted,
      warnings,
    };
    await ctx.settings.set("last_backup", {
      file,
      at: result.created_at,
      bytes,
      destination,
      reason,
    });
    return result;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------------------- retention

/** The timestamp encoded in a backup's name (the reverse of `stamp`). */
export function dateFromName(name: string): Date | null {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const s = m[1]!;
  return new Date(
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`,
  );
}

/**
 * Keep the newest backup of each of the last `keep_daily` days, `keep_weekly` ISO weeks, and
 * `keep_monthly` months (defaults 14/8/12). Everything else matching our file name is deleted.
 */
export function retentionPlan(names: string[], keep: { daily: number; weekly: number; monthly: number }) {
  const parsed = names
    .map((name) => ({ name, d: dateFromName(name) }))
    .filter((x): x is { name: string; d: Date } => x.d !== null)
    .sort((a, b) => b.d.getTime() - a.d.getTime());
  const keepSet = new Set<string>();
  const bucket = (fn: (d: Date) => string, count: number) => {
    const seen = new Set<string>();
    for (const b of parsed) {
      const k = fn(b.d);
      if (seen.has(k)) continue;
      if (seen.size >= count) break;
      seen.add(k);
      keepSet.add(b.name);
    }
  };
  bucket((d) => d.toISOString().slice(0, 10), keep.daily);
  bucket(isoWeek, keep.weekly);
  bucket((d) => d.toISOString().slice(0, 7), keep.monthly);
  return {
    keep: parsed.filter((b) => keepSet.has(b.name)).map((b) => b.name),
    remove: parsed.filter((b) => !keepSet.has(b.name)).map((b) => b.name),
  };
}

function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7);
  return `${y}-W${week}`;
}

/**
 * Delete everything `retentionPlan` doesn't keep. In s3 mode, a list or delete that throws (a bucket
 * retention lock, for example) becomes a warning rather than a failure: the backup already
 * succeeded, and the object it couldn't remove is still there next time.
 */
async function applyRetention(
  ctx: AppContext,
  cfg: Config,
  bucket?: BackupBucket,
): Promise<{ deleted: string[]; warnings: string[] }> {
  const keep = {
    daily: cfg.backups.keep_daily,
    weekly: cfg.backups.keep_weekly,
    monthly: cfg.backups.keep_monthly,
  };
  if (cfg.backups.mode === "s3") {
    const b = bucket ?? backupBucket(cfg, (v) => ctx.secrets.reveal(v));
    let list: BucketObject[];
    try {
      list = await b.list("backups/");
    } catch (e) {
      return {
        deleted: [],
        warnings: [
          `Could not list backups/ in the bucket, so old backups were not pruned: ${(e as Error).message}`,
        ],
      };
    }
    const names = list.map((o) => basename(o.key));
    const plan = retentionPlan(names, keep);
    const deleted: string[] = [];
    const warnings: string[] = [];
    for (const n of plan.remove) {
      try {
        await b.delete(`backups/${n}`);
        deleted.push(n);
      } catch (e) {
        warnings.push(
          `Could not delete backups/${n} from the bucket (it may be locked by a retention policy): ${(e as Error).message}`,
        );
      }
    }
    return { deleted, warnings };
  }
  const names = existsSync(cfg.backups.dir) ? readdirSync(cfg.backups.dir) : [];
  const plan = retentionPlan(names, keep);
  for (const n of plan.remove) rmSync(join(cfg.backups.dir, n), { force: true });
  return { deleted: plan.remove, warnings: [] };
}

export interface BackupRow {
  name: string;
  file: string;
  bytes: number;
  created_at: string;
}

/**
 * List backups, newest first. In s3 mode this lists the bucket's `backups/` prefix and takes
 * `created_at` from the name's own timestamp (not the object's `lastModified`, which is the upload
 * time and can differ slightly). `bucket`: tests pass an in-memory fake.
 */
export async function listBackups(
  cfg: Config,
  opts: { bucket?: BackupBucket; reveal?: (v: string) => string | null } = {},
): Promise<BackupRow[]> {
  if (cfg.backups.mode === "s3") {
    const bucket = opts.bucket ?? backupBucket(cfg, opts.reveal ?? ((v) => v));
    const list = await bucket.list("backups/");
    return list
      .map((o) => ({ name: basename(o.key), size: o.size }))
      .filter((o) => NAME_RE.test(o.name))
      .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
      .map((o) => ({
        name: o.name,
        file: `s3://${cfg.storage.s3_bucket}/backups/${o.name}`,
        bytes: o.size,
        created_at: dateFromName(o.name)!.toISOString(),
      }));
  }
  if (!existsSync(cfg.backups.dir)) return [];
  return readdirSync(cfg.backups.dir)
    .filter((n) => NAME_RE.test(n))
    .sort()
    .reverse()
    .map((n) => {
      const st = statSync(join(cfg.backups.dir, n));
      return { name: n, file: join(cfg.backups.dir, n), bytes: st.size, created_at: st.mtime.toISOString() };
    });
}

// ----------------------------------------------------------------------------- restore

export interface RestoreResult {
  status: "ok";
  backup: string;
  created_at: string;
  orgs: { id: string; name: string; chains_ok: boolean; integrity: string }[];
  attachments_restored: number;
  previous_data: string | null;
  warnings: string[];
}

export class RestoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Fetch a backup out of the bucket into `dest` (default `<backups.dir>/<name>`), so it can be
 * restored like any local backup. `restore` itself stays file-based; this is the download step.
 */
export async function downloadBackup(
  cfg: Config,
  name: string,
  dest?: string,
  opts: { bucket?: BackupBucket; reveal?: (v: string) => string | null } = {},
): Promise<{ file: string }> {
  if (!NAME_RE.test(name)) throw new RestoreError("invalid_name", `Not a Cosimo backup name: ${name}`);
  const file = dest ? resolve(dest) : join(cfg.backups.dir, name);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const bucket = opts.bucket ?? backupBucket(cfg, opts.reveal ?? ((v) => v));
  await bucket.download(`backups/${name}`, file);
  return { file };
}

/** Whether a Cosimo server answers `/healthz` on this config's port (restore and move-storage need it stopped). */
export async function serverResponds(cfg: Config, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const host = cfg.server.host === "0.0.0.0" ? "127.0.0.1" : cfg.server.host;
    const r = await fetchImpl(`http://${host}:${cfg.server.port}/healthz`, {
      signal: AbortSignal.timeout(1500),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Restore a backup into a stopped SQLite-mode instance. The current databases are moved aside
 * (never deleted) and every restored org is verified afterwards.
 */
export async function restoreBackup(
  cfg: Config,
  file: string,
  opts: { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch } = {},
): Promise<RestoreResult> {
  const f = opts.fetchImpl ?? fetch;
  if (cfg.database.mode !== "sqlite")
    throw new RestoreError(
      "unsupported_mode",
      "Restore writes local SQLite files. For Turso or libSQL servers, restore into a SQLite instance and move organizations with `cosimo export` / `cosimo import`.",
    );
  if (await serverResponds(cfg, f))
    throw new RestoreError(
      "server_running",
      "Stop the server before restoring (it is responding on its port).",
    );
  if (!existsSync(file)) throw new RestoreError("not_found", `Backup not found: ${file}`);
  const files = readZip(new Uint8Array(readFileSync(file)));
  const manifestBytes = files["manifest.json"];
  if (!manifestBytes) throw new RestoreError("invalid_backup", "Not a Cosimo backup (no manifest.json).");
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as BackupManifest;
  if (manifest.format !== BACKUP_FORMAT) throw new RestoreError("invalid_backup", "Not a Cosimo backup.");
  const bad = checkSums(files, manifest.files);
  if (bad.length)
    throw new RestoreError("checksum_mismatch", `Backup is damaged: ${bad.slice(0, 5).join(", ")}`);

  const dataDir = join(cfg.database.data_dir, "data");
  const warnings: string[] = [];
  let previous: string | null = null;
  if (existsSync(dataDir) && readdirSync(dataDir).length) {
    previous = join(cfg.database.data_dir, `data.before-restore-${stamp(new Date())}`);
    renameSync(dataDir, previous);
  }
  mkdirSync(join(dataDir, "orgs"), { recursive: true, mode: 0o700 });
  writeFileSync(join(dataDir, "system.db"), files["system.db"]!, { mode: 0o600 });
  for (const o of manifest.orgs)
    writeFileSync(join(dataDir, "orgs", `${o.id}.db`), files[`orgs/${o.id}.db`]!, { mode: 0o600 });

  // Point the registry at this machine's files (the backup may come from another host).
  const sys = connectSystem(`file:${join(dataDir, "system.db")}`);
  try {
    for (const o of manifest.orgs)
      await sys.write((tx) =>
        tx
          .update(system.organizations)
          .set({ dbUrl: `file:${join(dataDir, "orgs", `${o.id}.db`)}`, dbTokenEnc: null })
          .where(eq(system.organizations.id, o.id)),
      );
  } finally {
    sys.close();
  }

  let attachments = 0;
  if (manifest.attachments === "included") {
    for (const [name, bytes] of Object.entries(files)) {
      if (!name.startsWith("attachments/")) continue;
      const dest = join(cfg.storage.dir, name.slice("attachments/".length));
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      writeFileSync(dest, bytes, { mode: 0o600 });
      attachments++;
    }
  } else if (manifest.attachments === "s3") {
    warnings.push("Attachments live in S3 and were not part of this backup; make sure the bucket is intact.");
  }
  if (manifest.secrets_omitted)
    warnings.push(
      "This backup has no secrets. The master key in your config must be the one the backed-up instance used, or stored bank connections and SMTP/Plaid secrets can't be decrypted.",
    );

  const orgs: RestoreResult["orgs"] = [];
  for (const o of manifest.orgs) {
    const url = `file:${join(dataDir, "orgs", `${o.id}.db`)}`;
    const client = createClient({ url });
    const integrity = String((await client.execute("pragma integrity_check")).rows[0]?.[0] ?? "unknown");
    client.close();
    const h = connectOrg(url);
    try {
      const v = await verifyOrg(h.db, o.id);
      const head = await ledgerHead(h.db, o.id);
      const matches = head.seq === o.ledger_head.seq && head.hash === o.ledger_head.hash;
      orgs.push({ id: o.id, name: o.name, chains_ok: v.ok && matches, integrity });
    } finally {
      h.close();
    }
  }
  return {
    status: "ok",
    backup: file,
    created_at: manifest.created_at,
    orgs,
    attachments_restored: attachments,
    previous_data: previous,
    warnings,
  };
}
