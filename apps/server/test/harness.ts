import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Role } from "@cosimo/shared";
import { type Config, defaultConfig, finalize } from "../src/config.ts";
import { type AppContext, createContext } from "../src/context.ts";
import { generateMasterKey } from "../src/crypto.ts";
import { createApp } from "../src/http/app.ts";
import { silentLogger } from "../src/logger.ts";
import "../src/modules.ts";
import type { BackupBucket, BucketObject } from "../src/services/backup.ts";
import { LibsqlNamespaceProvisioner } from "../src/services/provisioning.ts";
import type { BlobStore } from "../src/services/storage.ts";

export const DB_MODE = process.env.COSIMO_TEST_DB === "sqld" ? "sqld" : "sqlite";

/**
 * An in-memory bucket for backup and doctor tests. `onWrite`/`onList`/`onDelete` let a test make a
 * specific (or every) call fail, to exercise retention warnings and doctor's `backup_bucket` check
 * without a real provider.
 */
export class FakeBucket implements BackupBucket {
  readonly objects = new Map<string, Uint8Array>();
  onWrite?: (key: string) => string | undefined;
  onList?: (prefix: string) => string | undefined;
  onDelete?: (key: string) => string | undefined;
  async write(key: string, file: Bun.BunFile | Blob) {
    const err = this.onWrite?.(key);
    if (err) throw new Error(err);
    this.objects.set(key, new Uint8Array(await file.arrayBuffer()));
  }
  async list(prefix: string): Promise<BucketObject[]> {
    const err = this.onList?.(prefix);
    if (err) throw new Error(err);
    return [...this.objects.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, bytes]) => ({ key, size: bytes.byteLength, lastModified: new Date(0).toISOString() }));
  }
  async delete(key: string) {
    const err = this.onDelete?.(key);
    if (err) throw new Error(err);
    this.objects.delete(key);
  }
  async download(key: string, dest: string) {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error(`Not found in the bucket: ${key}`);
    await Bun.write(dest, bytes);
  }
}

/** An in-memory `BlobStore` for `move-attachments` tests. `puts` records every key actually written. */
export class FakeBlobStore implements BlobStore {
  readonly kind = "s3" as const;
  readonly objects = new Map<string, Uint8Array>();
  readonly puts: string[] = [];
  async put(key: string, bytes: Uint8Array, _contentType: string) {
    this.puts.push(key);
    this.objects.set(key, bytes);
  }
  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

export interface TestEnv {
  ctx: AppContext;
  app: ReturnType<typeof createApp>;
  dir: string;
  config: Config;
  close(): Promise<void>;
}

let counter = 0;

export async function createTestEnv(opts: { configure?: (c: Config) => void } = {}): Promise<TestEnv> {
  const dir = mkdtempSync(join(tmpdir(), "cosimo-test-"));
  const cfg = defaultConfig(dir);
  cfg.security.master_key = generateMasterKey();
  cfg.jobs.enabled = false;
  let provisioner: LibsqlNamespaceProvisioner | undefined;
  if (DB_MODE === "sqld") {
    const base = process.env.COSIMO_TEST_SQLD_URL!;
    const admin = process.env.COSIMO_TEST_SQLD_ADMIN!;
    provisioner = new LibsqlNamespaceProvisioner({ adminUrl: admin, baseUrl: base });
    const sys = await provisioner.create(
      `sys${Date.now()}${counter++}${Math.random().toString(36).slice(2, 6)}`,
    );
    cfg.database.mode = "libsql";
    cfg.database.system_url = sys.url;
    cfg.database.libsql_admin_url = admin;
    cfg.database.libsql_base_url = base;
  }
  opts.configure?.(cfg);
  const config = finalize(cfg);
  const ctx = await createContext(config, { logger: silentLogger, provisioner, env: {} });
  const app = createApp(ctx);
  return {
    ctx,
    app,
    dir,
    config,
    async close() {
      await ctx.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface Client {
  userId: string;
  email: string;
  cookie?: string;
  csrf?: string;
  token?: string;
  req(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  json<T = any>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: T }>;
}

function makeClient(env: TestEnv, base: Omit<Client, "req" | "json">): Client {
  const c: Client = {
    ...base,
    async req(method, path, body, headers = {}) {
      const h: Record<string, string> = { ...headers };
      if (body !== undefined && !(body instanceof FormData)) h["content-type"] = "application/json";
      if (c.cookie) h.cookie = c.cookie;
      if (c.csrf) h["x-csrf-token"] = c.csrf;
      if (c.token) h.authorization = `Bearer ${c.token}`;
      return env.app.request(path, {
        method,
        headers: h,
        body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      });
    },
    async json(method, path, body, headers) {
      const res = await c.req(method, path, body, headers);
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
  };
  return c;
}

export const PASSWORD = "correct horse battery staple";

/** Create a user with a password and sign in through the API. */
export async function login(env: TestEnv, email: string, opts: { admin?: boolean } = {}): Promise<Client> {
  let user = await env.ctx.users.byEmail(email);
  if (!user)
    user = await env.ctx.users.create({
      email,
      name: email.split("@")[0],
      password: PASSWORD,
      isInstanceAdmin: opts.admin,
    });
  env.ctx.rateLimiter.reset();
  const res = await env.app.request("/api/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const cookies = res.headers.getSetCookie().map((s) => s.split(";")[0]!);
  const body = (await res.json()) as { csrf_token: string };
  return makeClient(env, { userId: user.id, email, cookie: cookies.join("; "), csrf: body.csrf_token });
}

export function tokenClient(env: TestEnv, token: string, userId = "", email = ""): Client {
  return makeClient(env, { userId, email, token });
}

export function anon(env: TestEnv): Client {
  return makeClient(env, { userId: "", email: "" });
}

/** Create an org owned by `owner` and optionally add members with roles. Returns org id. */
export async function createOrg(
  env: TestEnv,
  owner: Client,
  name = "Test Co",
  body: Record<string, unknown> = {},
) {
  const r = await owner.json("POST", "/api/v1/orgs", { name, ...body });
  if (r.status !== 201) throw new Error(`org create failed: ${JSON.stringify(r.body)}`);
  return r.body.id as string;
}

export async function addMember(env: TestEnv, orgId: string, userId: string, role: Role) {
  const { system } = await import("@cosimo/db");
  await env.ctx.system.write((tx) => tx.insert(system.memberships).values({ userId, orgId, role }));
}
