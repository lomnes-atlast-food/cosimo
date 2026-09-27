import { connectSystem, migrateSystem } from "@cosimo/db";
import { VERSION } from "@cosimo/shared";
import type { Config } from "./config.ts";
import { SecretBox } from "./crypto.ts";
import { RateLimiter } from "./http/ratelimit.ts";
import { createLogger, type Logger } from "./logger.ts";
import { OrgService } from "./services/orgs.ts";
import { type OrgProvisioner, provisionerFromConfig } from "./services/provisioning.ts";
import { InstanceSettings } from "./services/settings.ts";
import type { SystemHandle } from "./services/types.ts";
import { UserService } from "./services/users.ts";

export interface AppContext {
  config: Config;
  configPath: string;
  version: string;
  secrets: SecretBox;
  system: SystemHandle;
  orgs: OrgService;
  users: UserService;
  settings: InstanceSettings;
  logger: Logger;
  rateLimiter: RateLimiter;
  /** Extension points filled by later modules (mail, storage, plaid, scheduler). */
  services: Record<string, unknown>;
  close(): Promise<void>;
}

export interface CreateContextOptions {
  configPath?: string;
  logger?: Logger;
  provisioner?: OrgProvisioner;
  migrate?: boolean;
  env?: Record<string, string | undefined>;
}

export type ContextPlugin = (ctx: AppContext) => void | Promise<void>;
const plugins: ContextPlugin[] = [];
/** Modules register plugins to attach services and org seeders. */
export function registerContextPlugin(p: ContextPlugin) {
  plugins.push(p);
}

export async function createContext(config: Config, opts: CreateContextOptions = {}): Promise<AppContext> {
  if (!config.security.master_key) {
    throw new Error("No master key configured. Run `cosimo init` or set COSIMO_MASTER_KEY.");
  }
  const secrets = new SecretBox(config.security.master_key);
  const logger = opts.logger ?? createLogger();
  const system = connectSystem(
    config.database.system_url,
    secrets.reveal(config.database.system_auth_token) ?? undefined,
  );
  if (opts.migrate !== false) await migrateSystem(system.client);
  const provisioner = opts.provisioner ?? provisionerFromConfig(config, (v) => secrets.reveal(v));
  const orgs = new OrgService(system, provisioner, secrets);
  const ctx: AppContext = {
    config,
    configPath: opts.configPath ?? "",
    version: VERSION,
    secrets,
    system,
    orgs,
    users: new UserService(system, secrets),
    settings: new InstanceSettings(system, secrets, opts.env ?? process.env),
    logger,
    rateLimiter: new RateLimiter(),
    services: {},
    async close() {
      for (const s of Object.values(ctx.services)) {
        const stop = (s as { stop?: () => unknown })?.stop;
        if (typeof stop === "function") await stop.call(s);
      }
      orgs.closeAll();
      system.close();
    },
  };
  for (const p of plugins) await p(ctx);
  return ctx;
}
