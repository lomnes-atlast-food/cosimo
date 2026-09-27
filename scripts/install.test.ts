import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALL_SH = join(import.meta.dir, "install.sh");
const INSTALL_PS1 = join(import.meta.dir, "install.ps1");
const isWindows = process.platform === "win32";

const os = process.platform === "darwin" ? "darwin" : "linux";
const arch = process.arch === "arm64" ? "arm64" : "x64";
const ASSET = `cosimo-${os}-${arch}`;

const FAKE_BINARY = `#!/bin/sh
echo "fake-cosimo $*"
echo "version 0.0.0-test"
`;

// Tools install.sh needs; cosign is deliberately excluded.
const TOOLS = [
  "sh",
  "curl",
  "uname",
  "mktemp",
  "chmod",
  "mkdir",
  "mv",
  "cp",
  "rm",
  "awk",
  "cat",
  "id",
  "sha256sum",
  "shasum",
  "perl", // macOS shasum is a perl script
];

let root: string;
let releaseDir: string;
let binPath: string;
let cosignPath: string;
let server: ReturnType<typeof Bun.serve>;

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function writeRelease(dir: string, binary: string, checksumOf: string = binary): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ASSET), binary);
  writeFileSync(
    join(dir, "checksums.txt"),
    `${sha256("other")}  cosimo-windows-x64.exe\n${sha256(checksumOf)}  ${ASSET}\n`,
  );
}

// Async spawn: a sync spawn would block the event loop and starve the in-process server.
async function runInstall(
  args: string[],
  opts: { release: string; installDir: string; shell?: string; env?: Record<string, string> },
) {
  const home = mkdtempSync(join(root, "home-"));
  const proc = Bun.spawn([opts.shell ?? "sh", INSTALL_SH, ...args], {
    env: {
      HOME: home,
      PATH: binPath,
      COSIMO_DOWNLOAD_BASE: `${server.url.origin}/${opts.release}`,
      COSIMO_INSTALL_DIR: opts.installDir,
      ...opts.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe.skipIf(isWindows)("scripts/install.sh", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "cosimo-install-test-"));
    releaseDir = join(root, "releases");
    writeRelease(join(releaseDir, "good"), FAKE_BINARY);
    writeRelease(join(releaseDir, "bad"), FAKE_BINARY, "tampered");

    writeRelease(join(releaseDir, "signed-bundle"), FAKE_BINARY);
    writeFileSync(join(releaseDir, "signed-bundle", "checksums.txt.sigstore.json"), "{}");

    // Legacy releases (v0.1.0, v0.1.1) carry only a detached signature and certificate.
    writeRelease(join(releaseDir, "signed"), FAKE_BINARY);
    writeFileSync(join(releaseDir, "signed", "checksums.txt.sig"), "sig");
    writeFileSync(join(releaseDir, "signed", "checksums.txt.pem"), "pem");

    // A fake cosign that logs its args and exits with $FAKE_COSIGN_EXIT.
    cosignPath = join(root, "cosign-bin");
    mkdirSync(cosignPath);
    writeFileSync(
      join(cosignPath, "cosign"),
      '#!/bin/sh\necho "$*" > "$FAKE_COSIGN_LOG"\nexit "${FAKE_COSIGN_EXIT:-0}"\n',
      { mode: 0o755 },
    );

    binPath = join(root, "path-bin");
    mkdirSync(binPath);
    for (const tool of TOOLS) {
      const found = Bun.which(tool);
      if (found) symlinkSync(found, join(binPath, tool));
    }
    expect(Bun.which("cosign", { PATH: binPath })).toBeNull();

    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = join(releaseDir, decodeURIComponent(new URL(req.url).pathname));
        if (!path.startsWith(releaseDir) || !existsSync(path))
          return new Response("not found", { status: 404 });
        return new Response(Bun.file(path));
      },
    });
  });

  afterAll(() => {
    server?.stop(true);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("passes sh -n", () => {
    const proc = Bun.spawnSync(["sh", "-n", INSTALL_SH]);
    expect(proc.stderr.toString()).toBe("");
    expect(proc.exitCode).toBe(0);
  });

  test.skipIf(!Bun.which("dash"))("passes dash -n", () => {
    expect(Bun.spawnSync(["dash", "-n", INSTALL_SH]).exitCode).toBe(0);
  });

  test.skipIf(!Bun.which("shellcheck"))("passes shellcheck", () => {
    const proc = Bun.spawnSync(["shellcheck", "-s", "sh", INSTALL_SH]);
    expect(proc.stdout.toString()).toBe("");
    expect(proc.exitCode).toBe(0);
  });

  test("--help prints usage without installing", async () => {
    const installDir = join(root, "bin-help");
    const r = await runInstall(["--help"], { release: "good", installDir });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("Usage: install.sh");
    expect(existsSync(installDir)).toBe(false);
  });

  test("installs, verifies, and runs init with passthrough args", async () => {
    const installDir = join(root, "bin-good");
    const r = await runInstall(["--flag-a", "x"], { release: "good", installDir });
    expect(r.stderr).not.toContain("error");
    expect(r.exitCode).toBe(0);

    const installed = join(installDir, "cosimo");
    expect(statSync(installed).mode & 0o777).toBe(0o755);
    // stdout carries only the init output.
    expect(r.stdout).toBe("fake-cosimo init --flag-a x\nversion 0.0.0-test\n");
    // stderr shows every action.
    expect(r.stderr).toContain(`cosimo-install: detected platform ${os}/${arch}`);
    expect(r.stderr).toContain(`cosimo-install: downloading ${server.url.origin}/good/${ASSET}`);
    expect(r.stderr).toContain("cosign not found");
    expect(r.stderr).toContain("checksum OK");
    expect(r.stderr).toContain(`installed ${installed}`);
    expect(r.stderr).toContain("is not on your PATH");
    expect(r.stderr).toContain("running:");
  });

  describe("with cosign on PATH", () => {
    const cosignEnv = (extra: Record<string, string> = {}) => ({
      PATH: `${cosignPath}:${binPath}`,
      FAKE_COSIGN_LOG: join(root, "cosign.log"),
      ...extra,
    });

    const IDENTITY =
      "--certificate-identity-regexp ^https://github.com/lomnes-atlast-food/cosimo/.github/workflows/release.yml@";
    const ISSUER = "--certificate-oidc-issuer https://token.actions.githubusercontent.com";

    test("verifies the checksums signature bundle", async () => {
      const installDir = join(root, "bin-signed-bundle");
      const r = await runInstall(["--no-init"], { release: "signed-bundle", installDir, env: cosignEnv() });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("signature OK");
      const log = await Bun.file(join(root, "cosign.log")).text();
      expect(log).toContain("verify-blob --bundle");
      expect(log).toContain("checksums.txt.sigstore.json");
      expect(log).not.toContain("--signature");
      expect(log).toContain(IDENTITY);
      expect(log).toContain(ISSUER);
      expect(existsSync(join(installDir, "cosimo"))).toBe(true);
    });

    test("falls back to the legacy .sig/.pem when a release has no bundle", async () => {
      const installDir = join(root, "bin-signed");
      const r = await runInstall(["--no-init"], { release: "signed", installDir, env: cosignEnv() });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain("no signature bundle");
      expect(r.stderr).toContain("signature OK");
      const log = await Bun.file(join(root, "cosign.log")).text();
      expect(log).toContain("verify-blob");
      expect(log).toContain("--certificate ");
      expect(log).toContain("--signature ");
      expect(log).not.toContain("--bundle");
      expect(log).toContain(IDENTITY);
      expect(log).toContain(ISSUER);
      expect(existsSync(join(installDir, "cosimo"))).toBe(true);
    });

    for (const release of ["signed-bundle", "signed"]) {
      test(`bad signature aborts without installing (${release})`, async () => {
        const installDir = join(root, `bin-badsig-${release}`);
        const env = cosignEnv({ FAKE_COSIGN_EXIT: "1" });
        const r = await runInstall(["--no-init"], { release, installDir, env });
        expect(r.exitCode).not.toBe(0);
        expect(r.stderr).toContain("signature verification FAILED");
        expect(existsSync(join(installDir, "cosimo"))).toBe(false);
      });
    }

    test("missing signature files abort unless COSIMO_ALLOW_UNSIGNED=1", async () => {
      const installDir = join(root, "bin-unsigned");
      const r = await runInstall(["--no-init"], { release: "good", installDir, env: cosignEnv() });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain("signature files missing");
      expect(existsSync(join(installDir, "cosimo"))).toBe(false);

      const env = cosignEnv({ COSIMO_ALLOW_UNSIGNED: "1" });
      const r2 = await runInstall(["--no-init"], { release: "good", installDir, env });
      expect(r2.exitCode).toBe(0);
      expect(r2.stderr).toContain("COSIMO_ALLOW_UNSIGNED=1");
      expect(existsSync(join(installDir, "cosimo"))).toBe(true);
    });
  });

  test.skipIf(!Bun.which("dash"))("works under dash", async () => {
    const installDir = join(root, "bin-dash");
    const r = await runInstall(["--json"], { release: "good", installDir, shell: Bun.which("dash")! });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("fake-cosimo init --json\nversion 0.0.0-test\n");
  });

  test("--no-init installs without running init", async () => {
    const installDir = join(root, "bin-noinit");
    const r = await runInstall(["--no-init", "--yes"], { release: "good", installDir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(join(installDir, "cosimo"))).toBe(true);
    expect(r.stderr).toContain("skipping 'cosimo init'");
  });

  test("checksum mismatch aborts without installing", async () => {
    const installDir = join(root, "bin-bad");
    const r = await runInstall([], { release: "bad", installDir });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("checksum mismatch");
    expect(r.stdout).toBe("");
    expect(existsSync(join(installDir, "cosimo"))).toBe(false);
  });

  test("missing asset aborts", async () => {
    const installDir = join(root, "bin-missing");
    const r = await runInstall([], { release: "nope", installDir });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("download of");
    expect(existsSync(join(installDir, "cosimo"))).toBe(false);
  });
});

describe.skipIf(!Bun.which("pwsh"))("scripts/install.ps1", () => {
  test("parses without errors", () => {
    const cmd =
      "$t=$null; $e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:PS1_PATH, [ref]$t, [ref]$e); " +
      "$e | ForEach-Object { Write-Output $_.Message }; exit $e.Count";
    const proc = Bun.spawnSync(["pwsh", "-NoProfile", "-NonInteractive", "-Command", cmd], {
      env: { ...process.env, PS1_PATH: INSTALL_PS1 },
    });
    expect(proc.stdout.toString()).toBe("");
    expect(proc.exitCode).toBe(0);
  }, 60_000); // pwsh starts slowly on CI runners
});
