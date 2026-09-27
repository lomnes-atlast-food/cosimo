/**
 * `moveAttachments`: copying local `storage.dir` files into a bucket (a fake `BlobStore` here, so no
 * real provider is touched), skip-if-same-size, checksum verification, and dry run.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, finalize } from "../src/config.ts";
import { moveAttachments } from "../src/services/move-attachments.ts";
import { FakeBlobStore } from "./harness.ts";

function sourceDir() {
  const dir = mkdtempSync(join(tmpdir(), "cosimo-move-att-"));
  mkdirSync(join(dir, "org1"), { recursive: true });
  writeFileSync(join(dir, "org1", "aaa"), "hello world");
  writeFileSync(join(dir, "org1", "bbb"), "another file, a bit longer");
  return dir;
}

function cfgFor(dir: string) {
  const c = defaultConfig(dir);
  c.storage.dir = dir;
  return finalize(c);
}

const noReveal = (v: string) => v;

describe("moveAttachments", () => {
  test("copies every file under storage.dir, verifying each by sha256", async () => {
    const dir = sourceDir();
    const store = new FakeBlobStore();
    const r = await moveAttachments(cfgFor(dir), noReveal, { store });
    expect(r).toMatchObject({ copied: 2, skipped: 0, failed: 0, errors: [] });
    expect(r.bytes).toBe("hello world".length + "another file, a bit longer".length);
    expect(new TextDecoder().decode(store.objects.get("org1/aaa")!)).toBe("hello world");
    expect(new TextDecoder().decode(store.objects.get("org1/bbb")!)).toBe("another file, a bit longer");
    rmSync(dir, { recursive: true, force: true });
  });

  test("skips a key that already exists in the bucket with a matching size", async () => {
    const dir = sourceDir();
    const store = new FakeBlobStore();
    await store.put("org1/aaa", new TextEncoder().encode("hello world"), "application/octet-stream");
    const r = await moveAttachments(cfgFor(dir), noReveal, { store });
    expect(r).toMatchObject({ copied: 1, skipped: 1, failed: 0 });
    expect(store.puts).toEqual(["org1/aaa", "org1/bbb"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("--dry-run reports what it would copy without writing anything", async () => {
    const dir = sourceDir();
    const store = new FakeBlobStore();
    await store.put("org1/aaa", new TextEncoder().encode("hello world"), "application/octet-stream");
    const before = [...store.puts];
    const r = await moveAttachments(cfgFor(dir), noReveal, { store, dryRun: true });
    expect(r).toMatchObject({ copied: 1, skipped: 1, failed: 0 });
    expect(store.puts).toEqual(before);
    rmSync(dir, { recursive: true, force: true });
  });

  test("reports a checksum mismatch as a failure without throwing", async () => {
    const dir = sourceDir();
    class CorruptingStore extends FakeBlobStore {
      override async get(key: string) {
        const bytes = await super.get(key);
        return key === "org1/aaa" && bytes ? new TextEncoder().encode("corrupted") : bytes;
      }
    }
    const store = new CorruptingStore();
    const r = await moveAttachments(cfgFor(dir), noReveal, { store });
    expect(r.copied).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.errors).toEqual([{ key: "org1/aaa", message: expect.stringContaining("did not read back") }]);
    rmSync(dir, { recursive: true, force: true });
  });
});
