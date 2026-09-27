/**
 * Org database provisioning. Together with packages/db/src/connect.ts, this is the only place
 * that knows about storage modes (SPEC §4.2).
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";

export interface ProvisionedDb {
  url: string;
  authToken?: string;
}

export interface OrgProvisioner {
  readonly kind: "sqlite" | "turso" | "libsql";
  create(orgId: string): Promise<ProvisionedDb>;
  destroy(orgId: string, url: string): Promise<void>;
}

/** A provisioner that can also create and drop databases by name (the system DB in `move-storage`). */
export interface NamedProvisioner extends OrgProvisioner {
  createNamed(name: string): Promise<ProvisionedDb>;
  destroyNamed(name: string): Promise<void>;
}

export class ExternalServiceError extends Error {
  constructor(
    readonly service: string,
    message: string,
  ) {
    super(`${service}: ${message}`);
  }
}

export function dbNameForOrg(orgId: string): string {
  return `cosimo-${orgId.toLowerCase()}`;
}

export class LocalProvisioner implements OrgProvisioner {
  readonly kind = "sqlite" as const;
  constructor(private readonly dataDir: string) {}
  async create(orgId: string): Promise<ProvisionedDb> {
    return { url: `file:${join(this.dataDir, "data", "orgs", `${orgId}.db`)}` };
  }
  async destroy(_orgId: string, url: string): Promise<void> {
    const path = url.replace(/^file:/, "");
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  }
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Creates one database per org through the Turso Platform API. */
export class TursoProvisioner implements NamedProvisioner {
  readonly kind = "turso" as const;
  constructor(
    private readonly opts: { apiUrl: string; org: string; group: string; apiToken: string; fetch?: FetchFn },
  ) {}

  private async call(path: string, init: RequestInit = {}): Promise<unknown> {
    const f = this.opts.fetch ?? fetch;
    const res = await f(`${this.opts.apiUrl}/v1/organizations/${encodeURIComponent(this.opts.org)}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.opts.apiToken}`, "content-type": "application/json" },
    });
    const text = await res.text();
    if (!res.ok) throw new ExternalServiceError("turso", `HTTP ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  }

  create(orgId: string): Promise<ProvisionedDb> {
    return this.createNamed(dbNameForOrg(orgId));
  }

  async createNamed(name: string): Promise<ProvisionedDb> {
    const created = (await this.call("/databases", {
      method: "POST",
      body: JSON.stringify({ name, group: this.opts.group }),
    })) as { database?: { Hostname?: string; hostname?: string } };
    const host = created.database?.Hostname ?? created.database?.hostname;
    if (!host) throw new ExternalServiceError("turso", "database creation returned no hostname");
    const tok = (await this.call(`/databases/${name}/auth/tokens?authorization=full-access`, {
      method: "POST",
    })) as { jwt?: string };
    if (!tok.jwt) throw new ExternalServiceError("turso", "token creation returned no jwt");
    return { url: `libsql://${host}`, authToken: tok.jwt };
  }

  destroy(orgId: string): Promise<void> {
    return this.destroyNamed(dbNameForOrg(orgId));
  }

  async destroyNamed(name: string): Promise<void> {
    await this.call(`/databases/${name}`, { method: "DELETE" });
  }

  /** Validate the API token (used by init and doctor). */
  async check(): Promise<void> {
    await this.call("/databases");
  }
}

/** Self-hosted sqld with --enable-namespaces: one namespace per org. Used in tests and by operators. */
export class LibsqlNamespaceProvisioner implements NamedProvisioner {
  readonly kind = "libsql" as const;
  constructor(
    private readonly opts: { adminUrl: string; baseUrl: string; adminToken?: string; fetch?: FetchFn },
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.adminToken) h.authorization = `Bearer ${this.opts.adminToken}`;
    return h;
  }

  urlFor(namespace: string): string {
    const u = new URL(this.opts.baseUrl);
    u.hostname = `${namespace}.${u.hostname === "127.0.0.1" ? "localhost" : u.hostname}`;
    return u.toString().replace(/\/$/, "");
  }

  create(orgId: string): Promise<ProvisionedDb> {
    return this.createNamed(dbNameForOrg(orgId));
  }

  async createNamed(ns: string): Promise<ProvisionedDb> {
    const f = this.opts.fetch ?? fetch;
    const res = await f(`${this.opts.adminUrl}/v1/namespaces/${ns}/create`, {
      method: "POST",
      headers: this.headers(),
      body: "{}",
    });
    if (!res.ok)
      throw new ExternalServiceError("libsql", `namespace create HTTP ${res.status}: ${await res.text()}`);
    return { url: this.urlFor(ns) };
  }

  destroy(orgId: string): Promise<void> {
    return this.destroyNamed(dbNameForOrg(orgId));
  }

  async destroyNamed(ns: string): Promise<void> {
    const f = this.opts.fetch ?? fetch;
    await f(`${this.opts.adminUrl}/v1/namespaces/${ns}`, {
      method: "DELETE",
      headers: this.headers(),
    });
  }
}

export function provisionerFromConfig(cfg: Config, reveal: (v: string) => string | null): OrgProvisioner {
  switch (cfg.database.mode) {
    case "sqlite":
      return new LocalProvisioner(cfg.database.data_dir);
    case "turso":
      return new TursoProvisioner({
        apiUrl: cfg.database.turso_api_url,
        org: cfg.database.turso_org,
        group: cfg.database.turso_group,
        apiToken: reveal(cfg.database.turso_api_token) ?? "",
      });
    case "libsql":
      return new LibsqlNamespaceProvisioner({
        adminUrl: cfg.database.libsql_admin_url,
        baseUrl: cfg.database.libsql_base_url,
        adminToken: reveal(cfg.database.libsql_admin_token) ?? undefined,
      });
  }
}
