import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { org } from "@cosimo/db";
import { and, eq, sql } from "drizzle-orm";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from "pdf-lib";
import { registeredJobs, type Scheduler } from "../src/jobs/scheduler.ts";
import { readZip } from "../src/services/archive.ts";
import { exportOrgBytes } from "../src/services/export.ts";
import type { Mailer, SentMail } from "../src/services/mailer.ts";
import { payUrl, pollPayments, saveSettings } from "../src/services/online-payments.ts";
import {
  type CreateSessionInput,
  type PaymentProvider,
  ProviderError,
  type ProviderEvent,
  type SessionResult,
} from "../src/services/payment-providers/index.ts";
import {
  type StripeCredentials,
  setStripeFactory,
  stripeSignature,
  verifyStripeWebhook,
} from "../src/services/payment-providers/stripe.ts";
import {
  addMember,
  anon,
  type Client,
  createOrg,
  createTestEnv,
  DB_MODE,
  login,
  type TestEnv,
} from "./harness.ts";

const KEY = `${"sk_"}test_abcdefghijklmnopqrstuvwxyz`;
const WHSEC = `${"whsec_"}fakesigningsecret0123456789`;

type Paid = Extract<SessionResult, { kind: "payment_succeeded" }>;

/** A scripted Stripe: sessions live in memory and tests move them through their states. */
class FakeStripe implements PaymentProvider {
  readonly name = "stripe" as const;
  creds: StripeCredentials = { secretKey: "" };
  created: CreateSessionInput[] = [];
  sessions = new Map<string, SessionResult>();
  events = new Map<string, ProviderEvent>();
  fees = new Map<string, { fee: number; balanceTxnId: string }>();
  webhooks: { id: string; url: string }[] = [];
  deletedWebhooks: string[] = [];
  customers: string[] = [];
  getSessionCalls = 0;
  #n = 0;

  async testConnection() {
    if (this.creds.secretKey.includes("revoked")) throw new ProviderError("Stripe: Invalid API Key", 401);
    return { accountName: "Test Studio", livemode: this.creds.secretKey.includes("_live_") };
  }
  async ensureCustomer(contact: { id: string }) {
    this.customers.push(contact.id);
    return `cus_${contact.id}`;
  }
  async createSession(i: CreateSessionInput) {
    this.created.push(i);
    const id = `cs_test_${++this.#n}`;
    const url = `https://checkout.stripe.test/${id}`;
    this.sessions.set(id, { kind: "open", sessionId: id, invoiceId: i.invoice.id, url });
    return { id, url, expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  }
  async getSession(id: string) {
    this.getSessionCalls++;
    // Yield so concurrent recording paths interleave as they would over the network.
    await Bun.sleep(5);
    const s = this.sessions.get(id);
    if (!s) throw new ProviderError("Stripe: No such checkout.session", 404);
    return s;
  }
  async expireSession(id: string) {
    const s = this.sessions.get(id);
    if (s?.kind !== "open") throw new ProviderError("Stripe: Only open sessions can be expired", 400);
    this.sessions.set(id, { kind: "expired", sessionId: id, invoiceId: s.invoiceId });
  }
  async sessionForPaymentIntent(pi: string) {
    for (const s of this.sessions.values())
      if (s.kind === "payment_succeeded" && s.paymentId === pi) return s.sessionId;
    return null;
  }
  async paymentFee(pi: string) {
    return this.fees.get(pi) ?? null;
  }
  async fetchEvent(id: string) {
    const e = this.events.get(id);
    if (!e) throw new ProviderError("Stripe: No such event", 404);
    return e;
  }
  verifyWebhook(sig: string | undefined, raw: string, now?: number) {
    return verifyStripeWebhook(this.creds.webhookSecret, sig, raw, now);
  }
  async registerWebhook(url: string) {
    const id = `we_${++this.#n}`;
    this.webhooks.push({ id, url });
    return { id, secret: WHSEC };
  }
  async deleteWebhook(id: string) {
    this.deletedWebhooks.push(id);
  }

  /** Move a session to paid. */
  pay(sessionId: string, p: Partial<Paid> & { gross: number }) {
    const cur = this.sessions.get(sessionId)!;
    const paid: Paid = {
      kind: "payment_succeeded",
      sessionId,
      invoiceId: cur.invoiceId,
      customerId: null,
      paymentId: `pi_${sessionId}`,
      currency: "USD",
      fee: null,
      balanceTxnId: null,
      methodType: "card",
      paidAt: new Date().toISOString().slice(0, 10),
      ...p,
    };
    this.sessions.set(sessionId, paid);
    return paid;
  }
  set(sessionId: string, kind: "payment_processing" | "payment_failed" | "expired") {
    const cur = this.sessions.get(sessionId)!;
    this.sessions.set(sessionId, { kind, sessionId, invoiceId: cur.invoiceId });
  }
}

let env: TestEnv;
let owner: Client;
let keeper: Client;
let orgId: string;
let customer: string;
let acct: Record<string, string>;
let mail: SentMail[];
let fake: FakeStripe;
let restore: () => void;
const base = () => `/api/v1/orgs/${orgId}`;

const db = async () => (await env.ctx.orgs.mustOpen(orgId)).db;

async function newInvoice(amount: number, extra: Record<string, unknown> = {}) {
  const r = await owner.json("POST", `${base()}/invoices`, {
    customer_id: customer,
    issue_date: "2026-03-01",
    lines: [{ description: "Design", quantity_milli: 1000, unit_price: amount, account_id: acct["4000"] }],
    ...extra,
  });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body;
}

async function openInvoice(amount: number) {
  const inv = await newInvoice(amount, { online_pay_enabled: true });
  const r = await owner.json("POST", `${base()}/invoices/${inv.id}/finalize`, {});
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return r.body.invoice;
}

async function getInvoice(id: string) {
  return (await owner.json("GET", `${base()}/invoices/${id}`)).body;
}

/** Open a pay link as the customer (no session). */
async function visit(url: string, query = "") {
  const path = new URL(url).pathname;
  return anon(env).req("GET", `${path}${query}`);
}

/** Open the pay link and return the checkout session it redirected to. */
async function checkout(inv: { pay_url: string }) {
  const res = await visit(inv.pay_url);
  expect(res.status).toBe(303);
  const loc = res.headers.get("location")!;
  return loc.slice(loc.lastIndexOf("/") + 1);
}

let evt = 0;
function signed(body: string, secret = WHSEC, at = Math.floor(Date.now() / 1000)) {
  return `t=${at},v1=${stripeSignature(secret, at, body)}`;
}
/** POST a raw body, as Stripe does (the signature covers the exact bytes). */
function deliver(body: string, sig: string | undefined) {
  return env.app.request(`/api/v1/webhooks/payments/stripe/${orgId}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(sig ? { "stripe-signature": sig } : {}) },
    body,
  });
}
async function webhook(type: string, objectId: string, opts: { id?: string } = {}) {
  const id = opts.id ?? `evt_${++evt}`;
  const body = JSON.stringify({ id, type, data: { object: { id: objectId } } });
  return { res: await deliver(body, signed(body)), id };
}

/** Webhooks are processed after the response; wait until every stored event has an outcome. */
async function settle() {
  for (let i = 0; i < 200; i++) {
    const open = await (await db())
      .select({ n: sql<number>`count(*)` })
      .from(org.providerEvents)
      .where(sql`${org.providerEvents.result} is null`)
      .get();
    if (!Number(open?.n)) return;
    await Bun.sleep(10);
  }
  throw new Error("webhook processing did not finish");
}

async function providerPayments(invoiceId: string) {
  return (await db())
    .select()
    .from(org.providerPayments)
    .where(eq(org.providerPayments.invoiceId, invoiceId))
    .all();
}

async function postedBalance(accountId: string) {
  const r = await (await db())
    .select({ total: sql<number>`coalesce(sum(${org.journalLines.amount}), 0)` })
    .from(org.journalLines)
    .innerJoin(org.journalEntries, eq(org.journalEntries.id, org.journalLines.entryId))
    .where(and(eq(org.journalLines.accountId, accountId), eq(org.journalEntries.status, "posted")))
    .get();
  return Number(r?.total ?? 0);
}

async function setUpStripe(body: Record<string, unknown> = {}) {
  const r = await owner.json("PUT", `${base()}/online-payments`, {
    provider: "stripe",
    secret_key: KEY,
    methods: ["card", "us_bank_account"],
    ...body,
  });
  expect(r.status).toBe(200);
  return r.body;
}

beforeAll(async () => {
  fake = new FakeStripe();
  restore = setStripeFactory((creds) => {
    fake.creds = creds;
    return fake;
  });
  env = await createTestEnv({ configure: (c) => (c.server.public_url = "https://books.example.com") });
  mail = (env.ctx.services.mailer as Mailer).useTestTransport();
  owner = await login(env, "pay-owner@example.com");
  keeper = await login(env, "pay-keeper@example.com");
  orgId = await createOrg(env, owner, "Pay Co", { basis: "accrual" });
  await addMember(env, orgId, keeper.userId, "bookkeeper");
  const r = await owner.json("GET", `${base()}/accounts`);
  acct = Object.fromEntries(r.body.data.map((a: any) => [a.code, a.id]));
  customer = (
    await owner.json("POST", `${base()}/contacts`, {
      kind: "customer",
      name: "Globex",
      email: "ap@globex.test",
    })
  ).body.id;
});
afterAll(async () => {
  restore();
  await env.close();
});
beforeEach(() => env.ctx.rateLimiter.reset());

describe(`online payment settings (${DB_MODE})`, () => {
  test("off by default, and bookkeepers can't read or change the settings", async () => {
    const g = await owner.json("GET", `${base()}/online-payments`);
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ provider: "off", secret_key_set: false, webhook_mode: null });
    expect((await keeper.json("GET", `${base()}/online-payments`)).status).toBe(403);
    expect(
      (await keeper.json("PUT", `${base()}/online-payments`, { provider: "stripe", secret_key: KEY })).status,
    ).toBe(403);
  });

  test("AI assistants are rejected even with the owner role", async () => {
    const mcp = { actor: "mcp" as const, role: "owner" as const, userId: owner.userId, proposeOnly: true };
    await expect(saveSettings(env.ctx, orgId, mcp, { provider: "off" })).rejects.toThrow(/AI assistants/);
  });

  test("publishable and malformed keys are rejected before anything is stored", async () => {
    const pk = await owner.json("PUT", `${base()}/online-payments`, {
      provider: "stripe",
      secret_key: `${"pk_"}test_abcdefghijklmnopqrstuvwxyz`,
    });
    expect(pk.status).toBe(422);
    expect(pk.body.error.message).toContain("publishable");
    const junk = await owner.json("PUT", `${base()}/online-payments`, {
      provider: "stripe",
      secret_key: "hello",
    });
    expect(junk.status).toBe(422);
    const revoked = await owner.json("PUT", `${base()}/online-payments`, {
      provider: "stripe",
      secret_key: `${"sk_"}test_revokedrevokedrevoked`,
    });
    expect(revoked.status).toBe(422);
    expect(revoked.body.error.code).toBe("provider_key_rejected");
    expect((await owner.json("GET", `${base()}/online-payments`)).body.provider).toBe("off");
  });

  test("owner sets up Stripe: key checked, webhook registered, accounts created, secrets never returned", async () => {
    const body = await setUpStripe({ online_pay_default: false });
    expect(body).toMatchObject({
      provider: "stripe",
      secret_key_set: true,
      webhook_secret_set: true,
      webhook_mode: "registered",
      livemode: false,
      account_name: "Test Studio",
      methods: ["card", "us_bank_account"],
      warning: null,
    });
    expect(fake.webhooks.at(-1)!.url).toBe(
      `https://books.example.com/api/v1/webhooks/payments/stripe/${orgId}`,
    );
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain(WHSEC);
    const accounts = (await owner.json("GET", `${base()}/accounts`)).body.data;
    const clearing = accounts.find((a: any) => a.id === body.clearing_account_id);
    expect(clearing).toMatchObject({ code: "1090", name: "Stripe Clearing", type: "asset" });
    // The template already has Bank and Merchant Fees; it is reused.
    expect(body.fee_account_id).toBe(acct["6300"]);
    const orgView = (await keeper.json("GET", base())).body.settings;
    expect(orgView).toMatchObject({ payment_provider: "stripe", payment_livemode: false });
    expect(JSON.stringify(orgView)).not.toContain(KEY);

    // Saving again without a key keeps the stored key and endpoint.
    const again = await owner.json("PUT", `${base()}/online-payments`, {
      provider: "stripe",
      online_pay_default: true,
    });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      secret_key_set: true,
      webhook_mode: "registered",
      online_pay_default: true,
    });
    expect(fake.webhooks.length).toBe(1);
    await owner.json("PUT", `${base()}/online-payments`, { provider: "stripe", online_pay_default: false });
  });

  test("the key and webhook secret stay out of the audit log and the export", async () => {
    const rows = await (await db()).select().from(org.auditLog).all();
    const audit = JSON.stringify(rows);
    expect(rows.some((r) => r.action === "online_payments.update")).toBe(true);
    expect(audit).not.toContain(KEY);
    expect(audit).not.toContain(WHSEC);
    const { bytes } = await exportOrgBytes(env.ctx, orgId);
    const files = readZip(bytes);
    const settings = new TextDecoder().decode(files["tables/org_settings.jsonl"]!);
    expect(JSON.parse(settings.trim()).payment_credentials_enc).toBeNull();
    for (const f of Object.values(files)) {
      const text = new TextDecoder().decode(f);
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(WHSEC);
    }
    // The stored value is encrypted.
    const s = await (await db()).select().from(org.orgSettings).get();
    expect(s!.paymentCredentialsEnc).toStartWith("enc:v1:");
  });

  test("Test connection checks the stored key", async () => {
    const r = await owner.json("POST", `${base()}/online-payments/test`, {});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ account_name: "Test Studio", livemode: false });
  });
});

describe(`pay links (${DB_MODE})`, () => {
  test("finalizing with online payment on gives a pay link; drafts have none", async () => {
    const draft = await newInvoice(40_000, { online_pay_enabled: true });
    expect(draft).toMatchObject({ online_payment_enabled: true, pay_url: null });
    const fin = await owner.json("POST", `${base()}/invoices/${draft.id}/finalize`, {});
    expect(fin.body.invoice.pay_url).toStartWith(`https://books.example.com/pay/${orgId}/`);
    // Only the token's hash is stored.
    const row = await (await db()).select().from(org.invoices).where(eq(org.invoices.id, draft.id)).get();
    const token = fin.body.invoice.pay_url.split("/").at(-1);
    expect(row!.payTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(token);
    const off = await newInvoice(10_000);
    expect(off.online_payment_enabled).toBe(false);
  });

  test("an invoice still waiting for review, a void one, and a paid one create no session", async () => {
    const before = fake.created.length;
    // At the review threshold the invoice waits in the queue and stays a draft.
    const big = await newInvoice(300_000, { online_pay_enabled: true });
    await owner.json("POST", `${base()}/invoices/${big.id}/finalize`, {});
    const bigRow = await (await db()).select().from(org.invoices).where(eq(org.invoices.id, big.id)).get();
    expect(bigRow!.status).toBe("draft");
    const waiting = await visit(payUrl(env.ctx, orgId, bigRow!));
    expect(waiting.status).toBe(404);
    const html = await waiting.text();
    expect(html).toContain("This payment link isn&#39;t available");
    expect(html).toContain("Pay Co");
    expect(html).not.toContain("<script");

    const v = await openInvoice(20_000);
    await owner.json("POST", `${base()}/invoices/${v.id}/void`, {});
    expect((await visit(v.pay_url)).status).toBe(404);

    const p = await openInvoice(15_000);
    await owner.json("POST", `${base()}/payments`, {
      direction: "received",
      contact_id: customer,
      date: "2026-03-05",
      amount: 15_000,
      account_id: acct["1000"],
      applications: [{ document_id: p.id, amount: 15_000 }],
    });
    const paid = await visit(p.pay_url);
    expect(paid.status).toBe(200);
    expect(await paid.text()).toContain("This invoice is paid");
    expect(fake.created.length).toBe(before);
  });

  test("unknown orgs and tokens get the same generic page", async () => {
    for (const path of [
      `/pay/${orgId}/${"x".repeat(43)}`,
      `/pay/nope/${"x".repeat(43)}`,
      `/pay/${orgId}/short`,
    ]) {
      const r = await anon(env).req("GET", path);
      expect(r.status).toBe(404);
      const html = await r.text();
      expect(html).toContain("This payment link isn&#39;t available");
      expect(html).not.toContain("Pay Co");
    }
  });

  test("an open invoice redirects to Checkout for the balance due; a partial payment makes the next session the remainder", async () => {
    const inv = await openInvoice(50_000);
    const s1 = await checkout(inv);
    const first = fake.created.at(-1)!;
    expect(first).toMatchObject({ amount: 50_000, methods: ["card", "us_bank_account"], currency: "USD" });
    expect(first.successUrl).toBe(`${inv.pay_url}?return=success`);
    expect((await getInvoice(inv.id)).pay_link_opened_at).not.toBeNull();
    // Opening again reuses the open session.
    expect(await checkout(inv)).toBe(s1);
    expect(fake.created.at(-1)).toBe(first);

    await owner.json("POST", `${base()}/payments`, {
      direction: "received",
      contact_id: customer,
      date: "2026-03-05",
      amount: 20_000,
      account_id: acct["1000"],
      applications: [{ document_id: inv.id, amount: 20_000 }],
    });
    const s2 = await checkout(inv);
    expect(s2).not.toBe(s1);
    expect(fake.created.at(-1)!.amount).toBe(30_000);
    // The customer is created in Stripe once.
    expect(fake.customers.filter((c) => c === customer).length).toBe(1);
  });

  test("a replaced session is closed, and one paid meanwhile is recorded instead of replaced", async () => {
    const inv = await openInvoice(40_000);
    const s1 = await checkout(inv);
    const pay = (date: string, amount: number) =>
      owner.json("POST", `${base()}/payments`, {
        direction: "received",
        contact_id: customer,
        date,
        amount,
        account_id: acct["1000"],
        applications: [{ document_id: inv.id, amount }],
      });
    await pay("2026-03-05", 10_000);
    const s2 = await checkout(inv);
    expect(s2).not.toBe(s1);
    // The first session can't be paid any more.
    expect((await fake.getSession(s1)).kind).toBe("expired");
    const created = fake.created.length;

    // The customer paid the second session in a tab left open, and no webhook arrived. A manual
    // payment then changes the balance; opening the link records the online payment (an
    // overpayment now, so it waits for review) instead of offering a third session.
    fake.pay(s2, { gross: 30_000, fee: 900, balanceTxnId: "txn_replaced" });
    await pay("2026-03-06", 1_000);
    const r = await visit(inv.pay_url);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("processing");
    expect((await providerPayments(inv.id)).map((p) => p.providerPaymentId)).toEqual([`pi_${s2}`]);
    expect(fake.created.length).toBe(created);
  });

  test("rotating the link (owner) kills the old one", async () => {
    const inv = await openInvoice(12_000);
    expect((await keeper.json("POST", `${base()}/invoices/${inv.id}/rotate-pay-link`)).status).toBe(403);
    const r = await owner.json("POST", `${base()}/invoices/${inv.id}/rotate-pay-link`);
    expect(r.status).toBe(200);
    expect(r.body.pay_url).not.toBe(inv.pay_url);
    expect((await visit(inv.pay_url)).status).toBe(404);
    expect((await visit(r.body.pay_url)).status).toBe(303);
    const audit = await (await db())
      .select()
      .from(org.auditLog)
      .where(and(eq(org.auditLog.targetId, inv.id), eq(org.auditLog.action, "invoice.pay_link_rotate")))
      .all();
    expect(audit.length).toBe(1);
  });

  test("turning online payment on for a finalized invoice issues its link", async () => {
    const inv = await newInvoice(9_000);
    await owner.json("POST", `${base()}/invoices/${inv.id}/finalize`, {});
    expect((await getInvoice(inv.id)).pay_url).toBeNull();
    const r = await keeper.json("POST", `${base()}/invoices/${inv.id}/online-pay`, { enabled: true });
    expect(r.status).toBe(200);
    expect(r.body.pay_url).toStartWith("https://books.example.com/pay/");
    expect((await visit(r.body.pay_url)).status).toBe(303);
    const off = await keeper.json("POST", `${base()}/invoices/${inv.id}/online-pay`, { enabled: false });
    expect(off.body.pay_url).toBeNull();
    expect((await visit(r.body.pay_url)).status).toBe(404);
  });
});

describe(`recording payments (${DB_MODE})`, () => {
  test("a bad signature gets 401 and stores nothing", async () => {
    const body = JSON.stringify({
      id: "evt_bad",
      type: "checkout.session.completed",
      data: { object: { id: "cs" } },
    });
    for (const sig of [
      undefined,
      signed(body, `${"whsec_"}someoneelsessecret`),
      signed(body, WHSEC, 1_000_000),
    ]) {
      expect((await deliver(body, sig)).status).toBe(401);
    }
    const stored = await (await db())
      .select()
      .from(org.providerEvents)
      .where(eq(org.providerEvents.eventId, "evt_bad"))
      .all();
    expect(stored.length).toBe(0);
  });

  test("card payment: payment into clearing, fee Dr fee / Cr clearing, invoice paid", async () => {
    const s = await (await db()).select().from(org.orgSettings).get();
    const clearingBefore = await postedBalance(s!.paymentClearingAccountId!);
    const feeBefore = await postedBalance(s!.paymentFeeAccountId!);
    const inv = await openInvoice(100_000);
    const sid = await checkout(inv);
    fake.pay(sid, { gross: 100_000, fee: 2_930, balanceTxnId: "txn_1" });
    const { res, id } = await webhook("checkout.session.completed", sid);
    expect(res.status).toBe(200);
    await settle();

    const after = await getInvoice(inv.id);
    expect(after).toMatchObject({ status: "paid", balance_due: 0, online_pay_status: null });
    const pp = await providerPayments(inv.id);
    expect(pp.length).toBe(1);
    expect(pp[0]).toMatchObject({
      gross: 100_000,
      fee: 2_930,
      methodType: "card",
      providerPaymentId: `pi_${sid}`,
    });
    const payment = (await owner.json("GET", `${base()}/payments/${pp[0]!.paymentId}`)).body;
    expect(payment).toMatchObject({
      account_id: s!.paymentClearingAccountId,
      method: "stripe",
      reference: `pi_${sid}`,
      entry_status: "posted",
    });
    const payEntry = (await owner.json("GET", `${base()}/entries/${payment.entry_id}`)).body;
    expect(payEntry.created_by_actor).toBe("integration");
    const fee = (await owner.json("GET", `${base()}/entries/${pp[0]!.feeEntryId}`)).body;
    expect(fee).toMatchObject({ status: "posted", source_type: "payment_fee", source_id: payment.id });
    expect(fee.memo).toBe(`Stripe fee, invoice ${inv.number}`);
    expect(fee.lines.map((l: any) => [l.account_id, l.amount])).toEqual([
      [s!.paymentFeeAccountId, 2_930],
      [s!.paymentClearingAccountId, -2_930],
    ]);
    expect((await postedBalance(s!.paymentClearingAccountId!)) - clearingBefore).toBe(100_000 - 2_930);
    expect((await postedBalance(s!.paymentFeeAccountId!)) - feeBefore).toBe(2_930);
    const ev = await (await db())
      .select()
      .from(org.providerEvents)
      .where(eq(org.providerEvents.eventId, id))
      .get();
    expect(ev).toMatchObject({ result: "recorded" });
    expect(ev!.processedAt).not.toBeNull();
  });

  test("a duplicate delivery and a second event for the same payment record once", async () => {
    const inv = await openInvoice(25_000);
    const sid = await checkout(inv);
    const paid = fake.pay(sid, { gross: 25_000, fee: 755 });
    const first = await webhook("checkout.session.completed", sid);
    const dup = await webhook("checkout.session.completed", sid, { id: first.id });
    expect(((await dup.res.json()) as any).action).toBe("duplicate");
    await webhook("payment_intent.succeeded", paid.paymentId);
    await settle();
    expect((await providerPayments(inv.id)).length).toBe(1);
    const events = await (await db())
      .select()
      .from(org.providerEvents)
      .where(eq(org.providerEvents.eventId, first.id))
      .all();
    expect(events.length).toBe(1);
    expect((await getInvoice(inv.id)).status).toBe("paid");
  });

  test("webhook, polling, and the customer's return together record once", async () => {
    const inv = await openInvoice(33_000);
    const sid = await checkout(inv);
    fake.pay(sid, { gross: 33_000, fee: 987 });
    const [ret] = await Promise.all([
      visit(inv.pay_url, "?return=success"),
      webhook("checkout.session.completed", sid),
      pollPayments(env.ctx, orgId),
      pollPayments(env.ctx, orgId),
    ]);
    await settle();
    expect(ret.status).toBe(200);
    expect(await ret.text()).toContain("This invoice is paid");
    expect((await providerPayments(inv.id)).length).toBe(1);
    const payments = await (await db())
      .select()
      .from(org.payments)
      .where(eq(org.payments.reference, `pi_${sid}`))
      .all();
    expect(payments.length).toBe(1);
    const fees = await (await db())
      .select()
      .from(org.journalEntries)
      .where(
        and(
          eq(org.journalEntries.sourceType, "payment_fee"),
          eq(org.journalEntries.sourceId, payments[0]!.id),
        ),
      )
      .all();
    expect(fees.length).toBe(1);
  });

  test("the success return records without webhooks", async () => {
    const inv = await openInvoice(8_000);
    const sid = await checkout(inv);
    fake.pay(sid, { gross: 8_000, fee: 262 });
    const ret = await visit(inv.pay_url, "?return=success");
    expect(await ret.text()).toContain("This invoice is paid");
    expect((await getInvoice(inv.id)).status).toBe("paid");
  });

  test("processing, then succeeded: the invoice shows processing, then the payment and fee post", async () => {
    const inv = await openInvoice(60_000);
    const sid = await checkout(inv);
    fake.set(sid, "payment_processing");
    await webhook("checkout.session.completed", sid);
    await settle();
    expect((await getInvoice(inv.id)).online_pay_status).toBe("processing");
    const page = await visit(inv.pay_url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("processing");
    expect((await providerPayments(inv.id)).length).toBe(0);

    fake.pay(sid, { gross: 60_000, fee: 480, methodType: "us_bank_account" });
    await webhook("checkout.session.async_payment_succeeded", sid);
    await settle();
    const after = await getInvoice(inv.id);
    expect(after).toMatchObject({ status: "paid", online_pay_status: null });
    const pp = await providerPayments(inv.id);
    expect(pp[0]).toMatchObject({ fee: 480, methodType: "us_bank_account" });
    const payment = (await owner.json("GET", `${base()}/payments/${pp[0]!.paymentId}`)).body;
    expect(payment.memo).toContain("ACH Direct Debit");
  });

  test("a failed payment records nothing and clears the status", async () => {
    const inv = await openInvoice(45_000);
    const sid = await checkout(inv);
    fake.set(sid, "payment_processing");
    await webhook("checkout.session.completed", sid);
    await settle();
    fake.set(sid, "payment_failed");
    await webhook("checkout.session.async_payment_failed", sid);
    await settle();
    const after = await getInvoice(inv.id);
    expect(after).toMatchObject({ status: "sent", online_pay_status: null, balance_due: 45_000 });
    expect((await providerPayments(inv.id)).length).toBe(0);
    const row = await (await db()).select().from(org.invoices).where(eq(org.invoices.id, inv.id)).get();
    expect(row!.paySessionId).toBeNull();
    const notes = await (await db())
      .select()
      .from(org.auditLog)
      .where(and(eq(org.auditLog.targetId, inv.id), eq(org.auditLog.action, "invoice.online_payment_failed")))
      .all();
    expect(notes.length).toBe(1);
    // The customer can try again with a fresh session.
    expect(await checkout(inv)).not.toBe(sid);
  });

  test("an overpayment waits for review; the balance is applied only when approved", async () => {
    const inv = await openInvoice(10_000);
    const sid = await checkout(inv);
    fake.pay(sid, { gross: 12_000, fee: 380 });
    await webhook("checkout.session.completed", sid);
    await settle();
    expect((await getInvoice(inv.id)).status).toBe("sent");
    const pp = await providerPayments(inv.id);
    expect(pp.length).toBe(1);
    const review = (await owner.json("GET", `${base()}/review?status=pending`)).body.data;
    const item = review.find((r: any) => r.reason.startsWith("Overpayment") && r.reason.includes(inv.number));
    expect(item).toBeDefined();
    // The fee waits too.
    const fee = (await owner.json("GET", `${base()}/entries/${pp[0]!.feeEntryId}`)).body;
    expect(fee.status).toBe("pending_review");
    const ok = await owner.json("POST", `${base()}/review/${item.id}/approve`, {});
    expect(ok.status).toBe(200);
    const after = await getInvoice(inv.id);
    expect(after.status).toBe("paid");
    const payment = (await owner.json("GET", `${base()}/payments/${pp[0]!.paymentId}`)).body;
    expect(payment).toMatchObject({ amount: 12_000, applied: 10_000, unapplied: 2_000 });
  });

  test("a payment for an unknown or already paid invoice goes to review", async () => {
    // Already paid: the customer paid the same invoice twice.
    const inv = await openInvoice(7_000);
    const s1 = await checkout(inv);
    fake.pay(s1, { gross: 7_000, fee: 233 });
    await webhook("checkout.session.completed", s1);
    await settle();
    expect((await getInvoice(inv.id)).status).toBe("paid");
    fake.sessions.set("cs_twice", {
      ...(fake.sessions.get(s1) as Paid),
      sessionId: "cs_twice",
      paymentId: "pi_twice",
    });
    await webhook("checkout.session.completed", "cs_twice");
    // Unknown invoice: the session names an invoice this org doesn't have.
    fake.sessions.set("cs_unknown", {
      ...(fake.sessions.get(s1) as Paid),
      sessionId: "cs_unknown",
      paymentId: "pi_unknown",
      invoiceId: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
      customerId: `cus_${customer}`,
    });
    await webhook("checkout.session.completed", "cs_unknown");
    await settle();
    const review = (await owner.json("GET", `${base()}/review?status=pending`)).body.data;
    expect(review.some((r: any) => r.reason.includes(`Invoice ${inv.number} is already paid`))).toBe(true);
    expect(review.some((r: any) => r.reason.includes("doesn't match an invoice"))).toBe(true);
    const unknown = await (await db())
      .select()
      .from(org.providerPayments)
      .where(eq(org.providerPayments.providerPaymentId, "pi_unknown"))
      .get();
    expect(unknown).toMatchObject({ invoiceId: null, gross: 7_000 });
  });

  test("refunds, disputes, and payouts are stored as unhandled and post nothing", async () => {
    const entriesBefore = (await (
      await db()
    )
      .select({ n: sql<number>`count(*)` })
      .from(org.journalEntries)
      .get())!.n;
    for (const t of ["charge.refunded", "charge.dispute.created", "payout.paid"]) await webhook(t, "ch_1");
    await settle();
    const rows = await (await db())
      .select()
      .from(org.providerEvents)
      .where(sql`${org.providerEvents.type} in ('charge.refunded','charge.dispute.created','payout.paid')`)
      .all();
    expect(rows.map((r) => r.result)).toEqual(["unhandled", "unhandled", "unhandled"]);
    const entriesAfter = (await (
      await db()
    )
      .select({ n: sql<number>`count(*)` })
      .from(org.journalEntries)
      .get())!.n;
    expect(entriesAfter).toBe(entriesBefore);
  });
});

describe(`polling job (${DB_MODE})`, () => {
  const job = () => registeredJobs().find((j) => j.name === "payments.poll")!;

  test("due every 6 hours with a webhook, every 15 minutes without, never without a provider", async () => {
    const now = new Date();
    const ago = (min: number) => new Date(now.getTime() - min * 60_000);
    expect(await job().due(now, ago(20), env.ctx, orgId)).toBe(false);
    expect(await job().due(now, ago(6 * 60), env.ctx, orgId)).toBe(true);
    const other = await createOrg(env, owner, "No Payments Co");
    expect(await job().due(now, null, env.ctx, other)).toBe(false);
  });

  test("records paid sessions, retries failed events, and posts fees that settled later", async () => {
    const inv = await openInvoice(52_000);
    const sid = await checkout(inv);
    // A bank debit: paid, but the fee isn't known yet.
    const paid = fake.pay(sid, { gross: 52_000, fee: null, methodType: "us_bank_account" });
    const r1 = await (env.ctx.services.scheduler as Scheduler).runJob(job(), orgId);
    expect(r1.status).toBe("ok");
    const pp = await providerPayments(inv.id);
    expect(pp[0]).toMatchObject({ fee: null, feeEntryId: null });
    expect((await getInvoice(inv.id)).status).toBe("paid");

    fake.fees.set(paid.paymentId, { fee: 500, balanceTxnId: "txn_later" });
    const r2 = await (env.ctx.services.scheduler as Scheduler).runJob(job(), orgId);
    expect(r2.detail).toContain("1 fee(s) posted");
    const after = await providerPayments(inv.id);
    expect(after[0]).toMatchObject({ fee: 500, balanceTxnId: "txn_later" });
    const fee = (await owner.json("GET", `${base()}/entries/${after[0]!.feeEntryId}`)).body;
    expect(fee).toMatchObject({ status: "posted", source_type: "payment_fee", total: 500 });

    // An event whose processing failed (the session wasn't there yet) is retried by the job.
    const inv2 = await openInvoice(6_000);
    const s2 = await checkout(inv2);
    const saved = fake.sessions.get(s2)!;
    fake.sessions.delete(s2);
    const { id } = await webhook("checkout.session.completed", s2);
    await settle();
    const failed = await (await db())
      .select()
      .from(org.providerEvents)
      .where(eq(org.providerEvents.eventId, id))
      .get();
    expect(failed).toMatchObject({ result: "error", processedAt: null });
    fake.sessions.set(s2, saved);
    fake.pay(s2, { gross: 6_000, fee: 204 });
    fake.events.set(id, { id, type: "checkout.session.completed", kind: "session", sessionId: s2 });
    // Drop the stored session so only the event retry can find the payment.
    await (await env.ctx.orgs.mustOpen(orgId)).write((tx) =>
      tx.update(org.invoices).set({ paySessionId: null }).where(eq(org.invoices.id, inv2.id)),
    );
    await (env.ctx.services.scheduler as Scheduler).runJob(job(), orgId);
    const retried = await (await db())
      .select()
      .from(org.providerEvents)
      .where(eq(org.providerEvents.eventId, id))
      .get();
    expect(retried).toMatchObject({ result: "recorded" });
    expect((await getInvoice(inv2.id)).status).toBe("paid");
  });
});

describe(`PDF and email (${DB_MODE})`, () => {
  async function pdfLinks(invoiceId: string) {
    const res = await owner.req("GET", `${base()}/invoices/${invoiceId}/pdf`);
    const doc = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
    const uris: string[] = [];
    for (const page of doc.getPages()) {
      const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
      for (let i = 0; i < (annots?.size() ?? 0); i++) {
        const a = annots!.lookup(i, PDFDict);
        const action = a.lookupMaybe(PDFName.of("A"), PDFDict);
        const uri = action?.lookupMaybe(PDFName.of("URI"), PDFString);
        if (uri) uris.push(uri.decodeText());
      }
    }
    return uris;
  }

  test("the PDF has a clickable pay link and the email says Pay online", async () => {
    const inv = await openInvoice(18_000);
    expect(await pdfLinks(inv.id)).toContain(inv.pay_url);
    const sent = await owner.json("POST", `${base()}/invoices/${inv.id}/send`, {});
    expect(sent.status).toBe(200);
    const m = mail.at(-1)!;
    expect(m.text).toContain(`Pay online: ${inv.pay_url}`);
    expect(m.text!.indexOf("Pay online")).toBeLessThan(m.text!.indexOf("Thank you"));
  });

  test("payment link mode prints the URL entered on the invoice", async () => {
    await owner.json("PUT", `${base()}/online-payments`, { provider: "manual_link" });
    // Leaving Stripe removes the registered endpoint and the stored key.
    expect(fake.deletedWebhooks.length).toBeGreaterThan(0);
    const g = (await owner.json("GET", `${base()}/online-payments`)).body;
    expect(g).toMatchObject({ provider: "manual_link", secret_key_set: false });
    const bad = await owner.json("POST", `${base()}/invoices`, {
      customer_id: customer,
      issue_date: "2026-03-01",
      manual_pay_url: "javascript:alert(1)",
      lines: [{ description: "X", unit_price: 100, account_id: acct["4000"] }],
    });
    expect(bad.status).toBe(400);
    const inv = await newInvoice(5_000, { manual_pay_url: "https://pay.example.com/inv-42" });
    await owner.json("POST", `${base()}/invoices/${inv.id}/finalize`, {});
    const view = await getInvoice(inv.id);
    expect(view).toMatchObject({ manual_pay_url: "https://pay.example.com/inv-42", pay_url: null });
    expect(await pdfLinks(inv.id)).toEqual(["https://pay.example.com/inv-42"]);
    await owner.json("POST", `${base()}/invoices/${inv.id}/send`, {});
    expect(mail.at(-1)!.text).toContain("Pay online: https://pay.example.com/inv-42");
    await setUpStripe();
  });
});
