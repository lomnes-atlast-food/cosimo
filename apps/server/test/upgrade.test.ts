/**
 * `cosimo upgrade` (SPEC §14.3): version comparison, docker/fly instructions, and the binary swap
 * order (verify → backup → probe → swap → migrate with the new binary) using a fake release server.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@cosimo/core";
import { VERSION } from "@cosimo/shared";
import {
  assetName,
  compareVersions,
  fetchLatestRelease,
  migrateAll,
  type UpgradeDeps,
  UpgradeError,
  upgrade,
  upgradeInstructions,
} from "../src/services/upgrade.ts";
import { createTestEnv, type TestEnv } from "./harness.ts";

const NEXT = "99.0.0";
const NEW_BIN = new TextEncoder().encode("#!/bin/sh\necho new\n");

let env: TestEnv;
const tmp = mkdtempSync(join(tmpdir(), "cosimo-upgrade-"));

function fakeFetch(opts: { sums?: string; latest?: string } = {}) {
  const name = assetName("linux");
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.endsWith("/latest")) return Response.json({ tag_name: `v${opts.latest ?? NEXT}` });
    if (u.endsWith("/checksums.txt"))
      return new Response(opts.sums ?? `${sha256Hex(NEW_BIN)}  ${name}\nabc  other\n`);
    if (u.endsWith(`/${name}`)) return new Response(NEW_BIN);
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
}

function deps(over: Partial<UpgradeDeps> & { calls?: string[][] } = {}): UpgradeDeps & { calls: string[][] } {
  const calls = over.calls ?? [];
  return {
    fetch: fakeFetch(),
    binaryPath: null,
    home: tmp,
    platform: "linux",
    log: () => {},
    run: async (cmd) => {
      calls.push(cmd);
      if (cmd[1] === "version") return { code: 0, stdout: JSON.stringify({ version: NEXT }), stderr: "" };
      if (cmd[1] === "migrate") return { code: 0, stdout: '{"status":"ok"}', stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    ...over,
    calls,
  };
}

const opts = {
  env: { COSIMO_RELEASES_API: "https://rel.test/api", COSIMO_DOWNLOAD_BASE: "https://rel.test/dl" },
};

beforeAll(async () => {
  env = await createTestEnv({
    configure: (c) => {
      c.backups.dir = join(tmp, "backups");
    },
  });
});
afterAll(async () => {
  await env.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("versions", () => {
  test("compareVersions orders releases and pre-releases", () => {
    expect(compareVersions("1.2.0", "1.10.0")).toBe(-1);
    expect(compareVersions("v2.0.0", "1.99.99")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.1")).toBe(1);
  });
  test("assetName matches the release workflow", () => {
    expect(assetName("darwin", "arm64")).toBe("cosimo-darwin-arm64");
    expect(assetName("linux", "x64")).toBe("cosimo-linux-x64");
    expect(assetName("win32", "x64")).toBe("cosimo-windows-x64.exe");
  });
  test("upgradeInstructions match each deployment target", () => {
    expect(upgradeInstructions("docker", "1.2.3").join("\n")).toContain("docker compose pull");
    expect(upgradeInstructions("fly", "1.2.3").join("\n")).toContain(
      "fly deploy --image ghcr.io/steve-lomnes/cosimo:1.2.3",
    );
    expect(upgradeInstructions("local", "1.2.3").join("\n")).toContain("cosimo upgrade");
  });
});

describe("fetchLatestRelease", () => {
  test("sends the token as a bearer header when given", async () => {
    let headers: Headers | undefined;
    const f = (async (_url: string | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return Response.json({ tag_name: "v1.2.3", html_url: "https://x/1.2.3", published_at: "2026-01-01" });
    }) as unknown as typeof fetch;
    const r = await fetchLatestRelease(f, {}, "secret-token");
    expect(r).toEqual({ version: "1.2.3", url: "https://x/1.2.3", published_at: "2026-01-01" });
    expect(headers?.get("authorization")).toBe("Bearer secret-token");
  });

  test("without a token, no authorization header is sent", async () => {
    let headers: Headers | undefined;
    const f = (async (_url: string | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return Response.json({ tag_name: "v1.0.0" });
    }) as unknown as typeof fetch;
    await fetchLatestRelease(f, {});
    expect(headers?.has("authorization")).toBe(false);
  });

  test("a 404 without a token gives the private-repo hint", async () => {
    const f = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const e = await fetchLatestRelease(f, {}).catch((x) => x);
    expect(e).toBeInstanceOf(UpgradeError);
    expect(e.message).toContain("updates.github_token");
  });

  test("a 404 with a token is a plain lookup failure", async () => {
    const f = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const e = await fetchLatestRelease(f, {}, "tok").catch((x) => x);
    expect(e).toBeInstanceOf(UpgradeError);
    expect(e.message).not.toContain("updates.github_token");
  });
});

describe("upgrade", () => {
  test("check and up-to-date", async () => {
    const r = await upgrade(env.ctx, deps(), { ...opts, check: true });
    expect(r).toMatchObject({ status: "available", current: VERSION, latest: NEXT });
    const same = await upgrade(env.ctx, deps({ fetch: fakeFetch({ latest: VERSION }) }), opts);
    expect(same.status).toBe("up_to_date");
  });

  test("docker and fly targets get pull instructions, not a binary swap", async () => {
    const prev = env.ctx.config.instance.target;
    try {
      env.ctx.config.instance.target = "docker";
      const d = deps({ binaryPath: join(tmp, "never") });
      const r = await upgrade(env.ctx, d, opts);
      expect(r.status).toBe("manual");
      expect(r.instructions!.join("\n")).toContain("docker compose pull");
      expect(d.calls).toEqual([]);
    } finally {
      env.ctx.config.instance.target = prev;
    }
  });

  test("running from source is refused", async () => {
    await expect(upgrade(env.ctx, deps(), opts)).rejects.toMatchObject({ code: "not_a_binary" });
  });

  test("a checksum mismatch changes nothing", async () => {
    const bin = join(tmp, "cosimo-sum");
    writeFileSync(bin, "old");
    const d = deps({
      binaryPath: bin,
      fetch: fakeFetch({ sums: `${"0".repeat(64)}  ${assetName("linux")}\n` }),
    });
    const e = await upgrade(env.ctx, d, opts).catch((x) => x);
    expect(e).toBeInstanceOf(UpgradeError);
    expect(e.code).toBe("checksum_mismatch");
    expect(readFileSync(bin, "utf8")).toBe("old");
    expect(existsSync(`${bin}.old`)).toBe(false);
    expect(d.calls).toEqual([]);
  });

  test("a binary that does not run is discarded before the swap", async () => {
    const bin = join(tmp, "cosimo-bad");
    writeFileSync(bin, "old");
    const d = deps({
      binaryPath: bin,
      run: async () => ({ code: 126, stdout: "", stderr: "exec format error" }),
    });
    await expect(upgrade(env.ctx, d, opts)).rejects.toMatchObject({ code: "bad_binary" });
    expect(readFileSync(bin, "utf8")).toBe("old");
    expect(existsSync(join(tmp, `.cosimo-${NEXT}.new`))).toBe(false);
  });

  test("verify → backup → probe → swap → migrate with the new binary", async () => {
    const bin = join(tmp, "cosimo");
    writeFileSync(bin, "old");
    const d = deps({ binaryPath: bin });
    const r = await upgrade(env.ctx, d, opts);
    expect(r.status).toBe("upgraded");
    expect(existsSync(r.backup!)).toBe(true);
    expect(readFileSync(bin)).toEqual(Buffer.from(NEW_BIN));
    expect(readFileSync(`${bin}.old`, "utf8")).toBe("old");
    expect(d.calls[0]![1]).toBe("version");
    expect(d.calls[1]!.slice(0, 2)).toEqual([bin, "migrate"]);
    expect(r.restarted).toBeNull();
  });

  test("migration failure points at the backup and the previous binary", async () => {
    const bin = join(tmp, "cosimo-mig");
    writeFileSync(bin, "old");
    const d = deps({
      binaryPath: bin,
      run: async (cmd) =>
        cmd[1] === "version"
          ? { code: 0, stdout: NEXT, stderr: "" }
          : { code: 1, stdout: '{"message":"boom"}', stderr: "" },
    });
    const e = await upgrade(env.ctx, d, opts).catch((x) => x);
    expect(e.code).toBe("migration_failed");
    expect(e.message).toContain("boom");
    expect(e.message).toContain(`${bin}.old`);
  });
});

test("migrateAll is idempotent", async () => {
  const r = await migrateAll(env.ctx);
  expect(r.system).toEqual([]);
  expect(r.orgs.every((o) => o.applied.length === 0)).toBe(true);
});

test("serve skips the pre-migration backup on a brand-new instance and when up to date", async () => {
  const { defaultConfig, finalize } = await import("../src/config.ts");
  const { createContext } = await import("../src/context.ts");
  const { generateMasterKey } = await import("../src/crypto.ts");
  const { silentLogger } = await import("../src/logger.ts");
  const { hasPendingMigrations } = await import("../src/cli/commands/serve.ts");
  const cfg = defaultConfig(join(tmp, "fresh"));
  cfg.security.master_key = generateMasterKey();
  const fresh = await createContext(finalize(cfg), { logger: silentLogger, migrate: false, env: {} });
  try {
    expect(await hasPendingMigrations(fresh)).toBe(false);
  } finally {
    await fresh.close();
  }
  expect(await hasPendingMigrations(env.ctx)).toBe(false);
});
