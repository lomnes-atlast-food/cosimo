import { describe, expect, test } from "bun:test";
import {
  ProviderError,
  scrubProviderText,
  WebhookSignatureError,
} from "../src/services/payment-providers/index.ts";
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
    expect(ev("payout.paid")).toMatchObject({ kind: "payout", payoutId: "x" });
    for (const t of [
      "charge.dispute.created",
      "charge.dispute.funds_withdrawn",
      "charge.dispute.funds_reinstated",
      "charge.dispute.closed",
    ])
      expect(ev(t)).toMatchObject({ kind: "dispute", disputeId: "x" });
    // A refund names the charge; Cosimo needs its payment intent.
    const refunded = (object: Record<string, unknown>) =>
      parseStripeEvent(JSON.stringify({ id: "e", type: "charge.refunded", data: { object } }));
    expect(refunded({ id: "ch_1", payment_intent: "pi_1" })).toMatchObject({
      kind: "refund",
      paymentIntentId: "pi_1",
    });
    expect(refunded({ id: "ch_1", payment_intent: { id: "pi_1" } })).toMatchObject({
      paymentIntentId: "pi_1",
    });
    expect(refunded({ id: "ch_1", payment_intent: null }).kind).toBe("ignored");
    expect(ev("customer.created").kind).toBe("ignored");
  });

  test("charge.updated carries the payment and its balance transaction; without one it is ignored", () => {
    const charge = (object: Record<string, unknown>) =>
      parseStripeEvent(JSON.stringify({ id: "e", type: "charge.updated", data: { object } }));
    expect(charge({ id: "ch_1", payment_intent: "pi_1", balance_transaction: "txn_1" })).toEqual({
      id: "e",
      type: "charge.updated",
      kind: "charge",
      chargeId: "ch_1",
      paymentIntentId: "pi_1",
      balanceTxnId: "txn_1",
    });
    // Expanded objects work too.
    expect(
      charge({ id: "ch_1", payment_intent: { id: "pi_1" }, balance_transaction: { id: "txn_1" } }),
    ).toMatchObject({ kind: "charge", paymentIntentId: "pi_1", balanceTxnId: "txn_1" });
    expect(charge({ id: "ch_1", payment_intent: "pi_1", balance_transaction: null }).kind).toBe("ignored");
    expect(charge({ id: "ch_1", payment_intent: null, balance_transaction: "txn_1" }).kind).toBe("ignored");
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

  test("keeps the rejected parameter and strips account IDs, request IDs, keys, and URLs", async () => {
    const reply = (status: number, error: Record<string, unknown>) =>
      (async () => new Response(JSON.stringify({ error }), { status })) as unknown as typeof fetch;
    const e = await new HttpStripe(
      { secretKey: KEY },
      reply(400, {
        message: "The payment method type provided: customer_balance is invalid.",
        type: "invalid_request_error",
        param: "payment_method_types",
      }),
    )
      .getSession("cs_1")
      .catch((x) => x);
    expect(e).toMatchObject({ status: 400, param: "payment_method_types" });
    const denied = await new HttpStripe(
      { secretKey: KEY },
      reply(403, {
        message:
          "The provided key 'rk_test_*********wxyz' does not have the required permissions for this endpoint on account 'acct_1Example'. Having the 'rak_customer_write' permission would allow this request to continue. See https://docs.example.com/keys; request req_Example123.",
        code: "more_permissions_required",
      }),
    )
      .getSession("cs_1")
      .catch((x) => x);
    expect(denied.code).toBe("more_permissions_required");
    for (const leak of ["acct_1Example", "req_Example123", "https://", "rk_test_"])
      expect(denied.message).not.toContain(leak);
    expect(denied.message).toContain("rak_customer_write");
    expect(scrubProviderText("Invalid API Key provided: sk_test_****abcd")).toBe(
      "Invalid API Key provided: [key]",
    );
    // Shapes of real Stripe messages: a masked key with dots, and links mid-sentence.
    expect(
      scrubProviderText(
        "The provided key 'rk_live_...AB12' does not have the required permissions for this endpoint on account 'acct_1Example'. You can edit permissions at https://dashboard.stripe.com/b/acct_1Example?destination=%2Fapikeys%2Fedit",
      ),
    ).toBe(
      "The provided key '[key]' does not have the required permissions for this endpoint on account '[account]'. You can edit permissions at the Stripe dashboard",
    );
    expect(
      scrubProviderText(
        "The payment method type provided: customer_balance is invalid. Please ensure the provided type is activated in your dashboard (https://dashboard.stripe.com/account/payments/settings). See https://stripe.com/docs/payments/payment-methods/integration-options for supported combinations.",
      ),
    ).toBe(
      "The payment method type provided: customer_balance is invalid. Please ensure the provided type is activated in your dashboard. See Stripe's documentation for supported combinations.",
    );
  });

  test("the setup check reads 403 as missing, a 400 write probe as present, and anything else as unknown", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push(`${init.method} ${path}`);
      const err = (status: number, code: string) =>
        new Response(JSON.stringify({ error: { message: `${code} on acct_1Example`, code } }), { status });
      if (init.method === "GET" && path === "/v1/events") return err(403, "more_permissions_required");
      if (init.method === "GET" && path === "/v1/payouts") return err(403, "more_permissions_required");
      // The cash balance probe reads a customer that doesn't exist: 404 means the key may read it.
      if (path.endsWith("/cash_balance")) return err(404, "resource_missing");
      if (init.method === "POST" && path === "/v1/customers") return err(403, "more_permissions_required");
      if (init.method === "POST" && path === "/v1/checkout/sessions") return err(400, "parameter_unknown");
      if (init.method === "POST" && path === "/v1/webhook_endpoints") return err(500, "api_error");
      if (path === "/v1/account")
        return new Response(
          JSON.stringify({
            capabilities: { card_payments: "active", bank_transfer_payments: "inactive" },
          }),
        );
      if (path === "/v1/webhook_endpoints")
        return new Response(
          JSON.stringify({
            data: [
              { url: "https://books.example.com/other", enabled_events: ["*"] },
              { url: "https://books.example.com/hook", enabled_events: ["checkout.session.completed"] },
            ],
          }),
        );
      return new Response(JSON.stringify({ data: [] }));
    }) as unknown as typeof fetch;
    const r = await new HttpStripe({ secretKey: KEY }, fetchImpl).checkSetup(
      ["card", "us_bank_account", "customer_balance"],
      "https://books.example.com/hook",
    );
    const byName = Object.fromEntries(r.permissions.map((p) => [p.name, p]));
    expect(byName["Customers: Read"]).toMatchObject({ ok: true });
    expect(byName["Events: Read"]).toMatchObject({ ok: false });
    expect(byName["Events: Read"]!.detail).not.toContain("acct_");
    expect(byName["Customers: Write"]).toMatchObject({ ok: false });
    expect(byName["Checkout Sessions: Write"]).toMatchObject({ ok: true });
    expect(byName["Webhook Endpoints: Write"]).toMatchObject({ ok: null });
    expect(byName["Webhook Endpoints: Write"]!.detail).toStartWith("Couldn't check");
    expect(byName["Refunds: Read"]).toMatchObject({ ok: true });
    expect(byName["Disputes: Read"]).toMatchObject({ ok: true });
    expect(byName["Payouts: Read"]).toMatchObject({ ok: false });
    expect(byName["Cash balances: Read"]).toMatchObject({ ok: true });
    expect(r.methods.map((m) => [m.type, m.status])).toEqual([
      ["card", "active"],
      // Not reported by Stripe: unknown rather than a guess.
      ["us_bank_account", "unknown"],
      ["customer_balance", "inactive"],
    ]);
    expect(r.missingEvents).toContain("charge.updated");
    expect(r.missingEvents).not.toContain("checkout.session.completed");
    // The write probes send only the unknown parameter.
    expect(calls).toContain("POST /v1/customers");

    const noAccount = (async (url: string) =>
      new URL(url).pathname === "/v1/account"
        ? new Response(JSON.stringify({ error: { message: "no" } }), { status: 403 })
        : new Response("{}")) as unknown as typeof fetch;
    const r2 = await new HttpStripe({ secretKey: KEY }, noAccount).checkSetup(["card"]);
    // Without bank transfers there's no cash balance to read, so it isn't checked.
    expect(r2.permissions.map((p) => p.name)).not.toContain("Cash balances: Read");
    expect(r2.methods[0]).toMatchObject({ type: "card", status: "unknown" });
    expect(r2.methods[0]!.detail).toContain("Account: Read");
    expect(r2.missingEvents).toBeNull();
  });

  test("reads refunds, dispute movements, payouts, and cash balances, following pages", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      const u = new URL(url);
      calls.push(`${u.pathname}?${u.searchParams.toString()}`);
      const json = (b: unknown) => new Response(JSON.stringify(b));
      if (u.pathname === "/v1/refunds" && !u.searchParams.get("starting_after"))
        return json({
          has_more: true,
          data: [
            { id: "re_1", payment_intent: "pi_1", amount: 500, status: "succeeded", created: 1_773_100_800 },
          ],
        });
      if (u.pathname === "/v1/refunds")
        return json({
          has_more: false,
          data: [
            {
              id: "re_2",
              payment_intent: { id: "pi_2" },
              amount: 700,
              status: "pending",
              created: 1_773_100_800,
            },
          ],
        });
      if (u.pathname === "/v1/disputes/dp_1")
        return json({
          id: "dp_1",
          payment_intent: "pi_1",
          created: 1_773_100_800,
          balance_transactions: [
            { id: "txn_w", amount: -3_000, fee: 1_500, created: 1_773_100_800 },
            { id: "txn_r", amount: 3_000, fee: -1_500, created: 1_778_371_200 },
          ],
        });
      if (u.pathname === "/v1/payouts")
        return json({
          has_more: false,
          data: [{ id: "po_1", amount: 4_852, arrival_date: 1_774_051_200, status: "paid" }],
        });
      if (u.pathname === "/v1/customers/cus_1/cash_balance")
        return json({ object: "cash_balance", available: { usd: 12_500 }, customer: "cus_1" });
      if (u.pathname === "/v1/customers/cus_2/cash_balance")
        return json({ object: "cash_balance", available: null, customer: "cus_2" });
      return json({});
    }) as unknown as typeof fetch;
    const stripe = new HttpStripe({ secretKey: KEY }, fetchImpl);
    const since = new Date(1_773_000_000_000);
    expect(await stripe.listRefunds({ since })).toEqual([
      { id: "re_1", paymentIntentId: "pi_1", amount: 500, status: "succeeded", created: "2026-03-10" },
      { id: "re_2", paymentIntentId: "pi_2", amount: 700, status: "pending", created: "2026-03-10" },
    ]);
    expect(calls[0]).toContain("created%5Bgte%5D=1773000000");
    expect(calls[1]).toContain("starting_after=re_1");
    expect(await stripe.getDispute("dp_1")).toEqual([
      {
        balanceTxnId: "txn_w",
        disputeId: "dp_1",
        paymentIntentId: "pi_1",
        kind: "withdrawal",
        amount: 3_000,
        fee: 1_500,
        created: "2026-03-10",
      },
      {
        balanceTxnId: "txn_r",
        disputeId: "dp_1",
        paymentIntentId: "pi_1",
        kind: "reinstatement",
        amount: 3_000,
        fee: -1_500,
        created: "2026-05-10",
      },
    ]);
    expect(await stripe.listPayouts({ since, status: "paid" })).toEqual([
      { id: "po_1", amount: 4_852, arrivalDate: "2026-03-21", status: "paid" },
    ]);
    expect(calls.find((c) => c.startsWith("/v1/payouts"))).toContain("status=paid");
    expect(await stripe.getCashBalance("cus_1", "USD")).toBe(12_500);
    expect(await stripe.getCashBalance("cus_2", "USD")).toBe(0);
  });

  test("updates a webhook endpoint's events", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response("{}");
    }) as unknown as typeof fetch;
    await new HttpStripe({ secretKey: KEY }, fetchImpl).updateWebhook("we_1", ["a", "charge.updated"]);
    expect(calls[0]!.url).toBe("https://api.stripe.com/v1/webhook_endpoints/we_1");
    expect(new URLSearchParams(calls[0]!.body).get("enabled_events[1]")).toBe("charge.updated");
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
