/**
 * Deployment targets (SPEC §13.6): docker and fly file generation and command sequences, the
 * in-container bootstrap through the real CLI, preflight exit codes, and local service installs.
 * External commands are captured by a fake `exec`; nothing is installed on the machine.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOCKER_IMAGE, VERSION } from "@cosimo/shared";
import { parse as parseToml } from "smol-toml";
import { loadConfig } from "../src/config.ts";
import { resolveAnswers } from "../src/setup/answers.ts";
import {
  caddyfile,
  composeFile,
  type Exec,
  type ExecResult,
  flyToml,
  launchdPlist,
  makeDeployer,
  makePreflight,
  readEnvFile,
  realExec,
  systemdUnit,
} from "../src/setup/deploy.ts";
import { applyInit, InitError } from "../src/setup/init.ts";

const dirs: string[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "cosimo-deploy-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const CLI = join(import.meta.dir, "..", "src", "cli", "main.ts");
const initEnv = { json: true, today: "2026-09-25", homeDataDir: "/tmp/x", tursoOrg: null, tursoToken: null };
const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });

function answersFor(extra: Record<string, unknown>) {
  const r = resolveAnswers(
    { admin_email: "owner@example.com", admin_name: "Owner", org_name: "Deploy Co", ...extra },
    {},
    initEnv,
  );
  expect(r.missing).toEqual([]);
  expect(r.invalid).toEqual([]);
  return r.answers;
}

/** Records commands; runs `init --in-container` for real against the generated config. */
function fakeExec(configPath: () => string, dataDir: string, overrides: Record<string, ExecResult> = {}) {
  const calls: { cmd: string[]; stdin?: string }[] = [];
  const exec: Exec = async (cmd, opts = {}) => {
    calls.push({ cmd, stdin: opts.stdin });
    const line = cmd.join(" ");
    for (const [k, v] of Object.entries(overrides)) if (line.includes(k)) return v;
    if (line.includes("init --in-container")) {
      const env = readEnvFile(join(configPath(), "..", "..", ".env"));
      const p = Bun.spawn(["bun", CLI, "init", "--in-container", "--answers", "-", "--yes", "--json"], {
        stdin: new Blob([opts.stdin ?? ""]),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          COSIMO_CONFIG: configPath(),
          COSIMO_MASTER_KEY: env.COSIMO_MASTER_KEY,
          COSIMO_DATABASE_DATA_DIR: dataDir,
          COSIMO_INIT_SKIP_TURSO_DISCOVERY: "1",
        },
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      return { code, stdout, stderr };
    }
    return ok();
  };
  return { exec, calls };
}

describe("docker target", () => {
  test("writes compose, Caddyfile, .env; bootstraps inside the container; starts the stack", async () => {
    const dir = tmp();
    const data = tmp();
    const configPath = join(dir, "cosimo", "config", "config.toml");
    const answers = answersFor({ target: "docker", domain: "books.example.com", smtp_enabled: false });
    expect(answers.signup_mode).toBe("invite_only");
    const f = fakeExec(() => configPath, data);
    const result = await applyInit(answers, {
      configPath,
      preflight: makePreflight({ exec: f.exec }),
      deploy: makeDeployer({ exec: f.exec }),
    });

    expect(result).toMatchObject({
      target: "docker",
      url: "https://books.example.com",
      master_key_location: join(dir, "cosimo", ".env"),
    });
    expect(result.claim_link).toStartWith("https://books.example.com/claim/");
    expect(result.org_id).toBeTruthy();
    expect(result.next_steps.join("\n")).toContain("Back up");

    // Files: config readable by the container user and free of the master key; .env private.
    const envFile = join(dir, "cosimo", ".env");
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(statSync(configPath).mode & 0o777).toBe(0o644);
    const key = readEnvFile(envFile).COSIMO_MASTER_KEY!;
    expect(key.length).toBeGreaterThan(20);
    expect(readFileSync(configPath, "utf8")).not.toContain(key);
    const cfg = loadConfig(configPath, {}).file;
    expect(cfg.server).toMatchObject({
      public_url: "https://books.example.com",
      host: "0.0.0.0",
      trust_proxy: true,
    });
    expect(cfg.database.data_dir).toBe("/data");
    const compose = readFileSync(join(dir, "cosimo", "docker-compose.yml"), "utf8");
    // A source run (as tests are) is a dev build, which pins `latest` instead of the unpublished
    // `0.0.0-dev` tag (see setup/deploy.ts `deployImageTag`).
    expect(compose).toContain(`${DOCKER_IMAGE}:latest`);
    expect(readFileSync(join(dir, "cosimo", "Caddyfile"), "utf8")).toContain("books.example.com {");

    // Command sequence: checks, pull, in-container init (answers on stdin), up.
    const lines = f.calls.map((c) => c.cmd.join(" "));
    expect(lines[0]).toStartWith("docker version");
    expect(lines[1]).toBe("docker compose version");
    expect(lines.findIndex((l) => l.includes("init --in-container"))).toBeLessThan(
      lines.findIndex((l) => l.endsWith("up -d")),
    );
    const initCall = f.calls.find((c) => c.cmd.join(" ").includes("init --in-container"))!;
    expect(JSON.parse(initCall.stdin!)).toMatchObject({ admin_email: "owner@example.com", target: "docker" });
    // The instance data landed in the (container) data dir.
    expect(existsSync(join(data, "data", "system.db"))).toBe(true);
  }, 30_000);

  test("missing Docker exits 3 before anything is written", async () => {
    const dir = tmp();
    const configPath = join(dir, "cosimo", "config", "config.toml");
    const f = fakeExec(() => configPath, tmp(), {
      "docker version": { code: 127, stdout: "", stderr: "not found" },
    });
    const err = await applyInit(answersFor({ target: "docker", domain: "books.example.com" }), {
      configPath,
      preflight: makePreflight({ exec: f.exec }),
      deploy: makeDeployer({ exec: f.exec }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(InitError);
    expect(err.exitCode).toBe(3);
    expect(err.code).toBe("docker_missing");
    expect(err.message).toContain("get.docker.com");
    expect(existsSync(configPath)).toBe(false);
  });

  test("--no-deploy writes files and lists the commands; reconfigure keeps the master key", async () => {
    const dir = tmp();
    const configPath = join(dir, "cosimo", "config", "config.toml");
    const f = fakeExec(() => configPath, tmp());
    const a = answersFor({ target: "docker", domain: "books.example.com" });
    const r = await applyInit(a, {
      configPath,
      preflight: makePreflight({ exec: f.exec, noDeploy: true }),
      deploy: makeDeployer({ exec: f.exec, noDeploy: true }),
    });
    expect(f.calls).toHaveLength(0);
    expect(r.claim_link).toBeNull();
    expect(r.next_steps.join("\n")).toContain("docker compose up -d");
    const key = readEnvFile(join(dir, "cosimo", ".env")).COSIMO_MASTER_KEY;

    const again = await applyInit(a, { configPath, deploy: makeDeployer({ noDeploy: true }) }).catch(
      (e) => e,
    );
    expect(again.exitCode).toBe(5);
    await applyInit(
      { ...a, domain: "ledger.example.com" },
      { configPath, reconfigure: true, deploy: makeDeployer({ noDeploy: true }) },
    );
    expect(readEnvFile(join(dir, "cosimo", ".env")).COSIMO_MASTER_KEY).toBe(key);
    expect(loadConfig(configPath, {}).file.server.public_url).toBe("https://ledger.example.com");
  });

  test("generated compose file validates with `docker compose config`", async () => {
    const probe = await realExec(["docker", "compose", "version"]);
    if (probe.code !== 0) return; // Docker not available here
    const dir = tmp();
    await Bun.write(join(dir, "docker-compose.yml"), composeFile(`${DOCKER_IMAGE}:${VERSION}`));
    await Bun.write(join(dir, "Caddyfile"), caddyfile("books.example.com", "o@example.com"));
    await Bun.write(join(dir, ".env"), "COSIMO_MASTER_KEY=test\n");
    const r = await realExec(
      ["docker", "compose", "-f", join(dir, "docker-compose.yml"), "config", "--quiet"],
      {
        cwd: dir,
      },
    );
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
  });
});

describe("fly target", () => {
  test("generates fly.toml, sets secrets through stdin, deploys, and bootstraps over ssh", async () => {
    const dir = tmp();
    const data = tmp();
    const configPath = join(dir, "cosimo", "config", "config.toml");
    const f = fakeExec(() => configPath, data, {
      "fly status": { code: 1, stdout: "", stderr: "not found" },
    });
    const logs: string[] = [];
    const r = await applyInit(answersFor({ target: "fly", fly_app_name: "acme-books" }), {
      configPath,
      preflight: makePreflight({ exec: f.exec }),
      deploy: makeDeployer({ exec: f.exec, log: (m) => logs.push(m) }),
    });
    expect(r.url).toBe("https://acme-books.fly.dev");
    expect(r.claim_link).toStartWith("https://acme-books.fly.dev/claim/");
    const toml = readFileSync(join(dir, "cosimo", "fly.toml"), "utf8");
    expect(parseToml(toml)).toMatchObject({ app: "acme-books", http_service: { internal_port: 8787 } });
    expect(toml).toContain('app = "acme-books"');
    expect(toml).toContain('destination = "/data"');
    expect(toml).toContain('auto_stop_machines = "off"');

    const lines = f.calls.map((c) => c.cmd.join(" "));
    expect(lines.slice(0, 2)).toEqual(["fly version", "fly auth whoami"]);
    expect(lines).toContain("fly apps create acme-books --org personal");
    expect(lines.some((l) => l.startsWith("fly volumes create cosimo_data"))).toBe(true);
    const secrets = f.calls.find((c) => c.cmd.join(" ").startsWith("fly secrets import"))!;
    const key = readEnvFile(join(dir, "cosimo", ".env")).COSIMO_MASTER_KEY!;
    expect(secrets.stdin).toBe(`COSIMO_MASTER_KEY=${key}`);
    expect(logs.join("\n")).not.toContain(key);
    expect(lines.some((l) => l.startsWith("fly deploy"))).toBe(true);
    expect(lines.at(-1)).toContain("ssh console -C cosimo init --in-container");
  }, 30_000);

  test("flyctl logged out exits 3", async () => {
    const dir = tmp();
    const f = fakeExec(() => "", tmp(), { "fly auth whoami": { code: 1, stdout: "", stderr: "no token" } });
    const err = await applyInit(answersFor({ target: "fly" }), {
      configPath: join(dir, "cosimo", "config", "config.toml"),
      preflight: makePreflight({ exec: f.exec }),
      deploy: makeDeployer({ exec: f.exec }),
    }).catch((e) => e);
    expect(err.exitCode).toBe(3);
    expect(err.code).toBe("flyctl_logged_out");
  });

  test("backups on a bucket forward S3 secrets without switching attachment storage to s3", async () => {
    const dir = tmp();
    const data = tmp();
    const configPath = join(dir, "cosimo", "config", "config.toml");
    const f = fakeExec(() => configPath, data, {
      "fly status": { code: 1, stdout: "", stderr: "not found" },
    });
    await applyInit(
      answersFor({
        target: "fly",
        fly_app_name: "acme-books-s3",
        backups: "s3",
        s3_endpoint: "https://s3.example.com",
        s3_bucket: "acme-backups",
        s3_region: "us-east-1",
        s3_access_key: "AKIAEXAMPLE",
        s3_secret_key: "supersecret",
      }),
      {
        configPath,
        preflight: makePreflight({ exec: f.exec }),
        deploy: makeDeployer({ exec: f.exec }),
      },
    );
    const secrets = f.calls.find((c) => c.cmd.join(" ").startsWith("fly secrets import"))!;
    const lines = secrets.stdin!.split("\n");
    expect(lines).toContain("COSIMO_STORAGE_S3_ENDPOINT=https://s3.example.com");
    expect(lines).toContain("COSIMO_STORAGE_S3_BUCKET=acme-backups");
    expect(lines).toContain("COSIMO_STORAGE_S3_REGION=us-east-1");
    expect(lines).toContain("COSIMO_STORAGE_S3_ACCESS_KEY=AKIAEXAMPLE");
    expect(lines).toContain("COSIMO_STORAGE_S3_SECRET_KEY=supersecret");
    // Attachment storage stays local: init --in-container sets it from the (non-host-only) answers.
    expect(secrets.stdin).not.toContain("COSIMO_STORAGE_KIND");
    expect(secrets.stdin).not.toContain("COSIMO_BACKUPS_MODE");
    expect(loadConfig(configPath, {}).file.storage.kind).toBe("local");
    expect(loadConfig(configPath, {}).file.backups.mode).toBe("s3");
  }, 30_000);

  test("fly.toml passes `fly config validate` when flyctl is available", async () => {
    const probe = await realExec(["fly", "version"]);
    if (probe.code !== 0) return;
    const dir = tmp();
    const path = join(dir, "fly.toml");
    await Bun.write(
      path,
      flyToml({
        app: "cosimo-validate",
        region: "iad",
        image: `${DOCKER_IMAGE}:${VERSION}`,
        publicUrl: "https://x.fly.dev",
        turso: false,
      }),
    );
    const r = await realExec(["fly", "config", "validate", "--config", path, "--strict"], { cwd: dir });
    if (/auth|log ?in|token/i.test(r.stderr)) return; // validation needs a Fly login here
    expect(r.code).toBe(0);
  });
});

describe("local service", () => {
  const run = async (platform: NodeJS.Platform) => {
    const dir = tmp();
    const home = tmp();
    const calls: string[][] = [];
    const exec: Exec = async (cmd) => {
      calls.push(cmd);
      return ok();
    };
    const r = await applyInit(answersFor({ data_dir: dir, service: true, port: 18999 }), {
      deploy: makeDeployer({ exec, home, platform, selfCommand: ["/opt/cosimo"], readyTimeoutMs: 0 }),
    });
    return { r, calls, home, dir };
  };

  test("macOS: launchd agent plist and bootstrap", async () => {
    const { r, calls, home, dir } = await run("darwin");
    const plist = readFileSync(join(home, "Library", "LaunchAgents", "dev.cosimo.server.plist"), "utf8");
    expect(plist).toContain("<string>/opt/cosimo</string>");
    expect(plist).toContain(`<string>${join(dir, "config.toml")}</string>`);
    expect(calls.map((c) => c[0])).toEqual(["launchctl", "launchctl"]);
    expect(calls[1]!.slice(0, 2)).toEqual(["launchctl", "bootstrap"]);
    expect(r.service).toContain("launchd");
    expect(r.next_steps.join("\n")).toContain("runs in the background");
    expect(r.warnings.join("\n")).toContain("did not answer yet");
  });

  test("Linux: systemd user unit enabled and started", async () => {
    const { calls, home } = await run("linux");
    const unit = readFileSync(join(home, ".config", "systemd", "user", "cosimo.service"), "utf8");
    expect(unit).toContain("ExecStart=/opt/cosimo serve --config");
    expect(calls.map((c) => c.join(" "))).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now cosimo.service",
    ]);
  });

  test("Windows: scheduled task at logon", async () => {
    const { calls } = await run("win32");
    expect(calls[0]!.slice(0, 5)).toEqual(["schtasks", "/Create", "/TN", "Cosimo", "/SC"]);
    expect(calls[1]).toEqual(["schtasks", "/Run", "/TN", "Cosimo"]);
  });

  test("unit templates quote paths with spaces", () => {
    expect(systemdUnit(["/Apps/My Cosimo/cosimo", "serve"])).toContain(
      'ExecStart="/Apps/My Cosimo/cosimo" serve',
    );
    expect(launchdPlist(["a&b"], "/l")).toContain("<string>a&amp;b</string>");
  });
});
