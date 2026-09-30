/**
 * `cosimo doctor` (SPEC §13.4): health checks with a remediation for each non-pass. Read-only:
 * it never migrates or repairs anything.
 */
import { accessSync, constants, existsSync, readdirSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { type OrgDb, orgMigrations, org as orgSchema, pendingMigrations, systemMigrations } from "@cosimo/db";
import { VERSION } from "@cosimo/shared";
import { asc, desc, eq, gt, isNotNull } from "drizzle-orm";
import { type Config, loadConfig } from "../config.ts";
import { type AppContext, createContext } from "../context.ts";
import { SecretBox } from "../crypto.ts";
import { silentLogger } from "../logger.ts";
import { type BackupBucket, type BucketObject, backupBucket } from "./backup.ts";
import { verifyOrg } from "./chain.ts";
import { settingsRow } from "./ledger.ts";
import type { Mailer } from "./mailer.ts";
import {
  lastPayError,
  paymentWebhookUrl,
  setupWarning,
  staleUnhandledEvents,
  summarizeSetup,
} from "./online-payments.ts";
import { type StripeOptions, stripeOptions, stripeSecrets } from "./payment-providers/index.ts";
import { stripeClient, WEBHOOK_EVENTS_VERSION } from "./payment-providers/stripe.ts";
import { ProviderError, type SetupCheck } from "./payment-providers/types.ts";
import { plaidCredentials } from "./plaid.ts";
import { type PlaidCredentials, PlaidError, plaidClient } from "./plaid-client.ts";
import { createStore } from "./storage.ts";
import { checkForUpdate } from "./updates.ts";

export type CheckStatus = "pass" | "warn" | "fail";

export interface Check {
  id: string;
  name: string;
  status: CheckStatus;
  message: string;
  remediation?: string;
}

export interface DoctorReport {
  status: CheckStatus;
  version: string;
  config_path: string;
  checks: Check[];
}

export interface DoctorOptions {
  configPath?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /** Chain links to verify at the head of each chain (0 = all). */
  chainTail?: number;
  /** Tests: an in-memory fake in place of a real bucket for the `backup_bucket` check. */
  bucket?: BackupBucket;
}

const MB = 1024 * 1024;

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const f = opts.fetchImpl ?? fetch;
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const report = (): DoctorReport => ({
    status: checks.some((c) => c.status === "fail")
      ? "fail"
      : checks.some((c) => c.status === "warn")
        ? "warn"
        : "pass",
    version: VERSION,
    config_path: loaded?.path ?? opts.configPath ?? "",
    checks,
  });

  // ---------------------------------------------------------------- config and master key
  let loaded: ReturnType<typeof loadConfig> | null = null;
  try {
    loaded = loadConfig(opts.configPath, env);
    if (loaded.exists) {
      accessSync(loaded.path, constants.R_OK);
      add({ id: "config", name: "Config file", status: "pass", message: loaded.path });
    } else if (env.COSIMO_MASTER_KEY) {
      add({
        id: "config",
        name: "Config file",
        status: "pass",
        message: "No file; using environment variables",
      });
    } else {
      add({
        id: "config",
        name: "Config file",
        status: "fail",
        message: `Not found: ${loaded.path}`,
        remediation: "Run `cosimo init`, or pass --config / set COSIMO_CONFIG to the config file.",
      });
      return report();
    }
  } catch (e) {
    add({
      id: "config",
      name: "Config file",
      status: "fail",
      message: `Unreadable: ${(e as Error).message}`,
      remediation: "Check the file's permissions and TOML syntax.",
    });
    return report();
  }
  const cfg = loaded.effective;

  try {
    if (!cfg.security.master_key) throw new Error("missing");
    new SecretBox(cfg.security.master_key);
    const where = loaded.file.security.master_key ? loaded.path : "COSIMO_MASTER_KEY";
    let status: CheckStatus = "pass";
    let message = `Present (${where})`;
    let remediation: string | undefined;
    if (loaded.exists && loaded.file.security.master_key && process.platform !== "win32") {
      const mode = statSync(loaded.path).mode & 0o777;
      if (mode & 0o077) {
        status = "warn";
        message = `Present, but ${loaded.path} is readable by other users (mode ${mode.toString(8)})`;
        remediation = `chmod 600 ${loaded.path}`;
      }
    }
    add({ id: "master_key", name: "Master key", status, message, remediation });
  } catch {
    add({
      id: "master_key",
      name: "Master key",
      status: "fail",
      message: "Missing or malformed",
      remediation:
        "Restore the config file or COSIMO_MASTER_KEY from your backup. Without it, stored secrets and bank connections cannot be decrypted.",
    });
    return report();
  }

  // ---------------------------------------------------------------- databases
  let ctx: AppContext;
  try {
    ctx = await createContext(cfg, { configPath: loaded.path, logger: silentLogger, migrate: false, env });
    await ctx.system.client.execute("select 1");
    add({ id: "system_db", name: "System database", status: "pass", message: "Reachable" });
  } catch (e) {
    add({
      id: "system_db",
      name: "System database",
      status: "fail",
      message: (e as Error).message,
      remediation:
        "Check database.system_url (and the token for Turso/libSQL) and that the data directory exists.",
    });
    return report();
  }

  try {
    await databaseChecks(ctx, add, opts.chainTail ?? 200);
    await serviceChecks(ctx, cfg, add, f, env, opts.bucket);
  } finally {
    await ctx.close();
  }
  return report();
}

async function databaseChecks(ctx: AppContext, add: (c: Check) => void, tail: number) {
  const pendingSystem = await pendingMigrations(ctx.system.client, systemMigrations);
  const orgs = await ctx.orgs.list();
  const unreachable: string[] = [];
  const pendingOrgs: string[] = [];
  const broken: string[] = [];
  const staleAnchors: string[] = [];
  for (const o of orgs) {
    try {
      const h = await ctx.orgs.mustOpen(o.id);
      await h.client.execute("select 1");
      if ((await pendingMigrations(h.client, orgMigrations)).length) {
        pendingOrgs.push(o.name);
        continue;
      }
      const v = await verifyOrg(h.db, o.id, tail ? { tail } : {});
      if (!v.ok) {
        const b = v.ledger.firstBreak ?? v.audit.firstBreak;
        const a = v.anchors.problems[0];
        broken.push(
          `${o.name}${b ? ` (${b.chain} seq ${b.seq}: ${b.reason})` : a ? ` (timestamp of ledger seq ${a.ledger_seq}: ${a.problem})` : ""}`,
        );
      }
      if (ctx.config.anchoring.enabled) {
        const late = await staleAnchoring(h.db);
        if (late) staleAnchors.push(`${o.name}: ${late}`);
      }
    } catch (e) {
      unreachable.push(`${o.name}: ${(e as Error).message}`);
    }
  }
  add(
    unreachable.length
      ? {
          id: "org_dbs",
          name: "Organization databases",
          status: "fail",
          message: unreachable.join("; "),
          remediation: "Check the database files or the Turso/libSQL connection for these organizations.",
        }
      : {
          id: "org_dbs",
          name: "Organization databases",
          status: "pass",
          message: `${orgs.length} reachable`,
        },
  );
  add(
    pendingSystem.length || pendingOrgs.length
      ? {
          id: "migrations",
          name: "Migrations",
          status: "warn",
          message: `Pending: ${[pendingSystem.length ? `system (${pendingSystem.length})` : "", ...pendingOrgs].filter(Boolean).join(", ")}`,
          remediation:
            "Start the server once (`cosimo serve`) or run `cosimo upgrade`; migrations apply automatically.",
        }
      : { id: "migrations", name: "Migrations", status: "pass", message: "Current" },
  );
  add(
    broken.length
      ? {
          id: "chains",
          name: "Ledger and audit chains",
          status: "fail",
          message: `Broken: ${broken.join("; ")}`,
          remediation:
            "Run `cosimo verify <org> --json` for details. The books were changed outside Cosimo; restore from a backup if that was not expected.",
        }
      : {
          id: "chains",
          name: "Ledger and audit chains",
          status: "pass",
          message: tail ? `Last ${tail} links intact in ${orgs.length} org(s)` : "Intact",
        },
  );
  if (ctx.config.anchoring.enabled)
    add(
      staleAnchors.length
        ? {
            id: "anchors",
            name: "Public timestamps",
            status: "warn",
            message: staleAnchors.join("; "),
            remediation:
              "Check that the server can reach the hosts in [anchoring] (ots_calendars, tsa_url, bitcoin_api) over HTTPS, then run `cosimo anchor <org>`. See docs/deployment.md.",
          }
        : { id: "anchors", name: "Public timestamps", status: "pass", message: "Up to date" },
    );
}

const ANCHOR_STALE_MS = 3 * 24 * 3_600_000;

/**
 * Why the ledger isn't publicly timestamped when it should be: an entry posted more than 3 days
 * ago that no complete anchor covers. Null when timestamps are up to date.
 */
async function staleAnchoring(db: OrgDb): Promise<string | null> {
  const last = await db
    .select()
    .from(orgSchema.chainAnchors)
    .where(eq(orgSchema.chainAnchors.status, "complete"))
    .orderBy(desc(orgSchema.chainAnchors.ledgerSeq))
    .limit(1)
    .get();
  const first = await db
    .select({ seq: orgSchema.journalEntries.chainSeq, postedAt: orgSchema.journalEntries.postedAt })
    .from(orgSchema.journalEntries)
    .where(gt(orgSchema.journalEntries.chainSeq, last?.ledgerSeq ?? 0))
    .orderBy(asc(orgSchema.journalEntries.chainSeq))
    .limit(1)
    .get();
  if (!first?.postedAt || Date.now() - Date.parse(first.postedAt) < ANCHOR_STALE_MS) return null;
  const failure = await db
    .select({ service: orgSchema.chainAnchors.service, lastError: orgSchema.chainAnchors.lastError })
    .from(orgSchema.chainAnchors)
    .where(isNotNull(orgSchema.chainAnchors.lastError))
    .orderBy(desc(orgSchema.chainAnchors.updatedAt))
    .limit(1)
    .get();
  const since = last ? `timestamped only through ledger #${last.ledgerSeq}` : "never timestamped";
  return `${since}, and ledger #${first.seq} was posted ${first.postedAt.slice(0, 10)}${failure ? ` (last error from ${failure.service}: ${failure.lastError})` : ""}`;
}

async function serviceChecks(
  ctx: AppContext,
  cfg: Config,
  add: (c: Check) => void,
  f: typeof fetch,
  env: Record<string, string | undefined>,
  bucket?: BackupBucket,
) {
  // ---------------------------------------------------------------- server and TLS
  const localUrl = `http://${cfg.server.host === "0.0.0.0" ? "127.0.0.1" : cfg.server.host}:${cfg.server.port}`;
  const publicUrl = cfg.server.public_url.replace(/\/+$/, "");
  const ping = async (url: string) => {
    try {
      const r = await f(`${url}/healthz`, { signal: AbortSignal.timeout(4000) });
      return r.ok ? null : `HTTP ${r.status}`;
    } catch (e) {
      return (e as Error).message;
    }
  };
  const server = cfg.instance.target !== "local";
  const localErr = await ping(localUrl);
  add(
    !localErr
      ? { id: "server", name: "Server", status: "pass", message: `Responding at ${localUrl}` }
      : {
          id: "server",
          name: "Server",
          status: server ? "fail" : "warn",
          message: `Not responding at ${localUrl} (${localErr})`,
          remediation: server
            ? "Check the container or machine logs (`docker compose logs cosimo` / `fly logs`)."
            : "Start it with `cosimo serve` (or check the background service).",
        },
  );
  if (publicUrl.startsWith("https://")) {
    const pubErr = await ping(publicUrl);
    const tlsProblem = pubErr && /certificate|tls|ssl|self.signed|unable to verify/i.test(pubErr);
    add(
      tlsProblem
        ? {
            id: "tls",
            name: "HTTPS certificate",
            status: "fail",
            message: pubErr!,
            remediation:
              "Make sure DNS points to this server and ports 80/443 are open so Caddy can get a certificate.",
          }
        : pubErr
          ? {
              id: "tls",
              name: "HTTPS certificate",
              status: "warn",
              message: `${publicUrl} is not reachable from here (${pubErr})`,
              remediation:
                "Run doctor from outside the container, or check DNS, the firewall (ports 80/443), and the Caddy logs.",
            }
          : { id: "tls", name: "HTTPS certificate", status: "pass", message: `Valid for ${publicUrl}` },
    );
  } else if (server) {
    add({
      id: "tls",
      name: "HTTPS certificate",
      status: "warn",
      message: `Public URL is not HTTPS: ${publicUrl}`,
      remediation: "Set server.public_url to the https:// address.",
    });
  }

  // ---------------------------------------------------------------- Plaid and SMTP
  const keySets: { label: string; creds: PlaidCredentials }[] = [];
  const p = await ctx.settings.get("plaid");
  if (p.enabled && p.client_id && p.secret)
    keySets.push({ label: "instance", creds: { env: p.env, clientId: p.client_id, secret: p.secret } });
  for (const o of await ctx.orgs.list()) {
    try {
      const h = await ctx.orgs.mustOpen(o.id);
      const c = await plaidCredentials(ctx, h.db);
      if (c?.source === "org") keySets.push({ label: o.name, creds: c });
    } catch {
      // reported by the database checks
    }
  }
  for (const k of keySets) {
    const name = keySets.length > 1 ? `Plaid credentials (${k.label})` : "Plaid credentials";
    try {
      await plaidClient(k.creds).checkCredentials();
      add({ id: "plaid", name, status: "pass", message: `Valid (${k.creds.env})` });
    } catch (e) {
      const bad = e instanceof PlaidError && e.status >= 400 && e.status < 500;
      add({
        id: "plaid",
        name,
        status: bad ? "fail" : "warn",
        message: e instanceof PlaidError ? `${e.code}: ${e.message}` : (e as Error).message,
        remediation: bad
          ? "Check the client ID, secret, and environment (secrets differ between Sandbox and Production)."
          : "Plaid could not be reached; check outbound HTTPS.",
      });
    }
  }
  // ---------------------------------------------------------------- online payments (Stripe)
  const stripeOrgs: {
    id: string;
    name: string;
    secrets: ReturnType<typeof stripeSecrets>;
    opts: StripeOptions;
    lastEvent: string | null;
    payError: Awaited<ReturnType<typeof lastPayError>>;
    staleEvents: number;
  }[] = [];
  const payErrorSince = new Date(Date.now() - 30 * 86_400_000).toISOString();
  for (const o of await ctx.orgs.list()) {
    try {
      const h = await ctx.orgs.mustOpen(o.id);
      const st = await settingsRow(h.db);
      if (st.paymentProvider !== "stripe") continue;
      const last = await h.db
        .select({ at: orgSchema.providerEvents.receivedAt })
        .from(orgSchema.providerEvents)
        .orderBy(desc(orgSchema.providerEvents.receivedAt))
        .limit(1)
        .get();
      const failed = await lastPayError(h.db);
      stripeOrgs.push({
        id: o.id,
        name: o.name,
        secrets: stripeSecrets(ctx.secrets, st),
        opts: stripeOptions(st),
        lastEvent: last?.at ?? null,
        payError: failed?.payErrorAt && failed.payErrorAt >= payErrorSince ? failed : null,
        staleEvents: await staleUnhandledEvents(h.db),
      });
    } catch {
      // reported by the database checks
    }
  }
  for (const o of stripeOrgs) {
    const name = stripeOrgs.length > 1 ? `Stripe (${o.name})` : "Stripe";
    if (!o.secrets) {
      add({
        id: "stripe",
        name,
        status: "fail",
        message: "Online payments are set to Stripe but no key is stored",
        remediation: "An owner can add the key under Settings → Online payments.",
      });
      continue;
    }
    const live = /^(sk|rk)_live_/.test(o.secrets.secret_key);
    try {
      await stripeClient({ secretKey: o.secrets.secret_key }, f).testConnection();
    } catch (e) {
      const bad = e instanceof ProviderError && e.status >= 400 && e.status < 500;
      add({
        id: "stripe",
        name,
        status: bad ? "fail" : "warn",
        message: (e as Error).message,
        remediation: bad
          ? "Create a new restricted key in the Stripe dashboard and enter it under Settings → Online payments."
          : "Stripe could not be reached; check outbound HTTPS.",
      });
      continue;
    }
    // What the key can't do, methods Stripe won't take, events the endpoint lacks, recent failures.
    const url = paymentWebhookUrl(ctx, o.id);
    let check: SetupCheck | null = null;
    try {
      check = await stripeClient({ secretKey: o.secrets.secret_key }, f).checkSetup(o.opts.methods, url);
    } catch {
      // each probe reports its own failure; nothing more to say here
    }
    const problems: string[] = [];
    const setup = check ? setupWarning(summarizeSetup(check, o.secrets, url)) : null;
    if (setup) problems.push(setup);
    if (
      o.secrets.webhook_endpoint_id &&
      o.opts.webhook_events_version < WEBHOOK_EVENTS_VERSION &&
      !check?.missingEvents?.length
    )
      problems.push(
        "The webhook endpoint Cosimo registered hasn't been updated with the newer events (charge.updated and the dispute events) yet; the payment check retries it, which needs Webhook Endpoints: Write.",
      );
    if (o.staleEvents)
      problems.push(
        `${o.staleEvents} refund, dispute, or payout event(s) arrived before Cosimo handled them and are too old to fetch from Stripe again; check the Stripe dashboard for refunds and disputes from then and book them by hand.`,
      );
    if (o.payError)
      problems.push(
        `A pay link failed ${o.payError.payErrorAt} (invoice ${o.payError.number}): ${o.payError.payError}`,
      );
    const mode = live ? "live mode" : "test mode";
    const hook = o.secrets.webhook_endpoint_id
      ? "webhook registered"
      : o.secrets.webhook_secret
        ? "webhook secret entered by hand"
        : "no webhook, polling every 15 minutes";
    const last = o.lastEvent ? `last event ${o.lastEvent}` : "no events yet";
    if (live && !publicUrl.startsWith("https://")) {
      add({
        id: "stripe",
        name,
        status: "warn",
        message: `Key valid (${mode}, ${hook}) but the public URL is not HTTPS: ${publicUrl}`,
        remediation:
          "Customers pay through pay links on the public URL; set server.public_url to the https:// address.",
      });
    } else if (problems.length) {
      add({
        id: "stripe",
        name,
        status: "warn",
        message: `Key valid (${mode}, ${hook}, ${last}). ${problems.join(" ")}`,
        remediation:
          "Fix the key's permissions and payment methods in the Stripe dashboard, then use Test connection under Settings → Online payments. The invoice shows why its pay link failed.",
      });
    } else {
      add({ id: "stripe", name, status: "pass", message: `Key valid (${mode}, ${hook}, ${last})` });
    }
  }

  const mailer = ctx.services.mailer as Mailer | undefined;
  const smtp = await ctx.settings.get("smtp");
  if (smtp.enabled && mailer) {
    try {
      await mailer.verify();
      add({ id: "smtp", name: "Email (SMTP)", status: "pass", message: `${smtp.host}:${smtp.port}` });
    } catch (e) {
      add({
        id: "smtp",
        name: "Email (SMTP)",
        status: "fail",
        message: (e as Error).message,
        remediation:
          "Check the SMTP host, port, user, and password in Admin → Settings, then send a test email.",
      });
    }
  }

  // ---------------------------------------------------------------- storage, backups, disk
  try {
    const store = createStore(cfg, (v) => ctx.secrets.reveal(v));
    const key = `doctor/probe-${Date.now()}`;
    await store.put(key, new TextEncoder().encode("ok"), "text/plain");
    const back = await store.get(key);
    await store.delete(key);
    if (!back) throw new Error("wrote a probe file but could not read it back");
    add({ id: "storage", name: "Attachment storage", status: "pass", message: `Writable (${store.kind})` });
  } catch (e) {
    add({
      id: "storage",
      name: "Attachment storage",
      status: "fail",
      message: (e as Error).message,
      remediation:
        cfg.storage.kind === "s3"
          ? "Check the S3 endpoint, bucket, region, and keys."
          : `Make sure ${cfg.storage.dir} exists and is writable by the Cosimo user.`,
    });
  }

  if (cfg.backups.mode === "off") {
    add({
      id: "backups",
      name: "Backups",
      status: "warn",
      message: "Automatic backups are off",
      remediation: "Turn them on with `cosimo config set backups.mode local` (or s3).",
    });
  } else {
    // In s3 mode, `newestBackup` can't see the bucket; go by the last recorded backup instead.
    const newest = cfg.backups.mode === "s3" ? await lastBackupAt(ctx) : newestBackup(cfg.backups.dir);
    const ageH = newest ? (Date.now() - newest) / 3_600_000 : null;
    add(
      ageH !== null && ageH < 36
        ? { id: "backups", name: "Backups", status: "pass", message: `Last backup ${Math.round(ageH)} h ago` }
        : {
            id: "backups",
            name: "Backups",
            status: "warn",
            message: ageH === null ? "No backup yet" : `Last backup ${Math.round(ageH / 24)} day(s) ago`,
            remediation:
              "Run `cosimo backup` now and make sure the server is running so the daily backup job runs.",
          },
    );
  }
  if (cfg.backups.mode === "s3") await backupBucketCheck(ctx, cfg, add, bucket);

  try {
    const s = statfsSync(existsSync(cfg.database.data_dir) ? cfg.database.data_dir : ".");
    const free = s.bavail * s.bsize;
    const freeMb = Math.round(free / MB);
    add(
      free < 200 * MB
        ? {
            id: "disk",
            name: "Disk space",
            status: "fail",
            message: `${freeMb} MB free`,
            remediation: "Free up space or move the data directory; writes fail when the disk is full.",
          }
        : free < 1024 * MB
          ? {
              id: "disk",
              name: "Disk space",
              status: "warn",
              message: `${freeMb} MB free`,
              remediation: "Free up space soon.",
            }
          : {
              id: "disk",
              name: "Disk space",
              status: "pass",
              message: `${(free / 1024 / MB).toFixed(1)} GB free`,
            },
    );
  } catch (e) {
    add({
      id: "disk",
      name: "Disk space",
      status: "warn",
      message: `Could not check: ${(e as Error).message}`,
    });
  }

  // ---------------------------------------------------------------- updates
  const upd = await checkForUpdate(ctx, { fetch: f, env, now: () => Date.now(), current: VERSION });
  add(
    upd.status === "available"
      ? {
          id: "updates",
          name: "Updates",
          status: "warn",
          message: `v${upd.latest?.version} is available (running ${upd.current})`,
          remediation: "See Admin → Updates in the web UI, or `cosimo upgrade`.",
        }
      : upd.status === "unknown"
        ? { id: "updates", name: "Updates", status: "warn", message: upd.error ?? "Could not check" }
        : {
            id: "updates",
            name: "Updates",
            status: "pass",
            message:
              upd.status === "dev"
                ? "Development build"
                : upd.status === "disabled"
                  ? "Check is off"
                  : "Up to date",
          },
  );
}

function newestBackup(dir: string): number | null {
  if (!existsSync(dir)) return null;
  let newest: number | null = null;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs;
    }
  };
  walk(dir);
  return newest;
}

async function lastBackupAt(ctx: AppContext): Promise<number | null> {
  const last = await ctx.settings.get("last_backup");
  return last ? new Date(last.at).getTime() : null;
}

/**
 * Probe what backup retention actually needs from the bucket: write, list (ListObjectsV2, where
 * providers differ most), and delete. Only run in s3 mode.
 */
async function backupBucketCheck(
  ctx: AppContext,
  cfg: Config,
  add: (c: Check) => void,
  bucketOverride?: BackupBucket,
) {
  const bucket = bucketOverride ?? backupBucket(cfg, (v) => ctx.secrets.reveal(v));
  const key = `doctor/probe-${Date.now()}`;
  const fail = (message: string, remediation: string) =>
    add({ id: "backup_bucket", name: "Backup bucket", status: "fail", message, remediation });
  try {
    await bucket.write(key, new Blob([new TextEncoder().encode("ok")]));
  } catch (e) {
    fail(
      `Could not write to the bucket: ${(e as Error).message}`,
      "Check the S3 endpoint, bucket, region, and keys. See docs/object-storage.md.",
    );
    return;
  }
  let rows: BucketObject[];
  try {
    rows = await bucket.list("doctor/");
  } catch (e) {
    fail(
      `Could not list the bucket: ${(e as Error).message}`,
      "The bucket must support ListObjectsV2, which backup retention depends on. See docs/object-storage.md.",
    );
    return;
  }
  if (!rows.some((o) => o.key === key)) {
    fail("Wrote a probe file, but it did not appear in a list of doctor/.", "See docs/object-storage.md.");
    return;
  }
  try {
    await bucket.delete(key);
  } catch (e) {
    fail(
      `Could not delete the probe file: ${(e as Error).message}`,
      "The bucket may have a retention lock; backup retention will not be able to prune. See docs/object-storage.md.",
    );
    return;
  }
  add({
    id: "backup_bucket",
    name: "Backup bucket",
    status: "pass",
    message: "Writable, listable, and deletable",
  });
}
