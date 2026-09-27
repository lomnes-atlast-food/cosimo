import { type ParseArgsConfig, parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { type AppContext, createContext } from "../context.ts";
import { createLogger, silentLogger } from "../logger.ts";

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
    readonly code = "error",
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface GlobalFlags {
  json: boolean;
  config?: string;
  help: boolean;
}

export type Values = Record<string, string | boolean | string[] | undefined>;

export function parse(argv: string[], options: ParseArgsConfig["options"] = {}) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: "boolean", default: false },
      config: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      ...options,
    },
  });
  return { values: values as Values & GlobalFlags, positionals };
}

/** Human-readable progress goes to stderr so stdout stays parseable. */
export function progress(msg: string) {
  process.stderr.write(`${msg}\n`);
}

export function emit(json: boolean, data: unknown, human?: () => void) {
  if (json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  } else if (human) {
    human();
  } else {
    process.stdout.write(`${typeof data === "string" ? data : JSON.stringify(data, null, 2)}\n`);
  }
}

export function table(rows: Record<string, unknown>[], cols?: string[]) {
  if (rows.length === 0) {
    process.stdout.write("(none)\n");
    return;
  }
  const keys = cols ?? Object.keys(rows[0]!);
  const widths = keys.map((k) => Math.max(k.length, ...rows.map((r) => String(r[k] ?? "").length)));
  const line = (vals: string[]) =>
    vals
      .map((v, i) => v.padEnd(widths[i]!))
      .join("  ")
      .trimEnd();
  process.stdout.write(`${line(keys)}\n${line(widths.map((w) => "-".repeat(w)))}\n`);
  for (const r of rows) process.stdout.write(`${line(keys.map((k) => String(r[k] ?? "")))}\n`);
}

export async function withContext<T>(
  flags: GlobalFlags,
  fn: (ctx: AppContext) => Promise<T>,
  opts: { verbose?: boolean; migrate?: boolean } = {},
): Promise<T> {
  const loaded = loadConfig(flags.config);
  if (!loaded.exists && !process.env.COSIMO_MASTER_KEY) {
    throw new CliError(
      `No instance found (looked for ${loaded.path}). Run \`cosimo init\` first.`,
      1,
      "no_instance",
    );
  }
  const ctx = await createContext(loaded.effective, {
    configPath: loaded.path,
    logger: opts.verbose ? createLogger() : silentLogger,
    migrate: opts.migrate,
  });
  try {
    return await fn(ctx);
  } finally {
    await ctx.close();
  }
}

export async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

export async function promptHidden(question: string): Promise<string> {
  const { password } = await import("@clack/prompts");
  const v = await password({ message: question });
  if (typeof v !== "string") throw new CliError("Cancelled", 1, "cancelled");
  return v;
}
