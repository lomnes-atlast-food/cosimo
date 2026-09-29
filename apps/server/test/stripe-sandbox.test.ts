/**
 * Live Stripe test-mode run (#55). Gated behind COSIMO_TEST_STRIPE=1 with STRIPE_TEST_SECRET_KEY
 * (an sk_test_ or rk_test_ key) from the gitignored .env.local; CI runs only the mocked tests.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpStripe } from "../src/services/payment-providers/stripe.ts";

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
});
