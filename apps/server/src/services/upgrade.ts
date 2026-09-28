/**
 * `cosimo upgrade` (SPEC §14.3): download the latest release, verify it, back up, swap the binary,
 * migrate with the new binary, and restart the background service.
 *
 * Docker and Fly instances upgrade by pulling the new image instead; the command says how.
 */
import { chmodSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { sha256Hex } from "@cosimo/core";
import { migrateSystem, orgMigrations, migrate as runMigrations } from "@cosimo/db";
import { DOCKER_IMAGE, RELEASES_API_URL, RELEASES_BASE_URL, VERSION } from "@cosimo/shared";
import type { AppContext } from "../context.ts";
import { createBackup } from "./backup.ts";

/** Compare dotted versions (pre-release suffixes sort before the release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: core!.split(".").map((x) => Number(x) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export function assetName(platform = process.platform, arch = process.arch) {
  const os = platform === "win32" ? "windows" : platform;
  const a = arch === "arm64" ? "arm64" : "x64";
  return `cosimo-${os}-${a}${platform === "win32" ? ".exe" : ""}`;
}

export interface UpgradeDeps {
  fetch: typeof fetch;
  /** Path of the running binary (null when running from source). */
  binaryPath: string | null;
  /** Run the new binary with args; returns exit code and stdout. */
  run: (cmd: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  home: string;
  platform: NodeJS.Platform;
  log: (m: string) => void;
}

export function defaultDeps(log: (m: string) => void): UpgradeDeps {
  return {
    fetch,
    binaryPath: process.env.COSIMO_COMPILED === "1" ? process.execPath : null,
    run: async (cmd) => {
      const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      return { code, stdout, stderr };
    },
    home: homedir(),
    platform: process.platform,
    log,
  };
}

export class UpgradeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

export interface UpgradeResult {
  status: "up_to_date" | "upgraded" | "manual" | "available";
  current: string;
  latest: string;
  backup?: string;
  migrated?: unknown;
  restarted?: string | null;
  instructions?: string[];
}

export interface LatestRelease {
  version: string;
  url: string;
  published_at: string;
}

/**
 * The latest GitHub release, for `cosimo upgrade` and the admin update check. A token is needed
 * while the repo is private (a 404 without one gets a hint instead of a bare HTTP error).
 */
export async function fetchLatestRelease(
  f: typeof fetch,
  env: Record<string, string | undefined>,
  token?: string,
): Promise<LatestRelease> {
  const api = env.COSIMO_RELEASES_API ?? RELEASES_API_URL;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "cosimo",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await f(`${api}/latest`, { headers, signal: AbortSignal.timeout(5000) });
  if (!r.ok) {
    if (r.status === 404 && !token)
      throw new UpgradeError(
        "release_lookup_failed",
        "Releases aren't visible; set updates.github_token for a private repo.",
        4,
      );
    throw new UpgradeError(
      "release_lookup_failed",
      `Could not look up the latest release (HTTP ${r.status}).`,
      4,
    );
  }
  const body = (await r.json()) as { tag_name?: string; html_url?: string; published_at?: string };
  if (!body.tag_name) throw new UpgradeError("release_lookup_failed", "The release has no tag.", 4);
  return {
    version: body.tag_name.replace(/^v/, ""),
    url: body.html_url ?? RELEASES_BASE_URL,
    published_at: body.published_at ?? "",
  };
}

/** Steps to move a deployment to `version`, by `config.instance.target`. */
export function upgradeInstructions(target: "local" | "docker" | "fly", version: string): string[] {
  switch (target) {
    case "docker":
      return [
        "In the deployment directory, set the image tag in docker-compose.yml (or COSIMO_IMAGE) to the new version.",
        "docker compose pull && docker compose up -d",
        "The container backs up and migrates on start.",
      ];
    case "fly":
      return [`fly deploy --image ${DOCKER_IMAGE}:${version}`, "The machine backs up and migrates on start."];
    case "local":
      return ["Run `cosimo upgrade`.", "It backs up, downloads, verifies, swaps the binary, and migrates."];
  }
}

export async function upgrade(
  ctx: AppContext,
  d: UpgradeDeps,
  opts: { version?: string; check?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<UpgradeResult> {
  const env = opts.env ?? process.env;
  const token = ctx.secrets.reveal(ctx.config.updates.github_token) ?? undefined;
  const target = opts.version?.replace(/^v/, "") ?? (await fetchLatestRelease(d.fetch, env, token)).version;
  const base: UpgradeResult = { status: "up_to_date", current: VERSION, latest: target };
  if (!opts.version && compareVersions(target, VERSION) <= 0) return base;
  if (opts.check) return { ...base, status: "available" };

  const t = ctx.config.instance.target;
  if (t === "docker" || t === "fly") {
    return { ...base, status: "manual", instructions: upgradeInstructions(t, target) };
  }
  if (!d.binaryPath)
    throw new UpgradeError(
      "not_a_binary",
      "Running from source: update with git instead (`git pull && bun install`).",
      3,
    );

  // ---------------------------------------------------------------- download and verify
  const dl = env.COSIMO_DOWNLOAD_BASE ?? `${RELEASES_BASE_URL}/download/v${target}`;
  const name = assetName(d.platform);
  d.log(`Downloading ${name} ${target}`);
  const [bin, sums] = await Promise.all([d.fetch(`${dl}/${name}`), d.fetch(`${dl}/checksums.txt`)]);
  if (!bin.ok || !sums.ok)
    throw new UpgradeError("download_failed", `Download failed (HTTP ${bin.status}/${sums.status}).`, 4);
  const bytes = new Uint8Array(await bin.arrayBuffer());
  const line = (await sums.text())
    .split("\n")
    .find((l) => l.trim().endsWith(`  ${name}`) || l.trim().endsWith(` *${name}`));
  const want = line?.trim().split(/\s+/)[0];
  if (!want || want !== sha256Hex(bytes))
    throw new UpgradeError(
      "checksum_mismatch",
      `Checksum verification failed for ${name}. Nothing was changed.`,
      4,
    );

  // ---------------------------------------------------------------- backup, swap, migrate
  const backup = await createBackup(ctx, { reason: "upgrade" });
  d.log(`Backup written: ${backup.file}`);
  const dir = dirname(d.binaryPath);
  const staged = join(dir, `.cosimo-${target}.new`);
  const old = `${d.binaryPath}.old`;
  writeFileSync(staged, bytes, { mode: 0o755 });
  chmodSync(staged, 0o755);
  const probe = await d.run([staged, "version", "--json"]);
  if (probe.code !== 0 || !probe.stdout.includes(target)) {
    rmSync(staged, { force: true });
    throw new UpgradeError(
      "bad_binary",
      "The downloaded binary did not run on this machine. Nothing was changed.",
      1,
    );
  }
  if (existsSync(old)) rmSync(old, { force: true });
  renameSync(d.binaryPath, old);
  renameSync(staged, d.binaryPath);
  d.log(`Installed ${d.binaryPath} (previous version kept as ${old})`);

  const configArgs = ctx.configPath ? ["--config", ctx.configPath] : [];
  const mig = await d.run([d.binaryPath, "migrate", "--json", ...configArgs]);
  let migrated: unknown = null;
  try {
    migrated = JSON.parse(mig.stdout);
  } catch {
    migrated = mig.stdout;
  }
  if (mig.code !== 0) {
    throw new UpgradeError(
      "migration_failed",
      `Migrations stopped with an error. Databases already migrated remain valid. Details: ${(migrated as { message?: string })?.message ?? mig.stderr.trim()}. Restore with \`cosimo restore ${backup.file}\` and the previous binary (${old}) if needed.`,
      1,
    );
  }

  // ---------------------------------------------------------------- restart
  let restarted: string | null = null;
  const plist = join(d.home, "Library", "LaunchAgents", "dev.cosimo.server.plist");
  const unit = join(d.home, ".config", "systemd", "user", "cosimo.service");
  if (d.platform === "darwin" && existsSync(plist)) {
    const uid = process.getuid?.() ?? 501;
    const r = await d.run(["launchctl", "kickstart", "-k", `gui/${uid}/dev.cosimo.server`]);
    restarted = r.code === 0 ? "launchd agent restarted" : null;
  } else if (d.platform === "linux" && existsSync(unit)) {
    const r = await d.run(["systemctl", "--user", "restart", "cosimo.service"]);
    restarted = r.code === 0 ? "systemd user unit restarted" : null;
  }
  return { ...base, status: "upgraded", backup: backup.file, migrated, restarted };
}

/** Apply pending migrations: system first, then each org; stop at the first failure. */
export async function migrateAll(ctx: AppContext) {
  const system = await migrateSystem(ctx.system.client);
  const orgs: { org_id: string; name: string; applied: string[] }[] = [];
  for (const o of await ctx.orgs.list({ includeArchived: true })) {
    const h = await ctx.orgs.mustOpen(o.id);
    try {
      orgs.push({ org_id: o.id, name: o.name, applied: await runMigrations(h.client, orgMigrations) });
    } catch (e) {
      throw new UpgradeError(
        "migration_failed",
        `Migrating ${o.name} (${o.id}) failed: ${(e as Error).message}. Organizations migrated before it remain valid; fix the problem and run \`cosimo migrate\` again.`,
      );
    }
  }
  return { system, orgs };
}
