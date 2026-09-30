/**
 * Live Stripe test-mode run (#55). Gated behind COSIMO_TEST_STRIPE=1 with STRIPE_TEST_SECRET_KEY
 * (an sk_test_ or rk_test_ key) from the gitignored .env.local; CI runs only the mocked tests.
 * STRIPE_TEST_LIMITED_KEY, optional, is a restricted test key without Customers: Write, to confirm
 * how Stripe answers the setup check's write probes (#58).
 *
 * The refund, dispute, payout, and cash balance tests confirm the object shapes Cosimo relies on
 * and can't check offline: a dispute's balance transactions (the sign of the amount and the fee)
 * and the cash balance response.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formEncode, HttpStripe, WEBHOOK_EVENTS } from "../src/services/payment-providers/stripe.ts";

// Bun does not read .env.local under `bun test`; load it here (values never override the shell).
const envFile = join(import.meta.dir, "../../../.env.local");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
}

const enabled = process.env.COSIMO_TEST_STRIPE === "1";
const key = process.env.STRIPE_TEST_SECRET_KEY ?? "";
const limitedKey = process.env.STRIPE_TEST_LIMITED_KEY ?? "";

describe.skipIf(!enabled)("Stripe test mode (live)", () => {
  const stripe = new HttpStripe({ secretKey: key });

  test("the key works and is a test-mode key", async () => {
    if (!/^(sk|rk)_test_/.test(key))
      throw new Error("COSIMO_TEST_STRIPE=1 needs a test-mode STRIPE_TEST_SECRET_KEY");
    const a = await stripe.testConnection();
    expect(a.livemode).toBe(false);
    expect(a.accountName.length).toBeGreaterThan(0);
  });

  test("creates a customer and a Checkout session, then reads the session back", async () => {
    const customerId = await stripe.ensureCustomer({
      id: `sandbox-${Date.now()}`,
      name: "Sandbox Customer",
      email: "sandbox@example.com",
    });
    expect(customerId).toStartWith("cus_");
    const s = await stripe.createSession({
      orgId: "org_sandbox",
      invoice: { id: `inv_${Date.now()}`, number: "INV-SANDBOX" },
      amount: 1_234,
      currency: "USD",
      customerId,
      methods: ["card", "us_bank_account", "customer_balance"],
      successUrl: "https://books.example.com/pay/org/token?return=success",
      cancelUrl: "https://books.example.com/pay/org/token?return=cancel",
      idempotencyKey: `cosimo-sandbox-${Date.now()}`,
    });
    expect(s.id).toStartWith("cs_test_");
    expect(s.url).toStartWith("https://checkout.stripe.com/");
    const r = await stripe.getSession(s.id);
    expect(r).toMatchObject({ kind: "open", sessionId: s.id });
  });

  test("registers and deletes a webhook endpoint", async () => {
    const w = await stripe.registerWebhook(
      `https://books.example.com/api/v1/webhooks/payments/stripe/sandbox-${Date.now()}`,
    );
    expect(w.id).toStartWith("we_");
    expect(w.secret).toStartWith("whsec_");
    await stripe.deleteWebhook(w.id);
  });

  test("setup check: a write probe with the permission is a 400, so it reads as present", async () => {
    const r = await stripe.checkSetup(["card"]);
    for (const p of r.permissions) expect({ name: p.name, ok: p.ok }).toEqual({ name: p.name, ok: true });
  });

  test.skipIf(!limitedKey)(
    "setup check: without Customers: Write the probe is a 403 and reads as missing",
    async () => {
      const r = await new HttpStripe({ secretKey: limitedKey }).checkSetup(["card"]);
      expect(r.permissions.find((p) => p.name === "Customers: Write")).toMatchObject({ ok: false });
    },
  );

  test("setup check: the account's capabilities give each method's status", async () => {
    const r = await stripe.checkSetup(["card", "us_bank_account", "customer_balance"]);
    for (const m of r.methods) expect(["active", "inactive", "pending", "unknown"]).toContain(m.status);
    // A full secret key can read the account, so card (always on in test mode) is known.
    if (/^sk_/.test(key)) expect(r.methods[0]).toMatchObject({ type: "card", status: "active" });
  });

  test("updates a registered endpoint's events, and the setup check sees them", async () => {
    const url = `https://books.example.com/api/v1/webhooks/payments/stripe/sandbox-${Date.now()}`;
    const w = await stripe.registerWebhook(url);
    try {
      await stripe.updateWebhook(w.id, WEBHOOK_EVENTS.slice(0, 2));
      expect((await stripe.checkSetup(["card"], url)).missingEvents).toContain("charge.updated");
      await stripe.updateWebhook(w.id, WEBHOOK_EVENTS);
      expect((await stripe.checkSetup(["card"], url)).missingEvents).toEqual([]);
    } finally {
      await stripe.deleteWebhook(w.id);
    }
  });

  /** A request the provider interface doesn't make: creating test payments, refunds. */
  async function raw(path: string, body: Record<string, unknown>) {
    const res = await fetch(`https://api.stripe.com${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/x-www-form-urlencoded",
        "stripe-version": "2024-06-20",
      },
      body: formEncode(body),
    });
    const data = (await res.json()) as Record<string, any>;
    if (!res.ok) throw new Error(`Stripe ${res.status}: ${data.error?.message}`);
    return data;
  }
  const pay = (paymentMethod: string, amount: number) =>
    raw("/v1/payment_intents", {
      amount,
      currency: "usd",
      payment_method: paymentMethod,
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    });

  test("a partial refund is listed for its payment with its amount and status", async () => {
    const pi = await pay("pm_card_visa", 1_000);
    await raw("/v1/refunds", { payment_intent: pi.id, amount: 300 });
    const refunds = await stripe.getRefundsForPayment(pi.id);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ paymentIntentId: pi.id, amount: 300, status: "succeeded" });
    const recent = await stripe.listRefunds({ since: new Date(Date.now() - 3_600_000) });
    expect(recent.some((r) => r.id === refunds[0]!.id)).toBe(true);
  });

  test("a disputed payment's balance transaction takes the amount (negative) and charges the fee (positive)", async () => {
    // Stripe opens a dispute on this test card's charge right away.
    const pi = await pay("pm_card_createDispute", 1_000);
    let movements: Awaited<ReturnType<typeof stripe.listDisputes>> = [];
    for (let i = 0; i < 20 && !movements.length; i++) {
      await Bun.sleep(1_000);
      movements = (await stripe.listDisputes({ since: new Date(Date.now() - 3_600_000) })).filter(
        (m) => m.paymentIntentId === pi.id,
      );
    }
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ kind: "withdrawal", amount: 1_000 });
    expect(movements[0]!.fee).toBeGreaterThan(0);
    expect(await stripe.getDispute(movements[0]!.disputeId)).toEqual(movements);
  });

  test("payouts list, and a customer's cash balance reads as zero cents", async () => {
    const payouts = await stripe.listPayouts({
      since: new Date(Date.now() - 30 * 86_400_000),
      status: "paid",
    });
    for (const p of payouts)
      expect(p).toMatchObject({ status: "paid", arrivalDate: expect.stringMatching(/^\d{4}-/) });
    const customerId = await stripe.ensureCustomer({
      id: `sandbox-cash-${Date.now()}`,
      name: "Sandbox Cash Customer",
      email: null,
    });
    expect(await stripe.getCashBalance(customerId, "USD")).toBe(0);
  });

  test("setup check: the key can read refunds, disputes, payouts, and cash balances", async () => {
    const r = await stripe.checkSetup(["card", "customer_balance"]);
    const byName = Object.fromEntries(r.permissions.map((p) => [p.name, p.ok]));
    for (const name of ["Refunds: Read", "Disputes: Read", "Payouts: Read", "Cash balances: Read"])
      expect({ name, ok: byName[name] }).toEqual({ name, ok: true });
  });
});
