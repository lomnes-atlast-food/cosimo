/**
 * Deployment targets for `cosimo init` (SPEC §13.6): docker (Compose + Caddy), fly (Fly.io), and
 * the local background service (launchd, systemd user unit, or a Windows scheduled task).
 *
 * External commands go through an injectable `exec` so tests can capture them. With `noDeploy`,
 * server targets only write their files and return the commands to run.
 */
import { lookup } from "node:dns/promises";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { DOCKER_IMAGE, isDevBuild, VERSION } from "@cosimo/shared";
import { InitError, type InitOptions, type InitResult } from "./init.ts";
import type { Answers } from "./questions.ts";

/** The image tag to deploy. No image is ever published as `0.0.0-dev`, so a source run (`bun run`,
 * `bun test`) deploys `latest` instead of pinning a version that doesn't exist. */
function deployImageTag(): string {
  return isDevBuild() ? "latest" : VERSION;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Exec = (cmd: string[], opts?: { stdin?: string; cwd?: string }) => Promise<ExecResult>;

export const realExec: Exec = async (cmd, opts = {}) => {
  try {
    const p = Bun.spawn(cmd, {
      cwd: opts.cwd,
      stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: "", stderr: (e as Error).message };
  }
};

export interface DeployerOptions {
  exec?: Exec;
  /** Write files only; return the commands instead of running them. */
  noDeploy?: boolean;
  home?: string;
  platform?: NodeJS.Platform;
  /** Command that runs this CLI (defaults to the compiled binary or `bun main.ts`). */
  selfCommand?: string[];
  /** Local service: wait this long for /readyz after starting (ms). */
  readyTimeoutMs?: number;
  log?: (msg: string) => void;
}

type DeployArgs = Parameters<NonNullable<InitOptions["deploy"]>>[0];

/** The command that runs this CLI: the compiled binary, or bun + the entry script in development. */
export function selfCommand(): string[] {
  if (process.env.COSIMO_COMPILED === "1") return [process.execPath];
  return [process.execPath, Bun.main];
}

/** Checks for server targets that must pass before init writes anything (exit code 3). */
export function makePreflight(o: DeployerOptions = {}): NonNullable<InitOptions["preflight"]> {
  const exec = o.exec ?? realExec;
  return async (answers: Answers) => {
    if (o.noDeploy) return;
    if (answers.target === "docker") {
      await need(
        exec,
        ["docker", "version", "--format", "{{.Server.Version}}"],
        "docker_missing",
        "Docker is not installed or not running. Install it with `curl -fsSL https://get.docker.com | sh` (see https://docs.docker.com/engine/install/), then run init again.",
      );
      await need(
        exec,
        ["docker", "compose", "version"],
        "compose_missing",
        "The Docker Compose plugin is missing. Install `docker-compose-plugin` (https://docs.docker.com/compose/install/linux/), then run init again.",
      );
    }
    if (answers.target === "fly") {
      await need(
        exec,
        ["fly", "version"],
        "flyctl_missing",
        "flyctl is not installed. Install it from https://fly.io/docs/flyctl/install/, run `fly auth login`, then run init again.",
      );
      await need(
        exec,
        ["fly", "auth", "whoami"],
        "flyctl_logged_out",
        "flyctl is not logged in. Run `fly auth login`, then run init again.",
      );
    }
  };
}

export function makeDeployer(o: DeployerOptions = {}): NonNullable<InitOptions["deploy"]> {
  const exec = o.exec ?? realExec;
  const log = o.log ?? (() => {});
  return async (args: DeployArgs) => {
    const target = args.result.target;
    if (target === "docker") return deployDocker(args, exec, log, Boolean(o.noDeploy));
    if (target === "fly") return deployFly(args, exec, log, Boolean(o.noDeploy));
    if (target === "local" && args.answers.service === true && !o.noDeploy)
      return installService(args, exec, log, {
        home: o.home ?? homedir(),
        platform: o.platform ?? process.platform,
        self: o.selfCommand ?? selfCommand(),
        readyTimeoutMs: o.readyTimeoutMs ?? 15_000,
      });
  };
}

// ----------------------------------------------------------------------------- helpers

/** Deployment directory for server targets: the parent of `config/config.toml`. */
export function deployDir(configPath: string) {
  return dirname(dirname(configPath));
}

function writeFile(path: string, body: string, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, { mode });
  try {
    chmodSync(path, mode);
  } catch {
    // Windows
  }
}

/** Read KEY=value lines (the deployment .env). */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** Answers the host handles itself; `init --in-container` neither receives nor requires them. */
export const HOST_ONLY_ANSWERS = new Set([
  "fly_region",
  "fly_org",
  "turso_org",
  "turso_api_token",
  "s3_endpoint",
  "s3_bucket",
  "s3_region",
  "s3_access_key",
  "s3_secret_key",
  "service",
  "data_dir",
  "port",
  "host",
  "public_url",
]);

/** Answers forwarded to `init --in-container` (credentials for Turso/S3 stay on the host). */
export function containerAnswers(a: Answers): Answers {
  const out: Answers = {};
  for (const [k, v] of Object.entries(a))
    if (!HOST_ONLY_ANSWERS.has(k) && v !== null && v !== undefined) out[k] = v;
  return out;
}

function parseInitJson(out: string): Partial<InitResult> {
  const start = out.indexOf("{");
  if (start < 0) throw new Error("no JSON in output");
  return JSON.parse(out.slice(start)) as Partial<InitResult>;
}

async function need(exec: Exec, cmd: string[], code: string, message: string) {
  const r = await exec(cmd);
  if (r.code !== 0)
    throw new InitError(3, code, message, { command: cmd.join(" "), stderr: r.stderr.slice(0, 500) });
  return r;
}

async function run(
  exec: Exec,
  log: (m: string) => void,
  cmd: string[],
  opts: { stdin?: string; cwd?: string } = {},
) {
  log(`$ ${cmd.join(" ")}`);
  const r = await exec(cmd, opts);
  if (r.code !== 0) {
    throw new InitError(
      1,
      "command_failed",
      `Command failed (${r.code}): ${cmd.join(" ")}\n${r.stderr.trim().slice(-800)}`,
      {
        command: cmd.join(" "),
      },
    );
  }
  return r;
}

/**
 * Check that `domain` resolves to an address of this machine. Behind NAT or a load balancer it
 * won't, so this only warns.
 */
export async function dnsWarning(domain: string): Promise<string | null> {
  let addrs: string[];
  try {
    addrs = (await lookup(domain, { all: true })).map((x) => x.address);
  } catch {
    return `${domain} does not resolve yet. Point its DNS A/AAAA record at this server; Caddy will get a certificate once it does.`;
  }
  const local = new Set(
    Object.values(networkInterfaces())
      .flat()
      .filter((x): x is NonNullable<typeof x> => Boolean(x))
      .map((x) => x.address),
  );
  if (addrs.some((a) => local.has(a))) return null;
  return `${domain} resolves to ${addrs.join(", ")}, which is not an address of this machine. That is fine behind NAT or a load balancer; otherwise fix DNS before the certificate request.`;
}

// ----------------------------------------------------------------------------- docker

export function composeFile(image: string) {
  return `# Generated by \`cosimo init\` (target: docker). Regenerate with \`cosimo init --reconfigure\`.
name: cosimo
services:
  cosimo:
    image: \${COSIMO_IMAGE:-${image}}
    restart: unless-stopped
    env_file: .env
    environment:
      COSIMO_CONFIG: /etc/cosimo/config.toml
    volumes:
      - cosimo_data:/data
      - ./config:/etc/cosimo:ro
    expose:
      - "8787"
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - cosimo
volumes:
  cosimo_data:
  caddy_data:
  caddy_config:
`;
}

export function caddyfile(domain: string, email: string) {
  return `# Generated by \`cosimo init\`. Caddy gets and renews the HTTPS certificate automatically.
{
	email ${email}
}

${domain} {
	encode zstd gzip
	reverse_proxy cosimo:8787
}
`;
}

async function deployDocker(args: DeployArgs, exec: Exec, log: (m: string) => void, noDeploy: boolean) {
  const { answers, configPath, result } = args;
  const dir = deployDir(configPath);
  const domain = String(answers.domain);
  const image = `${DOCKER_IMAGE}:${deployImageTag()}`;
  const compose = ["docker", "compose", "--project-directory", dir, "-f", join(dir, "docker-compose.yml")];

  log(`Writing ${join(dir, "docker-compose.yml")} and ${join(dir, "Caddyfile")}`);
  writeFile(join(dir, "docker-compose.yml"), composeFile(image));
  writeFile(join(dir, "Caddyfile"), caddyfile(domain, String(answers.admin_email)));
  result.url = `https://${domain}`;
  result.version = VERSION;
  result.deploy_dir = dir;

  const w = await dnsWarning(domain);
  if (w) result.warnings.push(w);

  const initCmd = [
    ...compose,
    "run",
    "--rm",
    "-T",
    "--no-deps",
    "cosimo",
    "init",
    "--in-container",
    "--answers",
    "-",
    "--yes",
    "--json",
  ];
  const upCmd = [...compose, "up", "-d"];
  if (noDeploy) {
    result.next_steps.unshift(
      `cd ${dir} && docker compose pull`,
      `cd ${dir} && docker compose run --rm -T cosimo init --in-container --answers - --yes --json < answers.json  (creates the admin and first organization; prints the claim link)`,
      `cd ${dir} && docker compose up -d`,
    );
    return;
  }

  log("Pulling images");
  const pull = await exec([...compose, "pull", "--ignore-pull-failures"]);
  if (pull.code !== 0) result.warnings.push(`docker compose pull failed: ${pull.stderr.trim().slice(-300)}`);

  log("Creating the admin user and first organization inside the container");
  const r = await run(exec, log, initCmd, { stdin: JSON.stringify(containerAnswers(answers)) });
  applyInner(result, r.stdout);

  log("Starting Cosimo and Caddy");
  await run(exec, log, upCmd);
  result.next_steps.unshift(`Open ${result.url} (the certificate can take a minute on first start).`);
  result.next_steps.push(`Logs: cd ${dir} && docker compose logs -f cosimo`);
}

function applyInner(result: InitResult, stdout: string) {
  let inner: Partial<InitResult>;
  try {
    inner = parseInitJson(stdout);
  } catch {
    throw new InitError(
      1,
      "container_init_failed",
      "Could not read the result of init inside the container.",
      {
        output: stdout.slice(0, 500),
      },
    );
  }
  result.claim_link = inner.claim_link ?? null;
  result.claim_link_expires_at = inner.claim_link_expires_at ?? null;
  result.org_id = inner.org_id ?? null;
  if (inner.version) result.version = inner.version;
  for (const w of inner.warnings ?? []) result.warnings.push(w);
  if (result.claim_link) result.next_steps.unshift("Open the claim link to set your password.");
}

// ----------------------------------------------------------------------------- fly

export function flyToml(o: {
  app: string;
  region: string;
  image: string;
  publicUrl: string;
  turso: boolean;
}) {
  return `# Generated by \`cosimo init\` (target: fly). Deploy with \`fly deploy\`.
app = "${o.app}"
primary_region = "${o.region}"

[build]
  image = "${o.image}"

[env]
  COSIMO_SERVER_PUBLIC_URL = "${o.publicUrl}"
  COSIMO_SERVER_HOST = "0.0.0.0"
  COSIMO_SERVER_PORT = "8787"
  COSIMO_SERVER_TRUST_PROXY = "true"
  COSIMO_INSTANCE_TARGET = "fly"
  COSIMO_DATABASE_DATA_DIR = "/data"
  COSIMO_DATABASE_MODE = "${o.turso ? "turso" : "sqlite"}"

[[mounts]]
  source = "cosimo_data"
  destination = "/data"

[http_service]
  internal_port = 8787
  force_https = true
  # The scheduler (bank sync, backups, reminders) runs in-process, so keep one machine running.
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    grace_period = "10s"
    interval = "30s"
    method = "GET"
    path = "/healthz"
    timeout = "5s"
`;
}

async function deployFly(args: DeployArgs, exec: Exec, log: (m: string) => void, noDeploy: boolean) {
  const { answers, config, configPath, result } = args;
  const dir = deployDir(configPath);
  const app = String(answers.fly_app_name);
  const region = String(answers.fly_region ?? "iad");
  const flyOrg = String(answers.fly_org ?? "personal");
  const image = `${DOCKER_IMAGE}:${deployImageTag()}`;
  result.url = `https://${app}.fly.dev`;
  result.version = VERSION;
  result.deploy_dir = dir;
  const toml = join(dir, "fly.toml");
  const turso = config.database.mode === "turso";

  log(`Writing ${toml}`);
  writeFile(toml, flyToml({ app, region, image, publicUrl: result.url, turso }));

  const env = readEnvFile(join(dir, ".env"));
  const secrets: Record<string, string> = { COSIMO_MASTER_KEY: env.COSIMO_MASTER_KEY ?? "" };
  if (turso) {
    secrets.COSIMO_DATABASE_TURSO_ORG = String(answers.turso_org ?? "");
    if (answers.turso_api_token) secrets.COSIMO_DATABASE_TURSO_API_TOKEN = String(answers.turso_api_token);
  }
  // The bucket credentials are needed whenever either attachments or backups use s3: they never go
  // into config.toml (HOST_ONLY_ANSWERS keeps them off `init --in-container`), only into secrets.
  // `storage.kind` and `backups.mode` themselves are set from the (non-host-only) answers when
  // `init --in-container` writes the config, so they aren't repeated here.
  if (answers.storage === "s3" || answers.backups === "s3") {
    if (answers.storage === "s3") secrets.COSIMO_STORAGE_KIND = "s3";
    for (const k of ["s3_endpoint", "s3_bucket", "s3_region", "s3_access_key", "s3_secret_key"])
      if (answers[k]) secrets[`COSIMO_STORAGE_${k.toUpperCase()}`] = String(answers[k]);
  }
  const secretsText = Object.entries(secrets)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const fly = (...a: string[]) => ["fly", ...a, "--app", app];
  const initCmd = fly("ssh", "console", "-C", "cosimo init --in-container --answers - --yes --json");

  if (noDeploy) {
    result.next_steps.unshift(
      `fly apps create ${app} --org ${flyOrg}`,
      `fly volumes create cosimo_data --size 1 --region ${region} --app ${app} --yes`,
      `fly secrets import --app ${app} --stage < ${join(dir, ".env")}`,
      `fly deploy --config ${toml} --app ${app}`,
      "Then run init again without --no-deploy (it detects the app) or pipe the answers into: fly ssh console -C 'cosimo init --in-container --answers - --yes --json'",
    );
    return;
  }

  const exists = (await exec(fly("status"))).code === 0;
  if (!exists) await run(exec, log, ["fly", "apps", "create", app, "--org", flyOrg]);
  const vols = await exec(fly("volumes", "list", "--json"));
  const hasVol = vols.code === 0 && vols.stdout.includes('"cosimo_data"');
  if (!hasVol)
    await run(exec, log, fly("volumes", "create", "cosimo_data", "--size", "1", "--region", region, "--yes"));
  log(`$ fly secrets import --app ${app} --stage  (values from stdin, not shown)`);
  const s = await exec(fly("secrets", "import", "--stage"), { stdin: secretsText });
  if (s.code !== 0)
    throw new InitError(
      4,
      "fly_secrets_failed",
      `Setting Fly secrets failed: ${s.stderr.trim().slice(-300)}`,
    );
  await run(exec, log, fly("deploy", "--config", toml, "--yes", "--wait-timeout", "300"), { cwd: dir });
  log("Creating the admin user and first organization on the machine");
  const r = await run(exec, log, initCmd, { stdin: JSON.stringify(containerAnswers(answers)) });
  applyInner(result, r.stdout);
  result.next_steps.push(`Logs: fly logs --app ${app}`);
}

// ----------------------------------------------------------------------------- local service

export const SERVICE_LABEL = "dev.cosimo.server";

export function launchdPlist(cmd: string[], logDir: string) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${cmd.map((c) => `    <string>${esc(c)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${esc(join(logDir, "server.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${esc(join(logDir, "server.log"))}</string>
</dict>
</plist>
`;
}

export function systemdUnit(cmd: string[]) {
  const q = (s: string) => (/[\s"\\]/.test(s) ? `"${s.replace(/(["\\])/g, "\\$1")}"` : s);
  return `# Generated by \`cosimo init\`.
[Unit]
Description=Cosimo bookkeeping server
After=network-online.target

[Service]
ExecStart=${cmd.map(q).join(" ")}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

async function installService(
  args: DeployArgs,
  exec: Exec,
  log: (m: string) => void,
  o: { home: string; platform: NodeJS.Platform; self: string[]; readyTimeoutMs: number },
) {
  const { config, configPath, result } = args;
  const cmd = [...o.self, "serve", "--config", configPath];
  const logDir = join(config.database.data_dir, "logs");
  mkdirSync(logDir, { recursive: true });
  let where: string;
  let failed: string | null = null;

  if (o.platform === "darwin") {
    const plist = join(o.home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
    log(`Installing launchd agent ${plist}`);
    writeFile(plist, launchdPlist(cmd, logDir));
    const uid = process.getuid?.() ?? 501;
    await exec(["launchctl", "bootout", `gui/${uid}/${SERVICE_LABEL}`]);
    const r = await exec(["launchctl", "bootstrap", `gui/${uid}`, plist]);
    if (r.code !== 0) failed = r.stderr.trim();
    where = `launchd agent ${SERVICE_LABEL} (${plist})`;
  } else if (o.platform === "linux") {
    const unit = join(o.home, ".config", "systemd", "user", "cosimo.service");
    log(`Installing systemd user unit ${unit}`);
    writeFile(unit, systemdUnit(cmd));
    const reload = await exec(["systemctl", "--user", "daemon-reload"]);
    const r =
      reload.code === 0 ? await exec(["systemctl", "--user", "enable", "--now", "cosimo.service"]) : reload;
    if (r.code !== 0) failed = r.stderr.trim() || "systemctl --user is not available";
    else
      result.next_steps.push(
        "To keep Cosimo running when you are logged out, run `loginctl enable-linger $USER` once.",
      );
    where = `systemd user unit cosimo.service (${unit})`;
  } else if (o.platform === "win32") {
    const tr = cmd.map((c) => (/\s/.test(c) ? `"${c}"` : c)).join(" ");
    log("Creating scheduled task Cosimo (runs at logon)");
    const r = await exec(["schtasks", "/Create", "/TN", "Cosimo", "/SC", "ONLOGON", "/TR", tr, "/F"]);
    if (r.code === 0) await exec(["schtasks", "/Run", "/TN", "Cosimo"]);
    else failed = r.stderr.trim();
    where = "scheduled task Cosimo";
  } else {
    result.warnings.push(
      `Background service is not supported on ${o.platform}; run \`cosimo serve\` yourself.`,
    );
    return;
  }

  // Replace the generic "start the server" step with what actually happened.
  const i = result.next_steps.findIndex((s) => s.startsWith("Start the server"));
  if (failed) {
    result.warnings.push(`Could not start the background service (${where}): ${failed.slice(0, 300)}`);
    return;
  }
  if (i >= 0)
    result.next_steps.splice(i, 1, `Cosimo runs in the background as ${where}. Open ${result.url}.`);
  result.service = where;
  if (!(await waitReady(result.url, o.readyTimeoutMs)))
    result.warnings.push(
      `The service was installed but ${result.url} did not answer yet. Logs: ${join(logDir, "server.log")}`,
    );
}

async function waitReady(url: string, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch {
      // not up yet
    }
    await Bun.sleep(300);
  }
  return false;
}
