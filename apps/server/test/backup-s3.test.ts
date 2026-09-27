/**
 * Backups in `backups.mode = "s3"`, against an in-memory fake bucket (no real provider): the upload
 * key, retention against a bucket listing (including a locked delete becoming a warning), listing,
 * and the download → restore round trip.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBackup,
  downloadBackup,
  listBackups,
  RestoreError,
  restoreBackup,
} from "../src/services/backup.ts";
import { createTestEnv, DB_MODE, FakeBucket, type TestEnv } from "./harness.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "cosimo-backup-s3-"));
  dirs.push(d);
  return d;
}

const noServer = (async () => {
  throw new Error("connection refused");
}) as unknown as typeof fetch;

async function s3Env(configure?: (c: TestEnv["config"]) => void): Promise<TestEnv> {
  const env = await createTestEnv({
    configure: (c) => {
      c.backups.mode = "s3";
      c.storage.s3_bucket = "test-bucket";
      configure?.(c);
    },
  });
  dirs.push(env.dir);
  return env;
}

describe("backups in s3 mode (fake bucket)", () => {
  test("uploads under backups/, lists from the bucket, and downloads", async () => {
    const env = await s3Env();
    const bucket = new FakeBucket();
    const r = await createBackup(env.ctx, { reason: "manual", bucket });
    expect(r.destination).toBe("s3");
    expect(r.file).toBe(`s3://test-bucket/backups/${r.name}`);
    expect(r.warnings).toEqual([]);
    expect([...bucket.objects.keys()]).toContain(`backups/${r.name}`);

    const rows = await listBackups(env.config, { bucket });
    expect(rows).toEqual([{ name: r.name, file: r.file, bytes: r.bytes, created_at: rows[0]!.created_at }]);

    const dest = join(tmp(), r.name);
    const dl = await downloadBackup(env.config, r.name, dest, { bucket });
    expect(dl.file).toBe(dest);
    expect(readFileSync(dest).length).toBe(r.bytes);

    await env.close();
  });

  test("stages in tmpdir, not backups.dir, so a backups.dir that can't be created doesn't block the backup", async () => {
    // backups.dir's parent path element is a regular file, so mkdir fails with ENOTDIR even as root.
    const base = tmp();
    writeFileSync(join(base, "file.txt"), "");
    const env = await s3Env((c) => {
      c.backups.dir = join(base, "file.txt", "backups");
    });
    const bucket = new FakeBucket();
    const before = readdirSync(tmpdir()).filter(
      (f) => f.startsWith("cosimo-backup-") && !f.startsWith("cosimo-backup-s3-"),
    );
    const r = await createBackup(env.ctx, { reason: "manual", bucket });
    const after = readdirSync(tmpdir()).filter(
      (f) => f.startsWith("cosimo-backup-") && !f.startsWith("cosimo-backup-s3-"),
    );
    expect(r.destination).toBe("s3");
    expect(bucket.objects.has(`backups/${r.name}`)).toBe(true);
    expect(after).toEqual(before);
    await env.close();
  });

  test("retention deletes what's outside the plan; a locked delete is a warning, not a failure", async () => {
    const env = await s3Env((c) => {
      c.backups.keep_daily = 1;
      c.backups.keep_weekly = 0;
      c.backups.keep_monthly = 0;
    });
    const bucket = new FakeBucket();
    const locked = "cosimo-backup-20200101T030000Z.zip";
    const stale = "cosimo-backup-20200102T030000Z.zip";
    bucket.objects.set(`backups/${locked}`, new Uint8Array([1]));
    bucket.objects.set(`backups/${stale}`, new Uint8Array([2]));
    bucket.onDelete = (key) => (key.endsWith(locked) ? "access denied: retention lock" : undefined);

    const r = await createBackup(env.ctx, { reason: "manual", bucket });
    expect(r.deleted).toEqual([stale]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain(locked);
    expect(bucket.objects.has(`backups/${locked}`)).toBe(true);
    expect(bucket.objects.has(`backups/${stale}`)).toBe(false);
    // Today's backup and the still-locked one remain; the stale one is gone.
    expect([...bucket.objects.keys()].sort()).toEqual([`backups/${locked}`, `backups/${r.name}`].sort());

    await env.close();
  });

  test("a failed bucket list skips retention with a warning; the backup still succeeds", async () => {
    const env = await s3Env();
    const bucket = new FakeBucket();
    bucket.onList = () => "list not supported";
    const r = await createBackup(env.ctx, { reason: "manual", bucket });
    expect(r.deleted).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("list not supported");
    expect(bucket.objects.has(`backups/${r.name}`)).toBe(true);
    expect(((await env.ctx.settings.get("last_backup")) as { file: string }).file).toBe(r.file);
    await env.close();
  });

  test("downloadBackup rejects names that aren't a plain backup filename", async () => {
    const env = await s3Env();
    const bucket = new FakeBucket();
    const e1 = await downloadBackup(env.config, "../x", undefined, { bucket }).catch((e) => e);
    expect(e1).toBeInstanceOf(RestoreError);
    expect(e1.code).toBe("invalid_name");
    const e2 = await downloadBackup(env.config, "foo.zip", undefined, { bucket }).catch((e) => e);
    expect(e2).toBeInstanceOf(RestoreError);
    expect(e2.code).toBe("invalid_name");
    await env.close();
  });

  test.skipIf(DB_MODE !== "sqlite")("download then restore brings back the backed-up state", async () => {
    const env = await s3Env();
    const bucket = new FakeBucket();
    const r = await createBackup(env.ctx, { reason: "manual", bucket });
    const cfg = env.config;
    await env.ctx.close();

    const dl = await downloadBackup(cfg, r.name, undefined, { bucket });
    const res = await restoreBackup(cfg, dl.file, { fetchImpl: noServer });
    expect(res.orgs).toEqual([]);
    expect(res.warnings.join(" ")).toContain("no secrets");
  });
});
