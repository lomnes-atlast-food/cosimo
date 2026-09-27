/**
 * Runtime-editable instance settings stored in the system DB (`instance_settings`).
 * Secret fields are encrypted with the master key and never returned by the API.
 * Environment variables COSIMO_SMTP_* / COSIMO_PLAID_* override stored values.
 */
import { system } from "@cosimo/db";
import type { SignupMode } from "@cosimo/shared";
import { eq } from "drizzle-orm";
import type { SecretBox } from "../crypto.ts";
import type { SystemHandle } from "./types.ts";

export interface SmtpSettings {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  secure: boolean;
}

export interface PlaidSettings {
  enabled: boolean;
  env: "sandbox" | "production";
  client_id: string;
  secret: string;
  /** Public HTTPS base URL for Plaid webhooks; defaults to the server's public URL. */
  webhook_url: string;
  /** OAuth redirect URI registered in the Plaid dashboard (needed by some institutions). */
  redirect_uri: string;
}

export interface LastBackup {
  file: string;
  at: string;
  bytes: number;
  destination: "local" | "s3";
  reason: string;
}

export interface InstanceSettingsShape {
  signup_mode: SignupMode;
  last_backup: LastBackup | null;
  dynamic_client_registration: boolean;
  smtp: SmtpSettings;
  plaid: PlaidSettings;
}

const DEFAULTS: InstanceSettingsShape = {
  signup_mode: "single_user",
  last_backup: null,
  dynamic_client_registration: true,
  smtp: { enabled: false, host: "", port: 587, user: "", password: "", from: "", secure: false },
  plaid: { enabled: false, env: "sandbox", client_id: "", secret: "", webhook_url: "", redirect_uri: "" },
};

const SECRET_FIELDS: Record<string, string[]> = { smtp: ["password"], plaid: ["secret"] };

export class InstanceSettings {
  constructor(
    private readonly sys: SystemHandle,
    private readonly secrets: SecretBox,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  private async raw<K extends keyof InstanceSettingsShape>(key: K): Promise<InstanceSettingsShape[K]> {
    const row = await this.sys.db
      .select()
      .from(system.instanceSettings)
      .where(eq(system.instanceSettings.key, key))
      .get();
    const def = structuredClone(DEFAULTS[key]);
    if (!row) return def;
    const v = JSON.parse(row.valueJson);
    if (typeof def === "object" && def !== null) return { ...def, ...v };
    return v;
  }

  private envOverride<T extends object>(section: string, value: T): T {
    const out = { ...value } as Record<string, unknown>;
    for (const k of Object.keys(out)) {
      const e = this.env[`COSIMO_${section}_${k}`.toUpperCase()];
      if (e === undefined) continue;
      const cur = out[k];
      out[k] = typeof cur === "number" ? Number(e) : typeof cur === "boolean" ? /^(1|true|yes)$/i.test(e) : e;
    }
    return out as T;
  }

  async get<K extends keyof InstanceSettingsShape>(key: K): Promise<InstanceSettingsShape[K]> {
    const v = await this.raw(key);
    if (typeof v !== "object" || v === null) {
      const e = this.env[`COSIMO_${key}`.toUpperCase()];
      if (e !== undefined) {
        return (typeof v === "boolean" ? /^(1|true|yes)$/i.test(e) : e) as InstanceSettingsShape[K];
      }
      return v;
    }
    const decrypted = { ...(v as unknown as Record<string, unknown>) };
    for (const f of SECRET_FIELDS[key] ?? []) {
      decrypted[f] = this.secrets.reveal(decrypted[f] as string) ?? "";
    }
    return this.envOverride(key, decrypted) as unknown as InstanceSettingsShape[K];
  }

  /** Merge-update a setting. Secret fields are encrypted; empty-string secrets keep the old value. */
  async set<K extends keyof InstanceSettingsShape>(
    key: K,
    patch: Partial<InstanceSettingsShape[K]> | InstanceSettingsShape[K],
  ) {
    let value: unknown = patch;
    const current = await this.raw(key);
    if (typeof current === "object" && current !== null) {
      const merged = { ...(current as unknown as Record<string, unknown>) };
      for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
        if ((SECRET_FIELDS[key] ?? []).includes(k)) {
          if (typeof v === "string" && v !== "") merged[k] = this.secrets.encrypt(v);
          else if (v === null) merged[k] = "";
        } else if (v !== undefined) {
          merged[k] = v;
        }
      }
      value = merged;
    }
    const valueJson = JSON.stringify(value);
    await this.sys.write((tx) =>
      tx
        .insert(system.instanceSettings)
        .values({ key, valueJson })
        .onConflictDoUpdate({ target: system.instanceSettings.key, set: { valueJson } }),
    );
  }

  /** Public view with secrets masked. */
  async publicView() {
    const smtp = await this.get("smtp");
    const plaid = await this.get("plaid");
    return {
      signup_mode: await this.get("signup_mode"),
      dynamic_client_registration: await this.get("dynamic_client_registration"),
      smtp: { ...smtp, password: undefined, password_set: Boolean(smtp.password) },
      plaid: { ...plaid, secret: undefined, secret_set: Boolean(plaid.secret) },
    };
  }
}
