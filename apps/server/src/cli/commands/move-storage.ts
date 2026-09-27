import { resolve } from "node:path";
import { loadConfig } from "../../config.ts";
import { MoveStorageError, moveStorage } from "../../services/move-storage.ts";
import { CliError, emit, parse, progress } from "../util.ts";

const USAGE = `cosimo move-storage --to turso|libsql --env-out <file> [--system-name cosimo-system] [--yes]
  Copy this stopped SQLite instance (system DB and every org, archived ones included) to Turso or
  a libSQL server, verify it, and write the settings to run against it to --env-out (mode 0600).
  Local data and config are not changed. Attachments are not moved; upload them separately.

  turso:   --turso-org <org> [--turso-group default]   API token from TURSO_API_TOKEN
  libsql:  --libsql-admin-url <url> --libsql-base-url <url>   admin token from LIBSQL_ADMIN_TOKEN`;

export async function moveStorageCommand(argv: string[]) {
  const { values } = parse(argv, {
    to: { type: "string" },
    "turso-org": { type: "string" },
    "turso-group": { type: "string", default: "default" },
    "libsql-admin-url": { type: "string" },
    "libsql-base-url": { type: "string" },
    "system-name": { type: "string", default: "cosimo-system" },
    "env-out": { type: "string" },
    yes: { type: "boolean", short: "y", default: false },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const to = values.to as string | undefined;
  if (to !== "turso" && to !== "libsql")
    throw new CliError("--to must be turso or libsql", 2, "invalid_argument");
  const envOut = values["env-out"] as string | undefined;
  if (!envOut)
    throw new CliError(
      "--env-out <file> is required: it receives the database URL, tokens, and master key",
      2,
      "missing_argument",
    );
  const loaded = loadConfig(values.config);
  if (!loaded.exists && !process.env.COSIMO_MASTER_KEY)
    throw new CliError(`No instance config at ${loaded.path}. Pass --config.`, 1, "no_instance");
  if (!values.yes && !values.json && process.stdin.isTTY) {
    const { confirm, isCancel } = await import("@clack/prompts");
    const ok = await confirm({
      message: `Copy this instance's databases to ${to}? Local data is not changed.`,
    });
    if (isCancel(ok) || !ok) return;
  }
  try {
    const r = await moveStorage(loaded.effective, {
      to,
      systemName: values["system-name"] as string,
      turso: {
        org: (values["turso-org"] as string | undefined) ?? "",
        group: values["turso-group"] as string,
        apiToken: process.env.TURSO_API_TOKEN ?? "",
      },
      libsql: {
        adminUrl: (values["libsql-admin-url"] as string | undefined) ?? "",
        baseUrl: (values["libsql-base-url"] as string | undefined) ?? "",
        adminToken: process.env.LIBSQL_ADMIN_TOKEN || undefined,
      },
      envOut: resolve(envOut),
      configPath: loaded.path,
      env: process.env,
      progress,
    });
    emit(Boolean(values.json), r, () => {
      process.stdout.write(`Safety backup: ${r.backup}\n`);
      process.stdout.write(
        `System DB: ${r.system.name} (${r.system.url}), ${r.system.tables} tables verified\n`,
      );
      for (const o of r.orgs)
        process.stdout.write(
          `  OK   ${o.name} (${o.id}) -> ${o.db}: ${o.tables} tables, ledger #${o.ledger_head.seq}, audit #${o.audit_head.seq}\n`,
        );
      process.stdout.write(`Settings for the new storage written to ${r.env_file} (keep it private).\n`);
      process.stdout.write(
        r.attachments.kind === "s3"
          ? `Attachments stay in ${r.attachments.dir}.\n`
          : `Attachments were not moved: ${r.attachments.files} file(s) in ${r.attachments.dir}. Copy them to the new host's storage dir.\n`,
      );
      process.stdout.write("Keep this instance stopped; the new one takes over from here.\n");
    });
  } catch (e) {
    if (e instanceof MoveStorageError) {
      const code =
        e.code === "server_running"
          ? 3
          : e.code === "missing_argument" || e.code === "invalid_argument"
            ? 2
            : 1;
      throw new CliError(e.message, code, e.code, e.details);
    }
    throw e;
  }
}
