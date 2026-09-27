/** `cosimo doctor` (SPEC §13.4) against a real local instance. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createContext } from "../src/context.ts";
import { silentLogger } from "../src/logger.ts";
import { runDoctor } from "../src/services/doctor.ts";
import { resolveAnswers } from "../src/setup/answers.ts";
import { applyInit } from "../src/setup/init.ts";
import { FakeBucket } from "./harness.ts";

const dir = mkdtempSync(join(tmpdir(), "cosimo-doctor-"));
const configPath = join(dir, "config.toml");
let orgId: string;
const up: typeof fetch = (async () => new Response('{"status":"ok"}')) as unknown as typeof fetch;
const down: typeof fetch = (async () => {
  throw new Error("connection refused");
}) as unknown as typeof fetch;

beforeAll(async () => {
  const r = resolveAnswers(
    { admin_email: "doc@example.com", org_name: "Doctor Co", data_dir: dir, service: false, port: 18998 },
    {},
    { json: true, today: "2026-09-25", homeDataDir: dir, tursoOrg: null, tursoToken: null },
  );
  const res = await applyInit(r.answers, { env: {} });
  orgId = res.org_id!;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const byId = (r: Awaited<ReturnType<typeof runDoctor>>) => Object.fromEntries(r.checks.map((c) => [c.id, c]));

describe("doctor", () => {
  test("a fresh local instance passes, with a warning until the first backup", async () => {
    const r = await runDoctor({ configPath, env: {}, fetchImpl: up });
    const c = byId(r);
    for (const id of [
      "config",
      "master_key",
      "system_db",
      "org_dbs",
      "migrations",
      "chains",
      "server",
      "storage",
      "disk",
    ])
      expect(c[id]?.status).toBe("pass");
    expect(c.backups).toMatchObject({ status: "warn", message: "No backup yet" });
    expect(c.backups!.remediation).toContain("cosimo backup");
    expect(c.plaid).toBeUndefined();
    expect(c.tls).toBeUndefined();
    expect(r.status).toBe("warn");
  });

  test("a stopped local server is a warning with a remediation", async () => {
    const c = byId(await runDoctor({ configPath, env: {}, fetchImpl: down }));
    expect(c.server).toMatchObject({ status: "warn" });
    expect(c.server!.remediation).toContain("cosimo serve");
  });

  test("a config readable by others is flagged", async () => {
    chmodSync(configPath, 0o644);
    const c = byId(await runDoctor({ configPath, env: {}, fetchImpl: up }));
    expect(c.master_key).toMatchObject({ status: "warn", remediation: `chmod 600 ${configPath}` });
    chmodSync(configPath, 0o600);
  });

  test("tampering fails the chain check; a missing config fails early", async () => {
    const ctx = await createContext(loadConfig(configPath, {}).effective, { logger: silentLogger, env: {} });
    const h = await ctx.orgs.mustOpen(orgId);
    await h.client.execute("drop trigger audit_no_update");
    await h.client.execute("update audit_log set action = 'forged' where seq = 1");
    await ctx.close();
    const r = await runDoctor({ configPath, env: {}, fetchImpl: up });
    expect(byId(r).chains).toMatchObject({ status: "fail" });
    expect(byId(r).chains!.message).toContain("Doctor Co (audit seq 1");
    expect(r.status).toBe("fail");

    const missing = await runDoctor({ configPath: join(dir, "nope.toml"), env: {}, fetchImpl: up });
    expect(missing.status).toBe("fail");
    expect(missing.checks).toHaveLength(1);
    expect(missing.checks[0]!.remediation).toContain("cosimo init");
  });

  test("CLI: --json output and exit code 1 on failure", () => {
    const p = Bun.spawnSync(
      [
        "bun",
        join(import.meta.dir, "..", "src", "cli", "main.ts"),
        "doctor",
        "--json",
        "--config",
        configPath,
      ],
      { env: { ...process.env, COSIMO_MASTER_KEY: "" } },
    );
    const out = JSON.parse(p.stdout.toString());
    expect(out.status).toBe("fail");
    expect(out.checks.some((c: { id: string }) => c.id === "chains")).toBe(true);
    expect(p.exitCode).toBe(1);
  });
});

describe("doctor with backups.mode = 's3' (fake bucket)", () => {
  const s3Dir = mkdtempSync(join(tmpdir(), "cosimo-doctor-s3-"));
  const s3ConfigPath = join(s3Dir, "config.toml");

  beforeAll(async () => {
    const r = resolveAnswers(
      {
        admin_email: "doc-s3@example.com",
        org_name: "Doctor S3 Co",
        data_dir: s3Dir,
        service: false,
        port: 18999,
        backups: "s3",
        s3_endpoint: "https://s3.example.com",
        s3_bucket: "doctor-test-bucket",
        s3_region: "us-east-1",
        s3_access_key: "AKIAEXAMPLE",
        s3_secret_key: "secretexample",
      },
      {},
      { json: true, today: "2026-09-25", homeDataDir: s3Dir, tursoOrg: null, tursoToken: null },
    );
    await applyInit(r.answers, { env: {} });
  });
  afterAll(() => rmSync(s3Dir, { recursive: true, force: true }));

  test("warns with no backup yet, passes once one is recorded; backup_bucket passes", async () => {
    const r1 = await runDoctor({
      configPath: s3ConfigPath,
      env: {},
      fetchImpl: up,
      bucket: new FakeBucket(),
    });
    const c1 = byId(r1);
    expect(c1.backups).toMatchObject({ status: "warn", message: "No backup yet" });
    expect(c1.backup_bucket).toMatchObject({ status: "pass", message: "Writable, listable, and deletable" });

    const ctx = await createContext(loadConfig(s3ConfigPath, {}).effective, {
      logger: silentLogger,
      env: {},
    });
    await ctx.settings.set("last_backup", {
      file: "s3://doctor-test-bucket/backups/cosimo-backup-20260101T000000Z.zip",
      at: new Date().toISOString(),
      bytes: 123,
      destination: "s3",
      reason: "manual",
    });
    await ctx.close();

    const r2 = await runDoctor({
      configPath: s3ConfigPath,
      env: {},
      fetchImpl: up,
      bucket: new FakeBucket(),
    });
    expect(byId(r2).backups).toMatchObject({ status: "pass" });
  });

  test("backup_bucket reports a list failure", async () => {
    const bucket = new FakeBucket();
    bucket.onList = () => "access denied";
    const r = await runDoctor({ configPath: s3ConfigPath, env: {}, fetchImpl: up, bucket });
    expect(byId(r).backup_bucket).toMatchObject({ status: "fail" });
    expect(byId(r).backup_bucket!.message).toContain("list");
  });

  test("backup_bucket reports a delete failure as a possible retention lock", async () => {
    const bucket = new FakeBucket();
    bucket.onDelete = () => "locked";
    const r = await runDoctor({ configPath: s3ConfigPath, env: {}, fetchImpl: up, bucket });
    expect(byId(r).backup_bucket).toMatchObject({ status: "fail" });
    expect(byId(r).backup_bucket!.remediation).toContain("retention lock");
  });
});
