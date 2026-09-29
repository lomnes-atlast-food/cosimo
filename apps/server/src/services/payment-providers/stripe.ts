/**
 * Stripe as a payment provider (#55): Checkout Sessions in the org's own Stripe account, over plain
 * fetch with form encoding. No Stripe SDK and no Stripe.js: customers are redirected to Checkout.
 * Tests replace the client through `setStripeFactory` with a scripted fake.
 */
import { createHmac } from "node:crypto";
import { safeEqual } from "../../crypto.ts";
import {
  type CreateSessionInput,
  type PaymentProvider,
  type ProviderAccount,
  ProviderError,
  type ProviderEvent,
  type ProviderSession,
  type SessionResult,
  WebhookSignatureError,
} from "./types.ts";

export interface StripeCredentials {
  secretKey: string;
  /** The endpoint's signing secret (whsec_...), when webhooks are set up. */
  webhookSecret?: string | null;
}

const API = "https://api.stripe.com";
/** Stripe's default signature tolerance: reject events signed more than five minutes away from now. */
export const WEBHOOK_TOLERANCE_S = 300;

/** Events Cosimo asks Stripe to send. The last three are stored for later processing. */
export const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "charge.refunded",
  "charge.dispute.created",
  "payout.paid",
] as const;
const UNHANDLED_EVENTS = new Set(["charge.refunded", "charge.dispute.created", "payout.paid"]);

/**
 * Check a key's shape: a secret (`sk_`) or restricted (`rk_`) key, test or live. Returns an error
 * message for a publishable key or anything else, or null when the shape is right.
 */
export function stripeKeyProblem(key: string): string | null {
  if (/^pk_/.test(key))
    return "That is a publishable key (pk_...). Cosimo needs a secret or restricted key (sk_... or rk_...).";
  if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/.test(key))
    return "That doesn't look like a Stripe secret or restricted key (sk_test_..., rk_live_..., and so on).";
  return null;
}

export function stripeKeyLivemode(key: string): boolean {
  return /^(sk|rk)_live_/.test(key);
}

/** Flatten a nested object into Stripe's form encoding: `a[b][0][c]=v`. */
export function formEncode(body: Record<string, unknown>): string {
  const out: string[] = [];
  const walk = (prefix: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) for (const [i, x] of v.entries()) walk(`${prefix}[${i}]`, x);
    else if (typeof v === "object")
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(`${prefix}[${k}]`, x);
    else out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(body)) walk(k, v);
  return out.join("&");
}

/** HMAC-SHA256 signature Stripe puts in `Stripe-Signature` (`t=...,v1=...`). Exported for tests. */
export function stripeSignature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
}

/**
 * Verify a Stripe webhook signature and parse the event. Accepts any `v1` signature (Stripe sends
 * several while a secret is being rolled) made with `secret` within the tolerance.
 */
export function verifyStripeWebhook(
  secret: string | null | undefined,
  header: string | undefined,
  rawBody: string,
  now = Date.now(),
): ProviderEvent {
  if (!secret) throw new WebhookSignatureError("No webhook signing secret is configured.");
  if (!header) throw new WebhookSignatureError("Missing Stripe-Signature header.");
  let t: number | null = null;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=", 2);
    if (k === "t" && v && /^\d+$/.test(v)) t = Number(v);
    else if (k === "v1" && v) sigs.push(v);
  }
  if (t === null || !sigs.length) throw new WebhookSignatureError("Malformed Stripe-Signature header.");
  if (Math.abs(now / 1000 - t) > WEBHOOK_TOLERANCE_S)
    throw new WebhookSignatureError("The webhook timestamp is outside the tolerance.");
  const expected = stripeSignature(secret, t, rawBody);
  if (!sigs.some((s) => safeEqual(s, expected)))
    throw new WebhookSignatureError("The webhook signature does not match.");
  return parseStripeEvent(rawBody);
}

export function parseStripeEvent(rawBody: string): ProviderEvent {
  let e: { id?: unknown; type?: unknown; data?: { object?: { id?: unknown } } };
  try {
    e = JSON.parse(rawBody);
  } catch {
    throw new WebhookSignatureError("The webhook body is not JSON.");
  }
  const id = typeof e.id === "string" ? e.id : "";
  const type = typeof e.type === "string" ? e.type : "";
  if (!id || !type) throw new WebhookSignatureError("The webhook body is not a Stripe event.");
  const objectId = typeof e.data?.object?.id === "string" ? e.data.object.id : "";
  if (type.startsWith("checkout.session.") && objectId)
    return { id, type, kind: "session", sessionId: objectId };
  if ((type === "payment_intent.succeeded" || type === "payment_intent.payment_failed") && objectId)
    return { id, type, kind: "payment_intent", paymentIntentId: objectId };
  if (UNHANDLED_EVENTS.has(type)) return { id, type, kind: "unhandled" };
  return { id, type, kind: "ignored" };
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const utcDate = (unix: number | null) =>
  new Date((unix ?? Date.now() / 1000) * 1000).toISOString().slice(0, 10);

/** Map a Checkout Session (with the payment intent, charge, and balance transaction expanded). */
export function sessionResult(s: Obj): SessionResult {
  const sessionId = str(s.id) ?? "";
  const invoiceId = str(obj(s.metadata)?.invoice_id) ?? str(s.client_reference_id);
  if (s.status === "expired") return { kind: "expired", sessionId, invoiceId };
  const pi = obj(s.payment_intent);
  if (s.status === "complete" && s.payment_status === "paid") {
    const charge = obj(pi?.latest_charge);
    const bt = obj(charge?.balance_transaction);
    const details = obj(charge?.payment_method_details);
    return {
      kind: "payment_succeeded",
      sessionId,
      invoiceId,
      customerId: str(s.customer) ?? str(obj(s.customer)?.id),
      paymentId: str(pi?.id) ?? str(s.payment_intent) ?? sessionId,
      gross: num(pi?.amount_received) || num(s.amount_total) || 0,
      currency: (str(pi?.currency) ?? str(s.currency) ?? "usd").toUpperCase(),
      fee: bt ? num(bt.fee) : null,
      balanceTxnId: bt ? str(bt.id) : str(charge?.balance_transaction),
      methodType: str(details?.type) ?? str((pi?.payment_method_types as unknown[] | undefined)?.[0]),
      paidAt: utcDate(num(charge?.created) ?? num(pi?.created)),
    };
  }
  if (s.status === "complete") {
    // Bank debits and transfers complete the session before the money arrives.
    const st = str(pi?.status);
    if (st === "requires_payment_method" || st === "canceled")
      return { kind: "payment_failed", sessionId, invoiceId };
    return { kind: "payment_processing", sessionId, invoiceId };
  }
  return { kind: "open", sessionId, invoiceId, url: str(s.url) };
}

export class HttpStripe implements PaymentProvider {
  readonly name = "stripe" as const;
  constructor(
    private readonly creds: StripeCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T = Obj>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.creds.secretKey}`,
      "stripe-version": "2024-06-20",
    };
    let url = `${API}${path}`;
    let payload: string | undefined;
    if (body && method === "GET") url += `${path.includes("?") ? "&" : "?"}${formEncode(body)}`;
    else if (body) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      payload = formEncode(body);
    }
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new ProviderError(`Could not reach Stripe: ${(e as Error).message}`, 0, "network_error");
    }
    const data = (await res.json().catch(() => ({}))) as Obj;
    if (!res.ok) {
      const err = obj(data.error);
      throw new ProviderError(
        `Stripe: ${str(err?.message) ?? `HTTP ${res.status}`}`,
        res.status,
        str(err?.code) ?? str(err?.type) ?? undefined,
      );
    }
    return data as T;
  }

  async testConnection(): Promise<ProviderAccount> {
    const livemode = stripeKeyLivemode(this.creds.secretKey);
    try {
      const a = await this.call("GET", "/v1/account");
      const name =
        str(obj(obj(a.settings)?.dashboard)?.display_name) ??
        str(obj(a.business_profile)?.name) ??
        str(a.email) ??
        str(a.id) ??
        "Stripe account";
      return { accountName: name, livemode };
    } catch (e) {
      // Restricted keys may not read the account; any call the key does need proves it works.
      if (!(e instanceof ProviderError) || e.status !== 403) throw e;
      await this.call("GET", "/v1/customers", { limit: 1 });
      return { accountName: "Stripe account", livemode };
    }
  }

  async ensureCustomer(contact: { id: string; name: string; email: string | null }) {
    const c = await this.call(
      "POST",
      "/v1/customers",
      { name: contact.name, email: contact.email ?? undefined, metadata: { cosimo_contact_id: contact.id } },
      `cosimo-customer-${contact.id}`,
    );
    return str(c.id)!;
  }

  async createSession(i: CreateSessionInput): Promise<ProviderSession> {
    const metadata = { org_id: i.orgId, invoice_id: i.invoice.id, invoice_number: i.invoice.number };
    const body: Record<string, unknown> = {
      mode: "payment",
      customer: i.customerId,
      client_reference_id: i.invoice.id,
      success_url: i.successUrl,
      cancel_url: i.cancelUrl,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: i.currency.toLowerCase(),
            unit_amount: i.amount,
            product_data: { name: `Invoice ${i.invoice.number}` },
          },
        },
      ],
      payment_method_types: i.methods,
      metadata,
      payment_intent_data: { metadata },
    };
    if (i.methods.includes("customer_balance"))
      body.payment_method_options = {
        customer_balance: { funding_type: "bank_transfer", bank_transfer: { type: "us_bank_transfer" } },
      };
    const s = await this.call("POST", "/v1/checkout/sessions", body, i.idempotencyKey);
    return {
      id: str(s.id)!,
      url: str(s.url)!,
      expiresAt: new Date((num(s.expires_at) ?? Date.now() / 1000 + 86_400) * 1000).toISOString(),
    };
  }

  async getSession(id: string) {
    const s = await this.call("GET", `/v1/checkout/sessions/${encodeURIComponent(id)}`, {
      expand: ["payment_intent.latest_charge.balance_transaction"],
    });
    return sessionResult(s);
  }

  async expireSession(id: string) {
    await this.call("POST", `/v1/checkout/sessions/${encodeURIComponent(id)}/expire`);
  }

  async sessionForPaymentIntent(paymentIntentId: string) {
    const r = await this.call("GET", "/v1/checkout/sessions", { payment_intent: paymentIntentId, limit: 1 });
    const first = obj((r.data as unknown[] | undefined)?.[0]);
    return str(first?.id);
  }

  async paymentFee(paymentId: string) {
    const pi = await this.call("GET", `/v1/payment_intents/${encodeURIComponent(paymentId)}`, {
      expand: ["latest_charge.balance_transaction"],
    });
    const bt = obj(obj(pi.latest_charge)?.balance_transaction);
    const fee = num(bt?.fee);
    return bt && fee !== null ? { fee, balanceTxnId: str(bt.id) ?? "" } : null;
  }

  async fetchEvent(eventId: string) {
    const e = await this.call("GET", `/v1/events/${encodeURIComponent(eventId)}`);
    return parseStripeEvent(JSON.stringify(e));
  }

  verifyWebhook(signature: string | undefined, rawBody: string, now?: number) {
    return verifyStripeWebhook(this.creds.webhookSecret, signature, rawBody, now);
  }

  async registerWebhook(url: string) {
    const w = await this.call("POST", "/v1/webhook_endpoints", {
      url,
      enabled_events: [...WEBHOOK_EVENTS],
      description: "Cosimo online invoice payments",
    });
    return { id: str(w.id)!, secret: str(w.secret)! };
  }

  async deleteWebhook(id: string) {
    await this.call("DELETE", `/v1/webhook_endpoints/${encodeURIComponent(id)}`);
  }
}

type Factory = (creds: StripeCredentials, fetchImpl?: typeof fetch) => PaymentProvider;
let factory: Factory = (creds, fetchImpl) => new HttpStripe(creds, fetchImpl);

export function stripeClient(creds: StripeCredentials, fetchImpl?: typeof fetch): PaymentProvider {
  return factory(creds, fetchImpl);
}

/** Tests: swap the client implementation. Returns a restore function. */
export function setStripeFactory(f: Factory): () => void {
  const prev = factory;
  factory = f;
  return () => {
    factory = prev;
  };
}
