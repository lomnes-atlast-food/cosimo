/**
 * `cosimo move-attachments`: copy every attachment out of local storage into the S3-compatible
 * bucket configured by `storage.s3_*`, even while `storage.kind` is still `local`, so an install can
 * switch to bucket storage without losing anything. Attachments are append-only (the app's only
 * `store.delete` caller is the doctor probe), so this is safe to run while the server is up, and
 * safe to run again afterward to catch anything written in between.
 */
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { sha256Hex } from "@cosimo/core";
import type { Config } from "../config.ts";
import { walkFiles } from "./backup.ts";
import { type BlobStore, S3Store } from "./storage.ts";

export interface MoveAttachmentsResult {
  copied: number;
  skipped: number;
  failed: number;
  bytes: number;
  errors: { key: string; message: string }[];
}

export interface MoveAttachmentsOptions {
  /** List what would be copied; nothing is written to the bucket. */
  dryRun?: boolean;
  /** Tests: an in-memory fake in place of a real `S3Store`. */
  store?: BlobStore;
  progress?: (msg: string) => void;
}

/**
 * Walk `storage.dir` and copy each file to the bucket under the same relative key
 * (`<orgId>/<ulid>`, unchanged). A key that already exists in the bucket with the same size is
 * skipped; every new copy is read back and checked against the local file's sha256. Local files are
 * never deleted.
 */
export async function moveAttachments(
  cfg: Config,
  reveal: (v: string) => string | null,
  opts: MoveAttachmentsOptions = {},
): Promise<MoveAttachmentsResult> {
  if (!opts.store && !cfg.storage.s3_bucket)
    throw new Error("storage.s3_bucket is not set; configure the storage.s3_* settings first.");
  const say = opts.progress ?? (() => {});
  const store =
    opts.store ?? new S3Store({ ...cfg.storage, s3_secret_key: reveal(cfg.storage.s3_secret_key) ?? "" });
  const result: MoveAttachmentsResult = { copied: 0, skipped: 0, failed: 0, bytes: 0, errors: [] };
  for (const f of walkFiles(cfg.storage.dir)) {
    const key = relative(cfg.storage.dir, f).replace(/\\/g, "/");
    try {
      const bytes = new Uint8Array(readFileSync(f));
      const existing = await store.get(key);
      if (existing && existing.byteLength === bytes.byteLength) {
        result.skipped++;
        continue;
      }
      if (opts.dryRun) {
        say(`Would copy ${key} (${bytes.byteLength} bytes)`);
        result.copied++;
        result.bytes += bytes.byteLength;
        continue;
      }
      say(`Copying ${key}`);
      await store.put(key, bytes, "application/octet-stream");
      const verify = await store.get(key);
      if (!verify || sha256Hex(verify) !== sha256Hex(bytes))
        throw new Error("the bucket did not read back the same bytes");
      result.copied++;
      result.bytes += bytes.byteLength;
    } catch (e) {
      result.failed++;
      result.errors.push({ key, message: (e as Error).message });
    }
  }
  return result;
}
