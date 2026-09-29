import { describe, expect, test } from "bun:test";
import { ProviderError, WebhookSignatureError } from "../src/services/payment-providers/index.ts";
import {
  formEncode,
  HttpStripe,
  parseStripeEvent,
  sessionResult,
  stripeKeyProblem,
  stripeSignature,
  verifyStripeWebhook,
} from "../src/services/payment-providers/stripe.ts";

const KEY = `${"sk_"}test_abcdefghijklmnopqrstuvwxyz`;
const SECRET = `${"whsec_"}unittestsecret0123456789`;

describe("Stripe keys", () => {
  test("secret and restricted keys pass; publishable keys and junk don't", () => {
    expect(stripeKeyProblem(KEY)).toBeNull();
    expect(stripeKeyProblem(`${"rk_"}live_abcdefghijklmnopqrstuvwxyz`)).toBeNull();
    expect(stripeKeyProblem(`${"pk_"}test_abcdefghijklmnopqrstuvwxyz`)).toContain("publishable");
    expect(stripeKeyProblem(`${"sk_"}prod_abcdefghijklmnop`)).not.toBeNull();
    expect(stripeKeyProblem("")).not.toBeNull();
  });
});

describe("Stripe webhook signatures", () => {
  const body = JSON.stringify({
    id: "evt_1",
    type: "checkout.session.completed",
    data: { object: { id: "cs_1" } },
  });
  const now = 1_790_000_000_000;
  const t = now / 1000;
  const header = (secret = SECRET, at = t, raw = body) => `t=${at},v1=${stripeSignature(secret, at, raw)}`;

  test("a valid signature parses the event", () => {
    expect(verifyStripeWebhook(SECRET, header(), body, now)).toEqual({
      id: "evt_1",
      type: "checkout.session.completed",
      kind: "session",
      sessionId: "cs_1",
    });
    // Any one matching v1 is enough (Stripe sends two while a secret is rolled).
    expect(
      verifyStripeWebhook(SECRET, `t=${t},v1=${"0".repeat(64)},${header().split(",")[1]}`, body, now).id,
    ).toBe("evt_1");
  });

  test("wrong secret, changed body, old timestamp, and bad headers are rejected", () => {
    const bad = [
      () => verifyStripeWebhook(SECRET, header(`${"whsec_"}other`), body, now),
      () => verifyStripeWebhook(SECRET, header(), body.replace("cs_1", "cs_2"), now),
      () => verifyStripeWebhook(SECRET, header(SECRET, t - 301), body, now),
      () => verifyStripeWebhook(SECRET, header(SECRET, t + 301), body, now),
      () => verifyStripeWebhook(SECRET, undefined, body, now),
      () => verifyStripeWebhook(SECRET, "garbage", body, now),
      () => verifyStripeWebhook(SECRET, `t=${t}`, body, now),
      () => verifyStripeWebhook(null, header(), body, now),
    ];
    for (const f of bad) expect(f).toThrow(WebhookSignatureError);
    // Within tolerance is fine.
    expect(verifyStripeWebhook(SECRET, header(SECRET, t - 299), body, now).id).toBe("evt_1");
  });

  test("events map to what Cosimo does with them", () => {
    const ev = (type: string) =>
      parseStripeEvent(JSON.stringify({ id: "e", type, data: { object: { id: "x" } } }));
    expect(ev("payment_intent.succeeded")).toMatchObject({ kind: "payment_intent", paymentIntentId: "x" });
    expect(ev("checkout.session.expired")).toMatchObject({ kind: "session" });
    for (const t of ["charge.refunded", "charge.dispute.created", "payout.paid"])
      expect(ev(t).kind).toBe("unhandled");
    expect(ev("customer.created").kind).toBe("ignored");
  });
});

describe("Checkout session mapping", () => {
  const paid = {
    id: "cs_1",
    status: "complete",
    payment_status: "paid",
    customer: "cus_1",
    metadata: { invoice_id: "inv_1" },
    payment_intent: {
      id: "pi_1",
      amount_received: 12_345,
      currency: "usd",
      status: "succeeded",
      latest_charge: {
        created: 1_790_000_000,
        payment_method_details: { type: "card" },
        balance_transaction: { id: "txn_1", fee: 388 },
      },
    },
  };

  test("paid, processing, failed, expired, open", () => {
    expect(sessionResult(paid)).toEqual({
      kind: "payment_succeeded",
      sessionId: "cs_1",
      invoiceId: "inv_1",
      customerId: "cus_1",
      paymentId: "pi_1",
      gross: 12_345,
      currency: "USD",
      fee: 388,
      balanceTxnId: "txn_1",
      methodType: "card",
      paidAt: "2026-09-21",
    });
    // Bank debit before settlement: the fee isn't known yet.
    const unsettled = sessionResult({
      ...paid,
      payment_intent: {
        ...paid.payment_intent,
        latest_charge: { ...paid.payment_intent.latest_charge, balance_transaction: "txn_2" },
      },
    });
    expect(unsettled).toMatchObject({ kind: "payment_succeeded", fee: null, balanceTxnId: "txn_2" });
    const pi = (status: string) => ({
      ...paid,
      payment_status: "unpaid",
      payment_intent: { id: "pi_1", status },
    });
    expect(sessionResult(pi("processing")).kind).toBe("payment_processing");
    expect(sessionResult(pi("requires_action")).kind).toBe("payment_processing");
    expect(sessionResult(pi("requires_payment_method")).kind).toBe("payment_failed");
    expect(sessionResult({ id: "cs_1", status: "expired" }).kind).toBe("expired");
    expect(
      sessionResult({ id: "cs_1", status: "open", url: "https://checkout.stripe.com/c/x" }),
    ).toMatchObject({
      kind: "open",
      url: "https://checkout.stripe.com/c/x",
    });
  });
});

describe("HttpStripe requests", () => {
  test("form-encodes nested bodies", () => {
    expect(formEncode({ a: 1, b: { c: "x y", d: [{ e: 2 }] }, skip: undefined })).toBe(
      "a=1&b%5Bc%5D=x%20y&b%5Bd%5D%5B0%5D%5Be%5D=2",
    );
  });

  test("creates a session with the org's methods, metadata, and an idempotency key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ id: "cs_9", url: "https://checkout.stripe.com/c/9", expires_at: 1_790_000_000 }),
      );
    }) as unknown as typeof fetch;
    const s = await new HttpStripe({ secretKey: KEY }, fetchImpl).createSession({
      orgId: "org1",
      invoice: { id: "inv1", number: "INV-7" },
      amount: 5_000,
      currency: "USD",
      customerId: "cus_1",
      methods: ["card", "customer_balance"],
      successUrl: "https://books.example.com/pay/org1/tok?return=success",
      cancelUrl: "https://books.example.com/pay/org1/tok?return=cancel",
      idempotencyKey: "k1",
    });
    expect(s).toEqual({
      id: "cs_9",
      url: "https://checkout.stripe.com/c/9",
      expiresAt: new Date(1_790_000_000_000).toISOString(),
    });
    const { url, init } = calls[0]!;
    expect(url).toBe("https://api.stripe.com/v1/checkout/sessions");
    const h = init.headers as Record<string, string>;
    expect(h.authorization).toBe(`Bearer ${KEY}`);
    expect(h["idempotency-key"]).toBe("k1");
    const form = new URLSearchParams(String(init.body));
    expect(form.get("mode")).toBe("payment");
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("5000");
    expect(form.get("line_items[0][price_data][product_data][name]")).toBe("Invoice INV-7");
    expect(form.get("payment_method_types[1]")).toBe("customer_balance");
    expect(form.get("payment_method_options[customer_balance][funding_type]")).toBe("bank_transfer");
    expect(form.get("payment_method_options[customer_balance][bank_transfer][type]")).toBe(
      "us_bank_transfer",
    );
    expect(form.get("metadata[invoice_id]")).toBe("inv1");
    expect(form.get("payment_intent_data[metadata][org_id]")).toBe("org1");
    expect(form.get("client_reference_id")).toBe("inv1");
  });

  test("maps Stripe errors and network failures", async () => {
    const denied = (async () =>
      new Response(
        JSON.stringify({ error: { message: "Invalid API Key provided", type: "invalid_request_error" } }),
        {
          status: 401,
        },
      )) as unknown as typeof fetch;
    const e = await new HttpStripe({ secretKey: KEY }, denied).getSession("cs_1").catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.status).toBe(401);
    expect(e.message).not.toContain(KEY);
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const n = await new HttpStripe({ secretKey: KEY }, down).testConnection().catch((x) => x);
    expect(n).toMatchObject({ status: 0 });
  });
});
