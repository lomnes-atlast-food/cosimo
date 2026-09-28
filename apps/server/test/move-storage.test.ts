import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { type Config, defaultConfig, finalize } from "../src/config.ts";
import { createContext } from "../src/context.ts";
import { generateMasterKey } from "../src/crypto.ts";
import { silentLogger } from "../src/logger.ts";
import { systemActor } from "../src/services/actor.ts";
import { copyToRemote, TargetNotEmptyError } from "../src/services/archive.ts";
import { auditHead, ledgerHead, verifyOrg } from "../src/services/chain.ts";
import { MoveStorageError, type MoveStorageResult, moveStorage } from "../src/services/move-storage.ts";
import {
  dbNameForOrg,
  LibsqlNamespaceProvisioner,
  type NamedProvisioner,
  type ProvisionedDb,
  TursoProvisioner,
} from "../src/services/provisioning.ts";
import { loadSampleData } from "../src/services/sample-data.ts";
import { DB_MODE, PASSWORD } from "./harness.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Nothing answers the server port (the probe fails). */
const noServer = (async () => {
  throw new Error("connection refused");
}) as unknown as typeof fetch;

/** A stopped SQLite instance with sample books, an archived org, secrets, and one attachment. */
async function sourceInstance() {
  const dir = tmp("cosimo-move-src-");
  const cfg = defaultConfig(dir);
  cfg.security.master_key = generateMasterKey();
  cfg.jobs.enabled = false;
  const config = finalize(cfg);
  const ctx = await createContext(config, { logger: silentLogger, env: {} });
  const user = await ctx.users.create({ email: "owner@example.com", name: "owner", password: PASSWORD });
  const { id: demo } = await loadSampleData(ctx, user.id);
  const old = await ctx.orgs.create({ name: "Old Co", createdBy: user.id });
  await ctx.orgs.archive(old.id, systemActor());
  await ctx.settings.set("plaid", { enabled: true, client_id: "client-1", secret: "plaid-secret" });
  await ctx.settings.set("smtp", { enabled: true, host: "smtp.example.com", password: "smtp-password" });
  mkdirSync(join(config.storage.dir, demo), { recursive: true });
  writeFileSync(join(config.storage.dir, demo, "receipt.pdf"), "%PDF-1.4");
  await ctx.close();
  return { config, orgIds: [demo, old.id] };
}

/** Stands in for a remote server: each named database is a local file. */
class FileProvisioner implements NamedProvisioner {
  readonly kind = "libsql" as const;
  readonly destroyed: string[] = [];
  constructor(
    private readonly dir: string,
    private readonly failOn?: string,
  ) {}
  async createNamed(name: string): Promise<ProvisionedDb> {
    if (name === this.failOn) throw new Error(`cannot create ${name}`);
    return { url: `file:${join(this.dir, `${name}.db`)}` };
  }
  create(orgId: string) {
    return this.createNamed(dbNameForOrg(orgId));
  }
  async destroyNamed(name: string) {
    this.destroyed.push(name);
    rmSync(join(this.dir, `${name}.db`), { force: true });
  }
  destroy(orgId: string) {
    return this.destroyNamed(dbNameForOrg(orgId));
  }
}

async function count(c: Client, table: string) {
  return Number((await c.execute(`select count(*) from ${table}`)).rows[0]![0]);
}

/** Opens the moved instance independently of the command and checks it against the source. */
async function assertMoved(
  source: Config,
  orgIds: string[],
  r: MoveStorageResult,
  target: Config,
  provisioner?: NamedProvisioner,
) {
  expect(r.orgs.map((o) => o.id).sort()).toEqual([...orgIds].sort());
  const local = await createContext(source, { logger: silentLogger, env: {}, migrate: false });
  const moved = structuredClone(target);
  moved.database.system_url = r.system.url;
  const remote = await createContext(moved, { logger: silentLogger, env: {}, provisioner });
  try {
    expect((await remote.orgs.list({ includeArchived: true })).length).toBe(orgIds.length);
    for (const id of orgIds) {
      // The local registry still points at the local files; the new one at the new databases.
      expect((await local.orgs.get(id))!.dbUrl.startsWith("file:")).toBe(true);
      expect((await remote.orgs.get(id))!.dbUrl).toBe(r.orgs.find((o) => o.id === id)!.url);
      const a = await local.orgs.mustOpen(id);
      const b = await remote.orgs.mustOpen(id);
      for (const t of ["journal_entries", "journal_lines", "audit_log", "bank_transactions", "accounts"])
        expect(await count(b.client, t)).toBe(await count(a.client, t));
      expect(await ledgerHead(b.db, id)).toEqual(await ledgerHead(a.db, id));
      expect(await auditHead(b.db, id)).toEqual(await auditHead(a.db, id));
      expect((await verifyOrg(b.db, id)).ok).toBe(true);
    }
    expect(await count(remote.system.client, "users")).toBe(await count(local.system.client, "users"));
    expect((await remote.settings.get("plaid")).secret).toBe("plaid-secret");
    expect((await remote.settings.get("smtp")).password).toBe("smtp-password");
    expect((await remote.users.byEmail("owner@example.com"))?.id).toBeString();
  } finally {
    await local.close();
    await remote.close();
  }
  expect(r.attachments).toMatchObject({ kind: "local", files: 1 });
  expect(existsSync(r.backup)).toBe(true);
}

describe("move-storage refusals", () => {
  test("refuses an instance that is not in sqlite mode", async () => {
    const cfg = finalize(defaultConfig(tmp("cosimo-move-")));
    cfg.database.mode = "turso";
    const e = await moveStorage(cfg, { to: "libsql", fetchImpl: noServer }).catch((x) => x);
    expect(e).toBeInstanceOf(MoveStorageError);
    expect(e.code).toBe("unsupported_mode");
  });

  test("refuses while the server answers on its port", async () => {
    const cfg = finalize(defaultConfig(tmp("cosimo-move-")));
    const up = (async () => new Response("ok")) as unknown as typeof fetch;
    const e = await moveStorage(cfg, { to: "libsql", fetchImpl: up }).catch((x) => x);
    expect(e.code).toBe("server_running");
  });

  test("requires the target's settings", async () => {
    const cfg = finalize(defaultConfig(tmp("cosimo-move-")));
    const e = await moveStorage(cfg, { to: "turso", fetchImpl: noServer }).catch((x) => x);
    expect(e.code).toBe("missing_argument");
  });

  test("copyToRemote refuses a target that already has tables", async () => {
    const d = tmp("cosimo-move-");
    const src = createClient({ url: `file:${join(d, "src.db")}` });
    const dst = createClient({ url: `file:${join(d, "dst.db")}` });
    await src.execute("create table a (x)");
    await dst.execute("create table b (y)");
    const e = await copyToRemote(src, dst).catch((x) => x);
    expect(e).toBeInstanceOf(TargetNotEmptyError);
    src.close();
    dst.close();
  });
});

describe("TursoProvisioner.createNamed", () => {
  test("creates a database and a full-access token; create(orgId) uses the org's name", async () => {
    const calls: { url: string; method?: string; body?: string }[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body as string | undefined });
      if (url.endsWith("/databases")) return Response.json({ database: { Hostname: "db-org.turso.io" } });
      if (url.includes("/auth/tokens")) return Response.json({ jwt: "jwt-1" });
      return new Response("{}");
    };
    const p = new TursoProvisioner({
      apiUrl: "https://api.test",
      org: "me",
      group: "g1",
      apiToken: "t",
      fetch: fetchFn,
    });
    expect(await p.createNamed("cosimo-system")).toEqual({
      url: "libsql://db-org.turso.io",
      authToken: "jwt-1",
    });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ name: "cosimo-system", group: "g1" });
    expect(calls[1]!.url).toBe(
      "https://api.test/v1/organizations/me/databases/cosimo-system/auth/tokens?authorization=full-access",
    );
    await p.create("01ABC");
    expect(JSON.parse(calls[2]!.body!).name).toBe("cosimo-01abc");
    await p.destroyNamed("cosimo-system");
    expect(calls.at(-1)).toMatchObject({
      url: "https://api.test/v1/organizations/me/databases/cosimo-system",
      method: "DELETE",
    });
  });
});

describe("move-storage to file-backed targets", () => {
  const libsql = { adminUrl: "http://admin.invalid", baseUrl: "http://db.invalid" };

  test("copies every org, rewires the registry, keeps secrets, and writes the env file", async () => {
    const { config, orgIds } = await sourceInstance();
    const target = tmp("cosimo-move-dst-");
    const prov = new FileProvisioner(target);
    const envOut = join(tmp("cosimo-move-env-"), "moved.env");
    const localFiles = readdirSync(join(config.database.data_dir, "data", "orgs")).sort();
    const r = await moveStorage(config, {
      to: "libsql",
      libsql,
      provisioner: prov,
      envOut,
      fetchImpl: noServer,
    });
    expect(r.system.name).toBe("cosimo-system");
    expect(r.orgs.find((o) => o.id === orgIds[1])!.archived).toBe(true);
    const targetConfig = structuredClone(config);
    targetConfig.database.mode = "libsql";
    await assertMoved(config, orgIds, r, targetConfig, prov);

    expect(statSync(envOut).mode & 0o777).toBe(0o600);
    const env = readFileSync(envOut, "utf8");
    expect(env).toContain("COSIMO_DATABASE_MODE=libsql\n");
    expect(env).toContain(`COSIMO_DATABASE_SYSTEM_URL=${r.system.url}\n`);
    expect(env).toContain(`COSIMO_MASTER_KEY=${config.security.master_key}\n`);
    // Local files are untouched: same org files, no new ones.
    expect(readdirSync(join(config.database.data_dir, "data", "orgs")).sort()).toEqual(localFiles);
  });

  test("drops the databases it created when a step fails", async () => {
    const { config, orgIds } = await sourceInstance();
    const target = tmp("cosimo-move-dst-");
    const failing = dbNameForOrg(orgIds[1]!);
    const prov = new FileProvisioner(target, failing);
    const e = await moveStorage(config, {
      to: "libsql",
      libsql,
      provisioner: prov,
      fetchImpl: noServer,
    }).catch((x) => x);
    expect(e).toBeInstanceOf(MoveStorageError);
    expect(e.message).toContain(`cannot create ${failing}`);
    // Whichever org came first was created before the failure; everything created is dropped.
    expect(e.details.not_cleaned).toEqual([]);
    expect(e.details.cleaned).toContain("cosimo-system");
    expect(prov.destroyed).toEqual(e.details.cleaned);
    expect(readdirSync(target).filter((f) => f.endsWith(".db"))).toEqual([]);
  });
});

describe.skipIf(DB_MODE !== "sqld")("move-storage to sqld namespaces", () => {
  const libsql = () => ({
    adminUrl: process.env.COSIMO_TEST_SQLD_ADMIN!,
    baseUrl: process.env.COSIMO_TEST_SQLD_URL!,
  });

  test("moves a sample instance losslessly", async () => {
    const { config, orgIds } = await sourceInstance();
    const systemName = `sysmove${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const r = await moveStorage(config, { to: "libsql", libsql: libsql(), systemName, fetchImpl: noServer });
    expect(r.system.url.startsWith("http")).toBe(true);
    const target = structuredClone(config);
    target.database.mode = "libsql";
    target.database.libsql_admin_url = libsql().adminUrl;
    target.database.libsql_base_url = libsql().baseUrl;
    await assertMoved(config, orgIds, r, target);
  });

  test("refuses a namespace that already has tables", async () => {
    const { config } = await sourceInstance();
    const real = new LibsqlNamespaceProvisioner(libsql());
    const name = `sysfull${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const full = await real.createNamed(name);
    const c = createClient({ url: full.url });
    await c.execute("create table leftover (x)");
    c.close();
    // A provisioner that hands back the already-used namespace for the system DB.
    const prov: NamedProvisioner = {
      kind: "libsql",
      createNamed: async () => full,
      destroyNamed: (n) => real.destroyNamed(n),
      create: (id) => real.create(id),
      destroy: (id) => real.destroy(id),
    };
    const e = await moveStorage(config, {
      to: "libsql",
      libsql: libsql(),
      systemName: name,
      provisioner: prov,
      fetchImpl: noServer,
    }).catch((x) => x);
    expect(e.code).toBe("target_not_empty");
    expect(e.details.cleaned).toEqual([name]);
  });
});
