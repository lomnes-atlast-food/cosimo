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

export interface StripeOptions {
  methods: PaymentMethodType[];
  account_name: string | null;
  livemode: boolean;
}

export function stripeOptions(s: Pick<SettingsRow, "paymentOptionsJson">): StripeOptions {
  let o: Partial<StripeOptions> = {};
  try {
    o = s.paymentOptionsJson ? (JSON.parse(s.paymentOptionsJson) as Partial<StripeOptions>) : {};
  } catch {
    // unreadable options fall back to the defaults
  }
  const methods = (o.methods ?? ["card"]).filter((m): m is PaymentMethodType =>
    (PAYMENT_METHOD_TYPES as readonly string[]).includes(m),
  );
  return {
    methods: methods.length ? methods : ["card"],
    account_name: o.account_name ?? null,
    livemode: Boolean(o.livemode),
  };
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
