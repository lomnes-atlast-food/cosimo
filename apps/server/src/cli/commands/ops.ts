/** Operations commands (SPEC §13.8, §14): backup, restore, export, import. */
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { system } from "@cosimo/db";
import { eq } from "drizzle-orm";
import { loadConfig } from "../../config.ts";
import type { AppContext } from "../../context.ts";
import { systemActor } from "../../services/actor.ts";
import {
  createBackup,
  downloadBackup,
  listBackups,
  NAME_RE,
  RestoreError,
  restoreBackup,
} from "../../services/backup.ts";
import { exportOrg, importOrgArchive } from "../../services/export.ts";
import {
  commitProductImport,
  type ProductImportReport,
  parseProductFiles,
  previewProductImport,
} from "../../services/product-import.ts";
import { approveReviewTx } from "../../services/review.ts";
import { defaultDeps, migrateAll, UpgradeError, upgrade } from "../../services/upgrade.ts";
import { CliError, emit, parse, progress, withContext } from "../util.ts";

export async function backupCommand(argv: string[]) {
  const { values, positionals } = parse(argv, { out: { type: "string", short: "o" } });
  if (values.help) {
    process.stdout.write(
      "cosimo backup [list|download <name> [-o path]]\n  Create a backup now (databases, config without secrets, attachments), list backups, or download one from the bucket.\n",
    );
    return;
  }
  await withContext(values, async (ctx) => {
    if (positionals[0] === "list") {
      const rows = await listBackups(ctx.config, { reveal: (v) => ctx.secrets.reveal(v) });
      emit(Boolean(values.json), rows, () => {
        for (const r of rows)
          process.stdout.write(`${r.created_at}  ${Math.round(r.bytes / 1024)} KB  ${r.file}\n`);
        if (!rows.length)
          process.stdout.write(
            ctx.config.backups.mode === "s3"
              ? `(no backups in the bucket ${ctx.config.storage.s3_bucket})\n`
              : `(no backups in ${ctx.config.backups.dir})\n`,
          );
      });
      return;
    }
    if (positionals[0] === "download") {
      const name = positionals[1];
      if (!name) throw new CliError("A backup name is required", 2, "missing_argument");
      try {
        const r = await downloadBackup(ctx.config, name, values.out as string | undefined, {
          reveal: (v) => ctx.secrets.reveal(v),
        });
        emit(Boolean(values.json), r, () => process.stdout.write(`Downloaded to ${r.file}\n`));
      } catch (e) {
        if (e instanceof RestoreError)
          throw new CliError(e.message, e.code === "invalid_name" ? 2 : 1, e.code);
        throw e;
      }
      return;
    }
    progress("Creating backup");
    const r = await createBackup(ctx, { reason: "manual" });
    emit(Boolean(values.json), r, () => {
      process.stdout.write(
        `Backup written: ${r.file} (${Math.round(r.bytes / 1024)} KB, ${r.orgs} org(s))\n`,
      );
      if (r.secrets_omitted)
        process.stdout.write(
          "Secrets are not in the backup. Keep your config file (master key) backed up separately.\n",
        );
      if (r.deleted.length)
        process.stdout.write(`Removed ${r.deleted.length} old backup(s) per retention.\n`);
      for (const w of r.warnings) process.stdout.write(`! ${w}\n`);
    });
  });
}

export async function restoreCommand(argv: string[]) {
  const { values, positionals } = parse(argv, { yes: { type: "boolean", short: "y", default: false } });
  const file = positionals[0];
  if (values.help || !file) {
    process.stdout.write(
      "cosimo restore <backup.zip> [--yes]\n  Restore into this (stopped) instance. Current data is moved aside, not deleted.\n",
    );
    if (!file && !values.help) throw new CliError("A backup file is required", 2, "missing_argument");
    return;
  }
  const loaded = loadConfig(values.config);
  if (!loaded.exists && !process.env.COSIMO_MASTER_KEY)
    throw new CliError(
      `No instance config at ${loaded.path}. Run \`cosimo init\` first (with the same master key) or pass --config.`,
      1,
      "no_instance",
    );
  if (!values.yes && !values.json && process.stdin.isTTY) {
    const { confirm, isCancel } = await import("@clack/prompts");
    const ok = await confirm({
      message: `Restore ${file}? The current databases are moved to a data.before-restore folder.`,
    });
    if (isCancel(ok) || !ok) return;
  }
  try {
    // A bare backup name that isn't in the working directory is looked up in backups.dir, where
    // `cosimo backup download` puts it.
    const inBackupsDir = resolve(loaded.effective.backups.dir, file);
    const path =
      NAME_RE.test(file) && !existsSync(resolve(file)) && existsSync(inBackupsDir)
        ? inBackupsDir
        : resolve(file);
    const r = await restoreBackup(loaded.effective, path);
    emit(Boolean(values.json), r, () => {
      process.stdout.write(`Restored ${r.backup} (taken ${r.created_at})\n`);
      for (const o of r.orgs)
        process.stdout.write(
          `  ${o.chains_ok && o.integrity === "ok" ? "OK  " : "FAIL"} ${o.name} (${o.id})\n`,
        );
      if (r.previous_data) process.stdout.write(`Previous data kept in ${r.previous_data}\n`);
      for (const w of r.warnings) process.stdout.write(`! ${w}\n`);
    });
    if (r.orgs.some((o) => !o.chains_ok || o.integrity !== "ok"))
      throw new CliError("Some organizations did not verify after restore", 6, "verification_failed");
  } catch (e) {
    if (e instanceof RestoreError) {
      const bare = !/[/\\]/.test(file) && NAME_RE.test(file);
      const message =
        e.code === "not_found" && bare
          ? `${e.message} If it's in your bucket, run \`cosimo backup download ${file}\` first.`
          : e.message;
      throw new CliError(message, e.code === "server_running" ? 3 : 1, e.code);
    }
    throw e;
  }
}

export async function exportCommand(argv: string[]) {
  const { values, positionals } = parse(argv, { out: { type: "string", short: "o" } });
  const id = positionals[0];
  if (values.help || !id) {
    process.stdout.write(
      "cosimo export <org_id> [--out file.zip]\n  Export one organization to the open format (docs/export-format.md). Secrets are omitted.\n",
    );
    if (!id && !values.help) throw new CliError("An org id is required", 2, "missing_argument");
    return;
  }
  await withContext(values, async (ctx) => {
    const reg = await ctx.orgs.get(id);
    if (!reg) throw new CliError(`Unknown org ${id}`, 1, "not_found");
    const out = resolve(
      (values.out as string | undefined) ??
        `${reg.name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || id}-${new Date().toISOString().slice(0, 10)}.zip`,
    );
    const m = await exportOrg(ctx, id, out);
    emit(Boolean(values.json), { file: out, manifest: m }, () => {
      const rows = Object.values(m.tables).reduce((s, t) => s + t.rows, 0);
      process.stdout.write(
        `Exported ${reg.name} to ${out} (${rows} rows, ledger head #${m.chain_heads.ledger.seq})\n`,
      );
    });
  });
}

async function resolveOwner(ctx: AppContext, email?: string) {
  if (email) {
    const u = await ctx.users.byEmail(email);
    if (!u) throw new CliError(`No user ${email}`, 1, "not_found");
    return u.id;
  }
  const admin = await ctx.system.db
    .select({ id: system.users.id })
    .from(system.users)
    .where(eq(system.users.isInstanceAdmin, true))
    .get();
  if (!admin)
    throw new CliError(
      "No instance admin to own the imported organization; pass --user <email>.",
      2,
      "missing_argument",
    );
  return admin.id;
}

export async function importCommand(argv: string[]) {
  const { values, positionals } = parse(argv, {
    user: { type: "string" },
    name: { type: "string" },
    org: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    source: { type: "string" },
    approve: { type: "boolean", default: false },
    yes: { type: "boolean", short: "y", default: false },
  });
  if (values.help || !positionals.length) {
    process.stdout.write(`cosimo import <export.zip> [--user <email>] [--name <new name>]
  Import an organization from a Cosimo open-format export (keeps its ID and verifies its chains).

cosimo import <files.csv...> --org <org_id> [--dry-run] [--source qbo|xero|wave] [--approve]
  Import accounts, contacts, and history from QuickBooks Online, Xero, or Wave CSV exports
  into an organization (see docs/importing.md). Shows a dry-run report first. The entries wait
  in the review queue as one batch; --approve posts them right away.
`);
    if (!positionals.length && !values.help) throw new CliError("A file is required", 2, "missing_argument");
    return;
  }
  for (const f of positionals) if (!existsSync(f)) throw new CliError(`File not found: ${f}`, 2, "not_found");
  await withContext(values, async (ctx) => {
    if (positionals.length === 1 && positionals[0]!.toLowerCase().endsWith(".zip")) {
      const userId = await resolveOwner(ctx, values.user as string | undefined);
      const r = await importOrgArchive(ctx, new Uint8Array(readFileSync(positionals[0]!)), {
        userId,
        name: values.name as string | undefined,
      }).catch((e: Error & { code?: string }) => {
        throw new CliError(e.message, e.code === "org_exists" ? 5 : 1, e.code ?? "import_failed");
      });
      emit(Boolean(values.json), r, () => {
        process.stdout.write(`Imported ${r.name} (${r.org_id}); chains verified.\n`);
        if (r.members_skipped.length)
          process.stdout.write(
            `Members without an account here were skipped: ${r.members_skipped.join(", ")}\n`,
          );
      });
      return;
    }
    await productImportCli(ctx, positionals, values);
  });
}

export async function migrateCommand(argv: string[]) {
  const { values } = parse(argv);
  await withContext(
    values,
    async (ctx) => {
      try {
        const r = await migrateAll(ctx);
        emit(Boolean(values.json), { status: "ok", ...r }, () => {
          const n = r.system.length + r.orgs.reduce((s, o) => s + o.applied.length, 0);
          process.stdout.write(n ? `Applied ${n} migration(s).\n` : "Everything is up to date.\n");
        });
      } catch (e) {
        if (e instanceof UpgradeError) throw new CliError(e.message, e.exitCode, e.code);
        throw e;
      }
    },
    { migrate: false },
  );
}

export async function upgradeCommand(argv: string[]) {
  const { values } = parse(argv, {
    check: { type: "boolean", default: false },
    version: { type: "string" },
  });
  if (values.help) {
    process.stdout.write(`cosimo upgrade [--check] [--version X.Y.Z]
  Download the latest release, verify its checksum, back up, replace this binary, migrate, and
  restart the background service. Docker and Fly instances print how to pull the new image.
`);
    return;
  }
  await withContext(
    values,
    async (ctx) => {
      try {
        const r = await upgrade(ctx, defaultDeps(progress), {
          check: Boolean(values.check),
          version: values.version as string | undefined,
        });
        emit(Boolean(values.json), r, () => {
          if (r.status === "up_to_date") process.stdout.write(`Cosimo ${r.current} is the latest version.\n`);
          else if (r.status === "available")
            process.stdout.write(
              `Cosimo ${r.latest} is available (you have ${r.current}). Run \`cosimo upgrade\`.\n`,
            );
          else if (r.status === "manual")
            process.stdout.write(
              `Cosimo ${r.latest} is available.\n${(r.instructions ?? []).map((s) => `  ${s}`).join("\n")}\n`,
            );
          else
            process.stdout.write(
              `Upgraded ${r.current} → ${r.latest}. ${r.restarted ? `The ${r.restarted}.` : "Restart `cosimo serve` to use it."}\n`,
            );
        });
      } catch (e) {
        if (e instanceof UpgradeError) throw new CliError(e.message, e.exitCode, e.code);
        throw e;
      }
    },
    { migrate: false },
  );
}

const money = (c: number) => (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });

function printReport(r: ProductImportReport) {
  const out = (l: string) => process.stdout.write(`${l}\n`);
  const names = { qbo: "QuickBooks Online", xero: "Xero", wave: "Wave" } as const;
  out(`Source: ${names[r.source]}`);
  for (const f of r.files) out(`  ${f.name}: ${f.kind}, ${f.rows} rows`);
  if (r.date_range) out(`Dates: ${r.date_range.from} to ${r.date_range.to}`);
  out(`Accounts: ${r.accounts.create} to create, ${r.accounts.match} matched`);
  for (const a of r.accounts.items.filter((x) => x.action === "create"))
    out(`  + ${a.code} ${a.name} (${a.type}/${a.subtype})${a.synthesized ? " [type guessed]" : ""}`);
  out(`Contacts: ${r.contacts.create} to create, ${r.contacts.match} matched`);
  out(
    `Entries: ${r.entries.new} new, ${r.entries.already_imported} already imported (debits ${money(r.entries.total_debits)})`,
  );
  for (const e of r.errors) out(`  ERROR ${e.file}${e.row ? `:${e.row}` : ""} ${e.message}`);
  for (const w of r.warnings) out(`  warn  ${w.file}${w.row ? `:${w.row}` : ""} ${w.message}`);
}

async function productImportCli(ctx: AppContext, files: string[], values: Record<string, unknown>) {
  const orgId = values.org as string | undefined;
  if (!orgId) throw new CliError("--org <org_id> is required for CSV imports", 2, "missing_argument");
  const handle = await ctx.orgs.open(orgId);
  if (!handle) throw new CliError(`Unknown org ${orgId}`, 1, "not_found");
  const source = values.source as "qbo" | "xero" | "wave" | undefined;
  if (source && !["qbo", "xero", "wave"].includes(source))
    throw new CliError("--source must be qbo, xero, or wave", 2, "invalid_argument");
  const bundle = parseProductFiles(
    files.map((f) => ({ name: basename(f), content: readFileSync(f, "utf8") })),
    source,
  );
  const report = await previewProductImport(handle.db, bundle);
  const json = Boolean(values.json);
  if (values["dry-run"] || !report.can_commit) {
    emit(json, { ...report, committed: false }, () => {
      printReport(report);
      if (!report.can_commit) process.stdout.write("Nothing to import.\n");
    });
    if (!report.can_commit && report.errors.some((e) => e.message.includes("locked period")))
      throw new CliError("Some entries fall in a locked period", 1, "locked_period");
    return;
  }
  if (!json) printReport(report);
  if (!values.yes && !json && process.stdin.isTTY) {
    const { confirm, isCancel } = await import("@clack/prompts");
    const ok = await confirm({ message: `Import into ${orgId}? Entries post immediately.` });
    if (isCancel(ok) || !ok) return;
  } else if (!values.yes) {
    throw new CliError(
      "Pass --yes to import without a prompt (or --dry-run to preview)",
      2,
      "confirmation_required",
    );
  }
  const actor = systemActor();
  const r = await commitProductImport(handle, orgId, actor, bundle);
  let approved = false;
  if (values.approve && r.review_item_id) {
    const id = r.review_item_id;
    await handle.write((tx) =>
      approveReviewTx(tx, orgId, actor, id, { note: "Approved with cosimo import --approve" }),
    );
    approved = true;
  }
  emit(json, { ...r, approved }, () => {
    process.stdout.write(
      `Imported ${r.created.accounts} account(s), ${r.created.contacts} contact(s), ${r.created.entries} entr${r.created.entries === 1 ? "y" : "ies"}.\n`,
    );
    if (r.review_item_id)
      process.stdout.write(
        approved
          ? "The entries are posted.\n"
          : `The entries wait in Review as one batch (${r.review_item_id}). Approve it there to post them.\n`,
      );
  });
}
