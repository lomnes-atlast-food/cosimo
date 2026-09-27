#!/usr/bin/env bun
import { COMMIT, VERSION } from "@cosimo/shared";
import "../modules.ts";
import { configCommand } from "./commands/config.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { initCommand } from "./commands/init.ts";
import { moveAttachmentsCommand } from "./commands/move-attachments.ts";
import { moveStorageCommand } from "./commands/move-storage.ts";
import {
  backupCommand,
  exportCommand,
  importCommand,
  migrateCommand,
  restoreCommand,
  upgradeCommand,
} from "./commands/ops.ts";
import { orgCommand } from "./commands/org.ts";
import { serveCommand } from "./commands/serve.ts";
import { tokenCommand } from "./commands/token.ts";
import { userCommand } from "./commands/user.ts";
import { verifyCommand } from "./commands/verify.ts";
import { CliError } from "./util.ts";

type Command = (argv: string[]) => Promise<void>;

export const commands: Record<string, { run: Command; help: string }> = {
  init: { run: initCommand, help: "Set up a new instance (interactive or --answers)" },
  serve: { run: serveCommand, help: "Run the server" },
  doctor: {
    run: doctorCommand,
    help: "Check health (config, databases, chains, server, TLS, Plaid, SMTP, storage, backups, disk)",
  },
  user: { run: userCommand, help: "create, list, disable, reset-password, claim-link, make-admin" },
  org: { run: orgCommand, help: "create, list, archive" },
  token: { run: tokenCommand, help: "create, list, revoke API tokens (including propose_only)" },
  config: { run: configCommand, help: "get, set, list" },
  verify: { run: verifyCommand, help: "Recompute an org's hash chains and report the first broken link" },
  upgrade: { run: upgradeCommand, help: "Download the latest release, back up, migrate, restart" },
  migrate: { run: migrateCommand, help: "Apply pending database migrations (system, then each org)" },
  backup: { run: backupCommand, help: "Create a backup now (or `backup list`)" },
  restore: { run: restoreCommand, help: "Restore a backup into this (stopped) instance" },
  "move-storage": {
    run: moveStorageCommand,
    help: "Copy this (stopped) SQLite instance to Turso or a libSQL server, losslessly",
  },
  "move-attachments": {
    run: moveAttachmentsCommand,
    help: "Copy local attachments into the configured S3 bucket, without deleting them",
  },
  export: { run: exportCommand, help: "Export one org to the open format" },
  import: { run: importCommand, help: "Import an org export, or QuickBooks Online / Xero / Wave CSVs" },
  version: {
    run: async (argv) => {
      if (argv.includes("--json"))
        process.stdout.write(`${JSON.stringify({ version: VERSION, commit: COMMIT })}\n`);
      else process.stdout.write(`cosimo ${VERSION}\n`);
    },
    help: "Print the version",
  },
};

export function registerCommand(name: string, run: Command, help: string) {
  commands[name] = { run, help };
}

function usage() {
  const width = Math.max(...Object.keys(commands).map((k) => k.length));
  return `Cosimo ${VERSION}: self-hosted double-entry bookkeeping

Usage: cosimo <command> [options]

Commands:
${Object.entries(commands)
  .map(([k, v]) => `  ${k.padEnd(width)}  ${v.help}`)
  .join("\n")}

Every command supports --json and --config <path>.`;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(`cosimo ${VERSION}\n`);
    return 0;
  }
  const c = commands[cmd];
  if (!c) {
    process.stderr.write(`Unknown command: ${cmd}\n\n${usage()}\n`);
    return 2;
  }
  const json = rest.includes("--json");
  try {
    await c.run(rest);
    return 0;
  } catch (e) {
    const err = e instanceof CliError ? e : null;
    const code = err?.exitCode ?? (/ERR_PARSE_ARGS/.test(String((e as { code?: string }).code)) ? 2 : 1);
    if (json) {
      process.stdout.write(
        `${JSON.stringify({ status: "error", code: err?.code ?? "error", message: (e as Error).message, ...(err?.details ?? {}) }, null, 2)}\n`,
      );
    } else {
      process.stderr.write(`Error: ${(e as Error).message}\n`);
      if (!err && process.env.COSIMO_DEBUG) process.stderr.write(`${(e as Error).stack}\n`);
    }
    return code;
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code || process.exitCode || 0);
}
