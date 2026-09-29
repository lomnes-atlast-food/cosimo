/**
 * Stripe as a payment provider (#55): Checkout Sessions in the org's own Stripe account, over plain
 * fetch with form encoding. No Stripe SDK and no Stripe.js: customers are redirected to Checkout.
 * Tests replace the client through `setStripeFactory` with a scripted fake.
 */
import { createHmac } from "node:crypto";
import { safeEqual } from "../../crypto.ts";
import {
  type CreateSessionInput,
  type MethodStatus,
  type PaymentMethodType,
  type PaymentProvider,
  type PermissionCheck,
  type ProviderAccount,
  ProviderError,
  type ProviderEvent,
  type ProviderSession,
  type SessionResult,
  type SetupCheck,
  scrubProviderText,
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
  "charge.updated",
  "charge.refunded",
  "charge.dispute.created",
  "payout.paid",
] as const;
/**
 * Bumped whenever WEBHOOK_EVENTS changes, so endpoints registered by an older release are brought
 * up to date. 1 was the list without `charge.updated`.
 */
export const WEBHOOK_EVENTS_VERSION = 2;
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
  let e: {
    id?: unknown;
    type?: unknown;
    data?: { object?: { id?: unknown; payment_intent?: unknown; balance_transaction?: unknown } };
  };
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
  if (type === "charge.updated") {
    // Stripe sends it about two seconds after the payment, once the fee (balance transaction) exists.
    const o = e.data?.object;
    const idOf = (v: unknown) =>
      typeof v === "string" ? v : typeof obj(v)?.id === "string" ? (obj(v)!.id as string) : "";
    const paymentIntentId = idOf(o?.payment_intent);
    const balanceTxnId = idOf(o?.balance_transaction);
    if (objectId && paymentIntentId && balanceTxnId)
      return { id, type, kind: "charge", chargeId: objectId, paymentIntentId, balanceTxnId };
    return { id, type, kind: "ignored" };
  }
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

/** The permissions Cosimo uses, as the Stripe dashboard names them, and a request that needs each. */
const READ_PROBES: [string, string][] = [
  ["Customers: Read", "/v1/customers"],
  ["PaymentIntents: Read", "/v1/payment_intents"],
  ["Charges: Read", "/v1/charges"],
  ["Balance transactions: Read", "/v1/balance_transactions"],
  ["Events: Read", "/v1/events"],
];
const WRITE_PROBES: [string, string][] = [
  ["Customers: Write", "/v1/customers"],
  ["Checkout Sessions: Write", "/v1/checkout/sessions"],
  ["Webhook Endpoints: Write", "/v1/webhook_endpoints"],
];
export const WEBHOOK_WRITE_PERMISSION = "Webhook Endpoints: Write";

/** The account capability behind each payment method type. */
const METHOD_CAPABILITY: Record<PaymentMethodType, string> = {
  card: "card_payments",
  us_bank_account: "us_bank_account_ach_payments",
  customer_balance: "bank_transfer_payments",
};

const couldNotCheck = (e: unknown) =>
  `Couldn't check: ${e instanceof ProviderError ? e.message : scrubProviderText(String((e as Error)?.message ?? e))}`;

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
      throw new ProviderError(
        `Could not reach Stripe: ${scrubProviderText((e as Error).message)}`,
        0,
        "network_error",
      );
    }
    const data = (await res.json().catch(() => ({}))) as Obj;
    if (!res.ok) {
      const err = obj(data.error);
      throw new ProviderError(
        `Stripe: ${scrubProviderText(str(err?.message) ?? `HTTP ${res.status}`)}`,
        res.status,
        str(err?.code) ?? str(err?.type) ?? undefined,
        str(err?.param) ?? undefined,
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

  async checkSetup(methods: PaymentMethodType[], webhookUrl?: string | null): Promise<SetupCheck> {
    const permissions = await Promise.all([
      ...READ_PROBES.map(([name, path]) => this.probeRead(name, path)),
      ...WRITE_PROBES.map(([name, path]) => this.probeWrite(name, path)),
    ]);
    return {
      permissions,
      methods: await this.methodStatuses(methods),
      missingEvents: webhookUrl ? await this.missingEvents(webhookUrl) : null,
    };
  }

  private async probeRead(name: string, path: string): Promise<PermissionCheck> {
    try {
      await this.call("GET", path, { limit: 1 });
      return { name, ok: true, detail: null };
    } catch (e) {
      if (e instanceof ProviderError && e.status === 403) return { name, ok: false, detail: e.message };
      return { name, ok: null, detail: couldNotCheck(e) };
    }
  }

  /**
   * A write probe sends only an unknown parameter, so it can't create anything: Stripe answers 403
   * when the key lacks the permission and 400 (unknown parameter) when it has it. Any other answer
   * means Cosimo can't tell.
   */
  private async probeWrite(name: string, path: string): Promise<PermissionCheck> {
    try {
      await this.call("POST", path, { cosimo_permission_check: 1 });
      return { name, ok: null, detail: "Stripe accepted the check request, so the result is unknown." };
    } catch (e) {
      if (e instanceof ProviderError && e.status === 403 && e.code === "more_permissions_required")
        return { name, ok: false, detail: e.message };
      if (e instanceof ProviderError && e.status === 400) return { name, ok: true, detail: null };
      return { name, ok: null, detail: couldNotCheck(e) };
    }
  }

  /** Each method's account capability. Account: Read is optional; without it every method is unknown. */
  private async methodStatuses(methods: PaymentMethodType[]): Promise<SetupCheck["methods"]> {
    let caps: Obj | null = null;
    let detail: string | null = null;
    try {
      caps = obj((await this.call("GET", "/v1/account")).capabilities);
      if (!caps) detail = "Stripe didn't report the account's capabilities.";
    } catch (e) {
      detail =
        e instanceof ProviderError && e.status === 403
          ? "Add Account: Read to the key to let Cosimo check payment methods."
          : couldNotCheck(e);
    }
    return methods.map((type) => {
      const v = str(caps?.[METHOD_CAPABILITY[type]]);
      const status: MethodStatus = v === "active" || v === "inactive" || v === "pending" ? v : "unknown";
      return {
        type,
        status,
        detail: status === "unknown" ? (detail ?? "Stripe didn't report this method's status.") : null,
      };
    });
  }

  /** The events the endpoint at `url` doesn't send, or null when there is none or it can't be read. */
  private async missingEvents(url: string): Promise<string[] | null> {
    try {
      const r = await this.call("GET", "/v1/webhook_endpoints", { limit: 100 });
      const ep = ((r.data as unknown[] | undefined) ?? []).map(obj).find((w) => str(w?.url) === url);
      if (!ep) return null;
      const enabled = new Set(((ep.enabled_events as unknown[] | undefined) ?? []).map(String));
      if (enabled.has("*")) return [];
      return WEBHOOK_EVENTS.filter((e) => !enabled.has(e));
    } catch {
      return null;
    }
  }

  async ensureCustomer(contact: { id: string; name: string; email: string | null }, idempotencyKey?: string) {
    const c = await this.call(
      "POST",
      "/v1/customers",
      { name: contact.name, email: contact.email ?? undefined, metadata: { cosimo_contact_id: contact.id } },
      idempotencyKey ?? `cosimo-customer-${contact.id}`,
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

  async updateWebhook(id: string, events: readonly string[]) {
    await this.call("POST", `/v1/webhook_endpoints/${encodeURIComponent(id)}`, {
      enabled_events: [...events],
    });
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
