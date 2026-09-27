import { migrateSystem, orgMigrations, pendingMigrations, systemMigrations } from "@cosimo/db";
import type { AppContext } from "../../context.ts";
import { startServer } from "../../server.ts";
import { type BackupResult, createBackup } from "../../services/backup.ts";
import { parse, progress, withContext } from "../util.ts";

/** `openUrl` opens that page (e.g. a claim link) once the server is listening. */
export async function serveCommand(argv: string[], opts: { openUrl?: string } = {}) {
  const { values } = parse(argv, {
    port: { type: "string" },
    host: { type: "string" },
    open: { type: "boolean", default: false },
  });
  await withContext(
    values,
    async (ctx) => {
      if (ctx.config.backups.mode !== "off" && (await hasPendingMigrations(ctx))) {
        progress("Database migrations are pending; backing up first");
        let b: BackupResult;
        try {
          b = await createBackup(ctx, { reason: "pre-migration" });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          throw new Error(
            `Pre-migration backup failed, so migrations were not applied: ${message}. Fix the backup ` +
              `(see cosimo doctor), or set backups.mode off to skip it.`,
            { cause: e },
          );
        }
        progress(`Backup written: ${b.file}`);
      }
      await migrateSystem(ctx.system.client);
      await ctx.orgs.migrateAll();
      const srv = startServer(ctx, {
        port: values.port ? Number(values.port) : undefined,
        host: values.host as string | undefined,
      });
      progress(`Cosimo ${ctx.version} listening on ${ctx.config.server.public_url} (bound ${srv.url})`);
      if (values.open || opts.openUrl) {
        const opener =
          process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        Bun.spawn([opener, opts.openUrl ?? ctx.config.server.public_url], {
          stdout: "ignore",
          stderr: "ignore",
        });
      }
      await new Promise<void>((resolve) => {
        const shutdown = async () => {
          progress("Shutting down...");
          await srv.stop();
          resolve();
        };
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      });
    },
    // Migrations run below, after a pre-migration backup.
    { verbose: true, migrate: false },
  );
}

/** True when an existing instance has migrations to apply. A brand-new instance has nothing to back up. */
export async function hasPendingMigrations(ctx: AppContext) {
  const system = await pendingMigrations(ctx.system.client, systemMigrations);
  if (system.length === systemMigrations.length) return false;
  if (system.length) return true;
  for (const o of await ctx.orgs.list({ includeArchived: true })) {
    const h = await ctx.orgs.mustOpen(o.id);
    if ((await pendingMigrations(h.client, orgMigrations)).length) return true;
  }
  return false;
}
