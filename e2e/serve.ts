/**
 * Start a throwaway instance for the browser tests through the real CLI: `cosimo init` with an
 * answers file (password set up front so tests can sign in), then `cosimo serve`.
 * Requires `bun run build:web` first so the UI is served.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2E_EMAIL, E2E_PASSWORD } from "./constants.ts";

const port = process.argv[2] ?? "8799";
const cli = join(import.meta.dir, "..", "apps", "server", "src", "cli", "main.ts");
const dir = mkdtempSync(join(tmpdir(), "cosimo-e2e-"));
const answers = join(dir, "answers.json");
writeFileSync(
  answers,
  JSON.stringify({
    data_dir: dir,
    service: false,
    admin_email: E2E_EMAIL,
    admin_name: "Owner",
    admin_auth: "prompt",
    admin_password: E2E_PASSWORD,
    org_name: "E2E Studio LLC",
    port: Number(port),
  }),
);
// No public timestamps: the browser tests must not reach OpenTimestamps calendars or FreeTSA.
const env = { ...process.env, COSIMO_INIT_SKIP_TURSO_DISCOVERY: "1", COSIMO_ANCHORING_ENABLED: "0" };
const init = Bun.spawnSync(["bun", cli, "init", "--answers", answers, "--yes", "--json"], { env });
if (init.exitCode !== 0) {
  process.stderr.write(init.stdout.toString() + init.stderr.toString());
  process.exit(1);
}
const serve = Bun.spawn(["bun", cli, "serve", "--config", join(dir, "config.toml")], {
  env,
  stdout: "inherit",
  stderr: "inherit",
});
process.on("SIGTERM", () => serve.kill());
process.on("SIGINT", () => serve.kill());
await serve.exited;
