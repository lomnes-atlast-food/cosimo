/**
 * Attachment storage (SPEC §4, §12): local filesystem by default, S3-compatible optionally (Bun's
 * built-in S3 client). Keys are opaque (`<orgId>/<ulid>`); file names never touch the path.
 */
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Config } from "../config.ts";

export interface BlobStore {
  kind: "local" | "s3";
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9/_-]{0,200}$/;

function checkKey(key: string) {
  if (!SAFE_KEY.test(key) || key.includes("..")) throw new Error("invalid storage key");
}

export class LocalStore implements BlobStore {
  readonly kind = "local" as const;
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  private path(key: string) {
    checkKey(key);
    const p = resolve(this.root, key);
    if (!p.startsWith(resolve(this.root))) throw new Error("invalid storage key");
    return p;
  }
  async put(key: string, bytes: Uint8Array) {
    const p = this.path(key);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    await Bun.write(p, bytes);
  }
  async get(key: string) {
    const f = Bun.file(this.path(key));
    return (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : null;
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
}

export class S3Store implements BlobStore {
  readonly kind = "s3" as const;
  readonly #client: Bun.S3Client;
  constructor(cfg: Config["storage"]) {
    this.#client = new Bun.S3Client({
      endpoint: cfg.s3_endpoint || undefined,
      bucket: cfg.s3_bucket,
      region: cfg.s3_region || undefined,
      accessKeyId: cfg.s3_access_key,
      secretAccessKey: cfg.s3_secret_key,
    });
  }
  async put(key: string, bytes: Uint8Array, contentType: string) {
    checkKey(key);
    await this.#client.write(key, bytes, { type: contentType });
  }
  async get(key: string) {
    checkKey(key);
    const f = this.#client.file(key);
    if (!(await f.exists())) return null;
    return new Uint8Array(await f.arrayBuffer());
  }
  async delete(key: string) {
    checkKey(key);
    await this.#client.delete(key);
  }
}

/**
 * `reveal` decrypts config secrets (init stores `s3_secret_key` encrypted with the master key);
 * values supplied through the environment are plaintext and pass through unchanged.
 */
export function createStore(config: Config, reveal: (v: string) => string | null = (v) => v): BlobStore {
  if (config.storage.kind === "s3")
    return new S3Store({ ...config.storage, s3_secret_key: reveal(config.storage.s3_secret_key) ?? "" });
  return new LocalStore(config.storage.dir || join(config.database.data_dir, "files"));
}
