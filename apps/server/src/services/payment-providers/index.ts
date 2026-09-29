/**
 * Payment providers for online invoice payments (#55). Settings are stored provider-agnostically on
 * org_settings: the mode, an encrypted credentials blob, and provider options.
 */
import type { org } from "@cosimo/db";
import type { SecretBox } from "../../crypto.ts";
import { stripeClient } from "./stripe.ts";
import { PAYMENT_METHOD_TYPES, type PaymentMethodType, type PaymentProvider } from "./types.ts";

export * from "./types.ts";

type SettingsRow = typeof org.orgSettings.$inferSelect;

/** Decrypted Stripe credentials. Never returned from the API, logged, exported, or audited. */
export interface StripeSecrets {
  secret_key: string;
  webhook_secret: string | null;
  webhook_endpoint_id: string | null;
}

/** The last setup check (Save, Test connection, or a checkout Stripe rejected a method for). */
export interface StoredSetupCheck {
  checked_at: string;
  /** Permissions the key lacks, as the Stripe dashboard names them. */
  missing: string[];
  /** Methods Stripe reports (or a checkout showed) as not active; left out of checkouts. */
  inactive_methods: PaymentMethodType[];
  /** Methods whose status couldn't be read (the key has no Account: Read). */
  unknown_methods: PaymentMethodType[];
  /** Events the webhook endpoint doesn't send; empty when it sends them all or can't be read. */
  missing_events: string[];
}

export interface StripeOptions {
  methods: PaymentMethodType[];
  account_name: string | null;
  livemode: boolean;
  setup_check: StoredSetupCheck | null;
  /** WEBHOOK_EVENTS_VERSION the registered endpoint was last set to (1 before the field existed). */
  webhook_events_version: number;
}

const isMethod = (m: unknown): m is PaymentMethodType =>
  (PAYMENT_METHOD_TYPES as readonly unknown[]).includes(m);

export function stripeOptions(s: Pick<SettingsRow, "paymentOptionsJson">): StripeOptions {
  let o: Partial<StripeOptions> = {};
  try {
    o = s.paymentOptionsJson ? (JSON.parse(s.paymentOptionsJson) as Partial<StripeOptions>) : {};
  } catch {
    // unreadable options fall back to the defaults
  }
  const methods = (o.methods ?? ["card"]).filter(isMethod);
  const c = o.setup_check;
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    methods: methods.length ? methods : ["card"],
    account_name: o.account_name ?? null,
    livemode: Boolean(o.livemode),
    setup_check:
      c && typeof c === "object"
        ? {
            checked_at: String(c.checked_at ?? ""),
            missing: strings(c.missing),
            inactive_methods: strings(c.inactive_methods).filter(isMethod),
            unknown_methods: strings(c.unknown_methods).filter(isMethod),
            missing_events: strings(c.missing_events),
          }
        : null,
    webhook_events_version: typeof o.webhook_events_version === "number" ? o.webhook_events_version : 1,
  };
}

/** The methods a checkout offers: the chosen ones less any known to be inactive (all, if none remain). */
export function offeredMethods(o: StripeOptions): PaymentMethodType[] {
  const inactive = new Set(o.setup_check?.inactive_methods ?? []);
  const left = o.methods.filter((m) => !inactive.has(m));
  return left.length ? left : o.methods;
}

export function stripeSecrets(secrets: SecretBox, s: Pick<SettingsRow, "paymentCredentialsEnc">) {
  const raw = secrets.reveal(s.paymentCredentialsEnc);
  if (!raw) return null;
  const c = JSON.parse(raw) as Partial<StripeSecrets>;
  if (!c.secret_key) return null;
  return {
    secret_key: c.secret_key,
    webhook_secret: c.webhook_secret ?? null,
    webhook_endpoint_id: c.webhook_endpoint_id ?? null,
  } satisfies StripeSecrets;
}

/** The org's provider client, or null when online payments aren't set up with a provider. */
export function providerFor(
  secrets: SecretBox,
  s: Pick<SettingsRow, "paymentProvider" | "paymentCredentialsEnc">,
  fetchImpl?: typeof fetch,
): PaymentProvider | null {
  if (s.paymentProvider !== "stripe") return null;
  const c = stripeSecrets(secrets, s);
  if (!c) return null;
  return stripeClient({ secretKey: c.secret_key, webhookSecret: c.webhook_secret }, fetchImpl);
}
