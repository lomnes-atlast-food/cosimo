/**
 * Online invoice payments (#55): a "Pay online" link on each invoice that opens a Checkout session
 * in the org's own payment provider account (Stripe first, behind `payment-providers/`), and
 * recording of the payment and the provider's fee without anyone booking it by hand.
 *
 * Three paths learn that a customer paid: the webhook, the polling job, and the customer's return
 * to the pay link. All three call `reconcileSession`, which fetches the authoritative state from
 * the provider and records the payment at most once: the unique (provider, payment) key on
 * `provider_payments` is written in the same transaction as the payment.
 *
 * Pay links are derived from the master key (like Plaid tokens, they stop working if the master
 * key changes); only the SHA-256 of a link's token is stored, so a database copy alone gives no
 * working links. Network calls run outside database transactions.
 */
import { checkLock } from "@cosimo/core";
import { newId, type OrgDb, type OrgTx, org } from "@cosimo/db";
import { formatCents } from "@cosimo/shared";
import { and, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { hashToken } from "../crypto.ts";
import { ApiError, badRequest, conflict, forbidden, notFound, unprocessable } from "../http/errors.ts";
import { createAccountTx } from "./accounts.ts";
import type { ActorInfo } from "./actor.ts";
import { appendAudit } from "./audit.ts";
import { mustGetContact } from "./contacts.ts";
import { issuePayLinkTx, mustGetInvoice, type PayLinker, recordPaymentTx } from "./documents.ts";
import { accountMap, settingsRow, submitEntryTx } from "./ledger.ts";
import {
  type CreateSessionInput,
  offeredMethods,
  type PaymentMethodType,
  type PaymentProvider,
  ProviderError,
  type ProviderEvent,
  providerFor,
  type SessionResult,
  type SetupCheck,
  type StoredSetupCheck,
  type StripeSecrets,
  scrubProviderText,
  stripeOptions,
  stripeSecrets,
  WebhookSignatureError,
} from "./payment-providers/index.ts";
import {
  stripeClient,
  stripeKeyLivemode,
  stripeKeyProblem,
  WEBHOOK_EVENTS,
  WEBHOOK_EVENTS_VERSION,
  WEBHOOK_WRITE_PERMISSION,
} from "./payment-providers/stripe.ts";
import type { OrgHandle } from "./types.ts";

type Reader = OrgDb | OrgTx;
type SettingsRow = typeof org.orgSettings.$inferSelect;
type InvoiceRow = typeof org.invoices.$inferSelect;

export type PaymentMode = SettingsRow["paymentProvider"];

/** Who records provider payments: auto-approved by default, subject to the threshold and owner rules. */
export const STRIPE_ACTOR: ActorInfo = {
  actor: "integration",
  role: "owner",
  userId: null,
  displayName: "Stripe",
};

/** How a payment memo names the method ("Paid online by card"). */
const METHOD_LABEL: Record<string, string> = {
  card: "card",
  us_bank_account: "ACH Direct Debit",
  customer_balance: "bank transfer",
};

/** The Stripe dashboard's names for the methods (Settings → Payments → Payment methods). */
export const METHOD_NAME: Record<PaymentMethodType, string> = {
  card: "Cards",
  us_bank_account: "ACH Direct Debit",
  customer_balance: "Bank Transfers",
};

/** Stripe Checkout's minimum charge in USD: a smaller balance due gets no pay link. */
export const MIN_ONLINE_PAYMENT_CENTS = 50;

/** Longest pay-link error stored on an invoice. */
const PAY_ERROR_MAX = 500;

function assertCanManage(a: ActorInfo) {
  if (a.role !== "owner") throw forbidden("Only owners can manage online payments.");
  if (a.actor === "mcp" || a.proposeOnly) throw forbidden("AI assistants cannot manage online payments.");
}

function publicBase(ctx: AppContext) {
  return (ctx.config.server.public_url || "").replace(/\/+$/, "");
}

/** Where the provider sends webhooks for this org, or null without a public HTTPS URL. */
export function paymentWebhookUrl(ctx: AppContext, orgId: string): string | null {
  const base = publicBase(ctx);
  return base.startsWith("https://") ? `${base}/api/v1/webhooks/payments/stripe/${orgId}` : null;
}

// ----------------------------------------------------------------------------- settings

export async function settingsView(ctx: AppContext, db: Reader, orgId: string) {
  const s = await settingsRow(db);
  const secrets = s.paymentProvider === "stripe" ? stripeSecrets(ctx.secrets, s) : null;
  const opts = stripeOptions(s);
  const last = await db
    .select({ at: org.providerEvents.receivedAt })
    .from(org.providerEvents)
    .orderBy(desc(org.providerEvents.receivedAt))
    .limit(1)
    .get();
  const failed = await lastPayError(db);
  return {
    provider: s.paymentProvider,
    secret_key_set: Boolean(secrets?.secret_key),
    webhook_secret_set: Boolean(secrets?.webhook_secret),
    /** `registered`: Cosimo created the endpoint; `manual`: a pasted signing secret; `polling`: none. */
    webhook_mode: !secrets
      ? null
      : secrets.webhook_endpoint_id
        ? ("registered" as const)
        : secrets.webhook_secret
          ? ("manual" as const)
          : ("polling" as const),
    webhook_url: paymentWebhookUrl(ctx, orgId),
    methods: opts.methods,
    account_name: secrets ? opts.account_name : null,
    livemode: secrets ? opts.livemode : null,
    clearing_account_id: s.paymentClearingAccountId,
    fee_account_id: s.paymentFeeAccountId,
    online_pay_default: s.onlinePayDefault,
    last_event_at: last?.at ?? null,
    setup_check: secrets ? opts.setup_check : null,
    /** The events Cosimo needs, for an endpoint set up by hand. */
    webhook_events: [...WEBHOOK_EVENTS],
    last_pay_error: failed
      ? { invoice_id: failed.id, number: failed.number, at: failed.payErrorAt, message: failed.payError! }
      : null,
  };
}
export type OnlinePaymentSettingsView = Awaited<ReturnType<typeof settingsView>>;

/** The invoice whose pay link failed most recently, or null. */
export async function lastPayError(db: Reader) {
  return (
    (await db
      .select({
        id: org.invoices.id,
        number: org.invoices.number,
        payError: org.invoices.payError,
        payErrorAt: org.invoices.payErrorAt,
      })
      .from(org.invoices)
      .where(isNotNull(org.invoices.payError))
      .orderBy(desc(org.invoices.payErrorAt))
      .limit(1)
      .get()) ?? null
  );
}

export async function getSettings(ctx: AppContext, orgId: string, a: ActorInfo) {
  assertCanManage(a);
  const h = await ctx.orgs.mustOpen(orgId);
  return settingsView(ctx, h.db, orgId);
}

export interface SettingsInput {
  provider: PaymentMode;
  /** Omit to keep the stored key. */
  secret_key?: string;
  /** Manual fallback: a signing secret (whsec_...) for an endpoint created in the Stripe dashboard. Null clears it. */
  webhook_secret?: string | null;
  methods?: PaymentMethodType[];
  clearing_account_id?: string | null;
  fee_account_id?: string | null;
  online_pay_default?: boolean;
}

function providerApiError(e: unknown, what: string): never {
  if (e instanceof ProviderError) {
    if (e.status === 0) throw new ApiError(502, "provider_unreachable", `Could not reach Stripe to ${what}.`);
    if (e.status === 401 || e.status === 403)
      throw unprocessable(
        `Stripe rejected this key: ${e.message.replace(/^Stripe: /, "")}`,
        "provider_key_rejected",
      );
    throw new ApiError(502, "provider_error", e.message, { code: e.code ?? null });
  }
  throw e;
}

/** Check a key with Stripe before storing it, so a wrong key fails where it was entered. */
export async function testStripeKey(key: string) {
  const problem = stripeKeyProblem(key);
  if (problem) throw unprocessable(problem, "invalid_key");
  try {
    const acct = await stripeClient({ secretKey: key }).testConnection();
    return { account_name: acct.accountName, livemode: stripeKeyLivemode(key) };
  } catch (e) {
    providerApiError(e, "check the key");
  }
}

/**
 * Check what the key can do: every permission Cosimo uses, whether the methods are active, and
 * whether the webhook endpoint sends every event. Never throws; a failed check reads as unknown.
 */
async function checkSetup(key: string, methods: PaymentMethodType[], webhookUrl: string | null) {
  try {
    return await stripeClient({ secretKey: key }).checkSetup(methods, webhookUrl);
  } catch (e) {
    const detail = `Couldn't check: ${scrubProviderText((e as Error).message)}`;
    return {
      permissions: [],
      methods: methods.map((type) => ({ type, status: "unknown" as const, detail })),
      missingEvents: null,
    } satisfies SetupCheck;
  }
}

/**
 * The stored summary of a setup check. Webhook Endpoints: Write only matters when Cosimo registers
 * the endpoint itself, so it isn't counted for a hand-made endpoint or without a public URL. A
 * method a checkout showed to be inactive (`previous`, same key) stays inactive until a check sees
 * it active; a check that can't tell doesn't clear it.
 */
export function summarizeSetup(
  check: SetupCheck,
  creds: StripeSecrets,
  webhookUrl: string | null,
  previous: StoredSetupCheck | null = null,
): StoredSetupCheck {
  const manual = Boolean(creds.webhook_secret && !creds.webhook_endpoint_id);
  const known = new Set(previous?.inactive_methods ?? []);
  const inactive = (m: SetupCheck["methods"][number]) =>
    m.status === "inactive" || m.status === "pending" || (m.status === "unknown" && known.has(m.type));
  return {
    checked_at: new Date().toISOString(),
    missing: check.permissions
      .filter((p) => p.ok === false && !(p.name === WEBHOOK_WRITE_PERMISSION && (manual || !webhookUrl)))
      .map((p) => p.name),
    inactive_methods: check.methods.filter(inactive).map((m) => m.type),
    unknown_methods: check.methods.filter((m) => m.status === "unknown" && !inactive(m)).map((m) => m.type),
    missing_events: check.missingEvents ?? [],
  };
}

/** What an owner should fix, in one paragraph, or null when the check found nothing. */
export function setupWarning(c: StoredSetupCheck | null): string | null {
  if (!c) return null;
  const out: string[] = [];
  if (c.missing.length)
    out.push(
      `The Stripe key is missing permissions: ${c.missing.join(", ")}. Add them to the restricted key in the Stripe dashboard (Developers → API keys), or customers can't pay online.`,
    );
  if (c.inactive_methods.length)
    out.push(
      `Not active in Stripe: ${c.inactive_methods.map((m) => METHOD_NAME[m]).join(", ")}. Activate them under Settings → Payments → Payment methods in the key's mode, then save or test the connection again; until then checkouts leave them out.`,
    );
  if (c.missing_events.length)
    out.push(
      `The Stripe webhook endpoint doesn't send: ${c.missing_events.join(", ")}. Add these events to it.`,
    );
  return out.length ? out.join(" ") : null;
}

/** Merge a change into the stored provider options (keeps fields this code doesn't know). */
async function patchOptionsTx(tx: OrgTx, fn: (o: Record<string, unknown>) => void) {
  const s = await settingsRow(tx);
  let o: Record<string, unknown> = {};
  try {
    o = s.paymentOptionsJson ? (JSON.parse(s.paymentOptionsJson) as Record<string, unknown>) : {};
  } catch {
    // rewritten below
  }
  fn(o);
  await tx
    .update(org.orgSettings)
    .set({ paymentOptionsJson: JSON.stringify(o) })
    .where(eq(org.orgSettings.id, 1));
}

/** Test the stored key (or a key being entered) without saving. */
export async function testConnection(ctx: AppContext, orgId: string, a: ActorInfo, key?: string | null) {
  assertCanManage(a);
  const h = await ctx.orgs.mustOpen(orgId);
  const s = await settingsRow(h.db);
  const stored = stripeSecrets(ctx.secrets, s);
  const k = key || stored?.secret_key;
  if (!k) throw unprocessable("Add a Stripe secret key first.", "payments_not_configured");
  const acct = await testStripeKey(k);
  const opts = stripeOptions(s);
  const url = paymentWebhookUrl(ctx, orgId);
  const check = await checkSetup(k, opts.methods, url);
  // Testing the stored key refreshes the stored result, so a fixed method is offered again.
  if (stored && k === stored.secret_key && s.paymentProvider === "stripe") {
    const summary = summarizeSetup(check, stored, url, opts.setup_check);
    await h.write((tx) => patchOptionsTx(tx, (o) => (o.setup_check = summary)));
  }
  return {
    ...acct,
    permissions: check.permissions,
    methods: check.methods,
    missing_events: check.missingEvents,
  };
}

/** Bring a registered endpoint's events up to date. Returns an error message, or null when it worked. */
async function syncWebhookEvents(key: string, endpointId: string): Promise<string | null> {
  try {
    await stripeClient({ secretKey: key }).updateWebhook(endpointId, WEBHOOK_EVENTS);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

async function deleteEndpoint(ctx: AppContext, old: StripeSecrets | null, orgId: string) {
  if (!old?.webhook_endpoint_id) return;
  try {
    await stripeClient({ secretKey: old.secret_key }).deleteWebhook(old.webhook_endpoint_id);
  } catch (e) {
    ctx.logger.warn("could not delete the old Stripe webhook endpoint", {
      org_id: orgId,
      error: (e as Error).message,
    });
  }
}

async function freeCode(tx: OrgTx, start: number) {
  const used = new Set(
    (await tx.select({ code: org.accounts.code }).from(org.accounts).all()).map((r) => r.code),
  );
  for (let c = start; c < start + 1000; c++) if (!used.has(String(c))) return String(c);
  throw conflict("No free account code for the online payment accounts.");
}

/** On first setup: a Stripe Clearing asset, and the Bank and Merchant Fees expense (reused when present). */
async function ensureAccountsTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  input: { clearing: string | null; fee: string | null },
) {
  const accts = await accountMap(tx);
  let clearing = input.clearing;
  let fee = input.fee;
  if (clearing) {
    const c = accts.get(clearing);
    if (!c?.isActive || c.type !== "asset")
      throw unprocessable("The clearing account must be an active asset account.", "invalid_account");
  } else {
    clearing = (
      await createAccountTx(tx, orgId, a, {
        code: await freeCode(tx, 1090),
        name: "Stripe Clearing",
        type: "asset",
        subtype: "other_current_asset",
        description:
          "Online invoice payments collected by Stripe, before Stripe pays them out to the bank. Payouts move the balance to checking.",
      })
    ).id;
  }
  if (fee) {
    const f = accts.get(fee);
    if (!f?.isActive || f.type !== "expense")
      throw unprocessable("The fee account must be an active expense account.", "invalid_account");
  } else {
    const existing = await tx
      .select()
      .from(org.accounts)
      .where(
        and(eq(org.accounts.code, "6300"), eq(org.accounts.type, "expense"), eq(org.accounts.isActive, true)),
      )
      .get();
    fee =
      existing?.id ??
      (
        await createAccountTx(tx, orgId, a, {
          code: await freeCode(tx, 6300),
          name: "Bank and Merchant Fees",
          type: "expense",
        })
      ).id;
  }
  return { clearing, fee };
}

export async function saveSettings(ctx: AppContext, orgId: string, a: ActorInfo, input: SettingsInput) {
  assertCanManage(a);
  const h = await ctx.orgs.mustOpen(orgId);
  const s = await settingsRow(h.db);
  const old = stripeSecrets(ctx.secrets, s);
  const opts = stripeOptions(s);
  let creds: StripeSecrets | null = null;
  const warnings: string[] = [];
  let eventsVersion = opts.webhook_events_version;
  let account: { account_name: string; livemode: boolean } | null = null;

  if (input.webhook_secret && !/^whsec_[A-Za-z0-9]+$/.test(input.webhook_secret))
    throw unprocessable("A Stripe webhook signing secret starts with whsec_.", "invalid_webhook_secret");

  if (input.provider === "stripe") {
    const key = input.secret_key || old?.secret_key;
    if (!key) throw unprocessable("Add a Stripe secret key.", "payments_not_configured");
    account = await testStripeKey(key);
    const keyChanged = key !== old?.secret_key;
    creds = {
      secret_key: key,
      webhook_secret: keyChanged ? null : (old?.webhook_secret ?? null),
      webhook_endpoint_id: keyChanged ? null : (old?.webhook_endpoint_id ?? null),
    };
    if (input.webhook_secret !== undefined) {
      // A pasted secret means the endpoint was set up by hand; drop any endpoint Cosimo registered.
      if (input.webhook_secret) await deleteEndpoint(ctx, old, orgId);
      creds.webhook_secret = input.webhook_secret;
      creds.webhook_endpoint_id = null;
    } else if (keyChanged || !creds.webhook_secret) {
      if (keyChanged) await deleteEndpoint(ctx, old, orgId);
      const url = paymentWebhookUrl(ctx, orgId);
      if (url) {
        try {
          const w = await stripeClient({ secretKey: key }).registerWebhook(url);
          creds.webhook_secret = w.secret;
          creds.webhook_endpoint_id = w.id;
          eventsVersion = WEBHOOK_EVENTS_VERSION;
        } catch (e) {
          warnings.push(
            `Stripe didn't accept the webhook endpoint (${(e as Error).message}). Cosimo checks for payments every 15 minutes instead; you can paste a signing secret from the Stripe dashboard.`,
          );
        }
      }
    } else if (creds.webhook_endpoint_id && eventsVersion < WEBHOOK_EVENTS_VERSION) {
      // An endpoint registered by an older release: add the events it lacks.
      const err = await syncWebhookEvents(key, creds.webhook_endpoint_id);
      if (err) warnings.push(`Cosimo couldn't update the Stripe webhook endpoint's events (${err}).`);
      else eventsVersion = WEBHOOK_EVENTS_VERSION;
    }
  } else {
    await deleteEndpoint(ctx, old, orgId);
  }

  const methods = input.methods?.length ? [...new Set(input.methods)] : opts.methods;
  let setupCheck: StoredSetupCheck | null = null;
  if (creds) {
    const url = paymentWebhookUrl(ctx, orgId);
    const previous = creds.secret_key === old?.secret_key ? opts.setup_check : null;
    setupCheck = summarizeSetup(await checkSetup(creds.secret_key, methods, url), creds, url, previous);
    const w = setupWarning(setupCheck);
    if (w) warnings.push(w);
  }
  await h.write(async (tx) => {
    const before = await settingsView(ctx, tx, orgId);
    const patch: Partial<typeof org.orgSettings.$inferInsert> = {
      paymentProvider: input.provider,
      paymentCredentialsEnc: creds ? ctx.secrets.encrypt(JSON.stringify(creds)) : null,
      paymentOptionsJson: JSON.stringify({
        methods,
        account_name: account?.account_name ?? null,
        livemode: account?.livemode ?? false,
        setup_check: setupCheck,
        webhook_events_version: eventsVersion,
      }),
    };
    if (input.online_pay_default !== undefined) patch.onlinePayDefault = input.online_pay_default;
    if (input.provider === "stripe") {
      const acc = await ensureAccountsTx(tx, orgId, a, {
        clearing: input.clearing_account_id ?? s.paymentClearingAccountId,
        fee: input.fee_account_id ?? s.paymentFeeAccountId,
      });
      patch.paymentClearingAccountId = acc.clearing;
      patch.paymentFeeAccountId = acc.fee;
    }
    await tx.update(org.orgSettings).set(patch).where(eq(org.orgSettings.id, 1));
    await appendAudit(tx, orgId, a, {
      action: "online_payments.update",
      targetType: "org_settings",
      targetId: orgId,
      before,
      after: await settingsView(ctx, tx, orgId),
    });
  });
  // Saving never fails over what the check found; the owner is told what to fix.
  return { ...(await settingsView(ctx, h.db, orgId)), warning: warnings.length ? warnings.join(" ") : null };
}

// ----------------------------------------------------------------------------- pay links

export function payToken(ctx: AppContext, orgId: string, invoiceId: string, version: number) {
  return ctx.secrets.hmac(`pay:${orgId}:${invoiceId}:${version}`);
}

export function payUrl(ctx: AppContext, orgId: string, inv: Pick<InvoiceRow, "id" | "payTokenVersion">) {
  return `${publicBase(ctx)}/pay/${orgId}/${payToken(ctx, orgId, inv.id, inv.payTokenVersion)}`;
}

/** A balance due Stripe can't take online: more than nothing, but under the Checkout minimum. */
export function belowOnlineMinimum(inv: Pick<InvoiceRow, "total" | "amountPaid">) {
  const balance = inv.total - inv.amountPaid;
  return balance > 0 && balance < MIN_ONLINE_PAYMENT_CENTS;
}

/**
 * Pay link builder for invoice views: only for Stripe, with online payment on, once finalized, and
 * not while the balance due is under Stripe's minimum (the link comes back if the balance rises).
 */
export async function payLinker(ctx: AppContext, db: Reader, orgId: string): Promise<PayLinker> {
  const s = await settingsRow(db);
  return (inv) =>
    s.paymentProvider === "stripe" &&
    inv.onlinePayEnabled &&
    inv.payTokenVersion > 0 &&
    inv.status !== "draft" &&
    inv.status !== "void" &&
    !belowOnlineMinimum(inv)
      ? payUrl(ctx, orgId, inv)
      : null;
}

/** Store the token hash of every link issued without one (finalize runs without the master key). */
export async function storePayTokenHashesTx(ctx: AppContext, tx: OrgTx, orgId: string) {
  const rows = await tx
    .select({ id: org.invoices.id, v: org.invoices.payTokenVersion })
    .from(org.invoices)
    .where(and(gt(org.invoices.payTokenVersion, 0), isNull(org.invoices.payTokenHash)))
    .all();
  for (const r of rows)
    await tx
      .update(org.invoices)
      .set({ payTokenHash: hashToken(payToken(ctx, orgId, r.id, r.v)) })
      .where(eq(org.invoices.id, r.id));
  return rows.length;
}

/** Turn online payment on or off for one invoice. Finalized invoices get a link right away. */
export async function setOnlinePay(
  ctx: AppContext,
  orgId: string,
  a: ActorInfo,
  invoiceId: string,
  enabled: boolean,
) {
  const h = await ctx.orgs.mustOpen(orgId);
  await h.write(async (tx) => {
    const inv = await mustGetInvoice(tx, invoiceId);
    if (inv.status === "void") throw conflict("This invoice is void.", "invalid_state");
    await tx.update(org.invoices).set({ onlinePayEnabled: enabled }).where(eq(org.invoices.id, inv.id));
    await appendAudit(tx, orgId, a, {
      action: "invoice.online_pay_update",
      targetType: "invoice",
      targetId: inv.id,
      before: { online_pay_enabled: inv.onlinePayEnabled },
      after: { online_pay_enabled: enabled },
    });
    if (enabled && inv.payTokenVersion === 0 && inv.entryId) await issuePayLinkTx(tx, orgId, a, inv.id, 1);
    await storePayTokenHashesTx(ctx, tx, orgId);
  });
  return mustGetInvoice(h.db, invoiceId);
}

/** New link version (owner): the old link stops working. */
export async function rotatePayLink(ctx: AppContext, orgId: string, a: ActorInfo, invoiceId: string) {
  assertCanManage(a);
  const h = await ctx.orgs.mustOpen(orgId);
  await h.write(async (tx) => {
    const inv = await mustGetInvoice(tx, invoiceId);
    if (inv.payTokenVersion === 0) throw conflict("This invoice has no pay link yet.", "invalid_state");
    await issuePayLinkTx(tx, orgId, a, inv.id, inv.payTokenVersion + 1);
    await storePayTokenHashesTx(ctx, tx, orgId);
  });
  return mustGetInvoice(h.db, invoiceId);
}

type PayPageKind = "unavailable" | "paid" | "processing" | "cancelled" | "too_small";

export type PayPage =
  | { kind: "redirect"; url: string }
  | {
      kind: "page";
      page: PayPageKind;
      orgName: string | null;
      invoiceNumber: string | null;
      payUrl?: string;
    };

const UNAVAILABLE: PayPage = { kind: "page", page: "unavailable", orgName: null, invoiceNumber: null };
/** Checkout sessions are reused while they have at least this long left. */
const SESSION_REUSE_MARGIN_MS = 10 * 60_000;

async function findByToken(ctx: AppContext, h: OrgHandle, orgId: string, token: string) {
  const hash = hashToken(token);
  const byHash = () => h.db.select().from(org.invoices).where(eq(org.invoices.payTokenHash, hash)).get();
  let inv = await byHash();
  // Only take the write lock when some issued link still lacks its hash, so random tokens stay reads.
  const unhashed = async () =>
    h.db
      .select({ id: org.invoices.id })
      .from(org.invoices)
      .where(and(gt(org.invoices.payTokenVersion, 0), isNull(org.invoices.payTokenHash)))
      .get();
  if (!inv && (await unhashed()) && (await h.write((tx) => storePayTokenHashesTx(ctx, tx, orgId))))
    inv = await byHash();
  return inv ?? null;
}

/**
 * The customer opened a pay link: send them to Checkout for the balance due, or explain why not.
 * Unknown orgs and tokens get the same page as any unavailable invoice, without names.
 */
export async function openPayLink(
  ctx: AppContext,
  orgId: string,
  token: string,
  opts: { returned?: "success" | "cancel" | null } = {},
): Promise<PayPage> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return UNAVAILABLE;
  const reg = await ctx.orgs.get(orgId).catch(() => null);
  if (!reg || reg.archivedAt) return UNAVAILABLE;
  const h = await ctx.orgs.open(orgId);
  if (!h) return UNAVAILABLE;
  let inv = await findByToken(ctx, h, orgId, token);
  if (!inv) return UNAVAILABLE;
  const s = await settingsRow(h.db);
  const page = (p: PayPageKind): PayPage => ({
    kind: "page",
    page: p,
    orgName: s.dba || reg.name || s.legalName,
    invoiceNumber: inv!.number,
    payUrl: p === "cancelled" ? payUrl(ctx, orgId, inv!) : undefined,
  });
  const provider = providerFor(ctx.secrets, s);
  if (!provider || !inv.onlinePayEnabled) return page("unavailable");
  if (!inv.payLinkOpenedAt) {
    const at = new Date().toISOString();
    await h.write((tx) =>
      tx.update(org.invoices).set({ payLinkOpenedAt: at }).where(eq(org.invoices.id, inv!.id)),
    );
  }
  if (opts.returned === "success" && inv.paySessionId) {
    await reconcileSession(ctx, orgId, inv.paySessionId).catch((e) =>
      ctx.logger.warn("pay link return: reconcile failed", { org_id: orgId, error: (e as Error).message }),
    );
    inv = await mustGetInvoice(h.db, inv.id);
  }
  if (inv.status === "draft" || inv.status === "void") return page("unavailable");
  const balance = inv.total - inv.amountPaid;
  if (inv.status === "paid" || balance <= 0) return page("paid");
  if (inv.onlinePayStatus === "processing") return page("processing");
  if (opts.returned === "cancel") return page("cancelled");
  if (opts.returned === "success") return page("processing");
  if (balance < MIN_ONLINE_PAYMENT_CENTS) return page("too_small");

  // Reuse an open session for the same amount, so a double click doesn't make two.
  if (
    inv.paySessionId &&
    inv.paySessionAmount === balance &&
    inv.paySessionExpiresAt &&
    Date.parse(inv.paySessionExpiresAt) > Date.now() + SESSION_REUSE_MARGIN_MS
  ) {
    const r = await provider.getSession(inv.paySessionId);
    if (r.kind === "open" && r.url) return { kind: "redirect", url: r.url };
    if (r.kind !== "open") {
      await reconcileSession(ctx, orgId, inv.paySessionId);
      const after = await mustGetInvoice(h.db, inv.id);
      if (after.status === "paid") return page("paid");
      if (after.onlinePayStatus === "processing") return page("processing");
    }
  }

  // Close the session this one replaces, so a tab still open on it can't pay (polling only watches
  // the latest session). If it completed meanwhile, record that instead of starting a new one.
  const fresh = await mustGetInvoice(h.db, inv.id);
  const prev = fresh.paySessionId;
  if (prev) {
    await provider.expireSession(prev).catch(() => undefined);
    const r = await reconcileSession(ctx, orgId, prev);
    if (r === "recorded" || r === "already_recorded" || r === "processing") {
      // Paid, or received and waiting on the bank or on review: don't invite a second payment.
      const after = await mustGetInvoice(h.db, inv.id);
      return page(after.status === "paid" ? "paid" : "processing");
    }
  }
  const balanceNow = inv.total - inv.amountPaid;
  if (balanceNow <= 0) return page("paid");

  const url = payUrl(ctx, orgId, inv);
  let created: Awaited<ReturnType<typeof createCheckout>>;
  try {
    created = await createCheckout(h, provider, fresh, {
      orgId,
      invoice: { id: inv.id, number: inv.number },
      amount: balanceNow,
      currency: inv.currency,
      methods: offeredMethods(stripeOptions(s)),
      successUrl: `${url}?return=success`,
      cancelUrl: `${url}?return=cancel`,
      // Keyed on the session this replaces: a double click gets the same new session back, and a
      // later replacement gets a fresh one rather than the session just closed. The attempt count
      // moves on after a failure, so a retry once the cause is fixed isn't Stripe's replay of it.
      idempotencyKey: `cosimo-pay-${inv.id}-${inv.payTokenVersion}-${balanceNow}-${prev ?? "first"}-${fresh.payAttempt}`,
    });
  } catch (e) {
    if (e instanceof ProviderError) {
      const at = new Date().toISOString();
      await h.write((tx) =>
        tx
          .update(org.invoices)
          .set({
            payError: scrubProviderText(e.message).slice(0, PAY_ERROR_MAX),
            payErrorAt: at,
            payAttempt: sql`${org.invoices.payAttempt} + 1`,
          })
          .where(eq(org.invoices.id, inv!.id)),
      );
    }
    throw e;
  }
  const { session, dropped } = created;
  // A method Stripe rejected stays on the invoice as a warning; otherwise a success clears the error.
  const warning = dropped
    ? `Stripe rejected ${METHOD_NAME[dropped]}; the customer was offered the other methods.`
    : null;
  await h.write((tx) =>
    tx
      .update(org.invoices)
      .set({
        paySessionId: session.id,
        paySessionAmount: balanceNow,
        paySessionExpiresAt: session.expiresAt,
        payError: warning,
        payErrorAt: warning ? new Date().toISOString() : null,
        ...(dropped ? { payAttempt: sql`${org.invoices.payAttempt} + 1` } : {}),
      })
      .where(eq(org.invoices.id, inv!.id)),
  );
  return { kind: "redirect", url: session.url };
}

/**
 * The method a Stripe 400 on `payment_method_types` says isn't active in the account, or null.
 * Stripe's message: "The payment method type provided: customer_balance is invalid...".
 */
function rejectedMethod(e: ProviderError, methods: PaymentMethodType[]): PaymentMethodType | null {
  if (e.status !== 400 || e.param !== "payment_method_types") return null;
  return methods.find((m) => new RegExp(`\\b${m}\\b`).test(e.message)) ?? null;
}

/**
 * Create the checkout session, recovering once from each of two causes, so a loop is impossible:
 * - the saved Stripe customer doesn't exist in this account or mode (the key was switched): make a
 *   new customer and retry;
 * - a method isn't active in Stripe: record that and retry without it, while another remains.
 * Every retry uses its own idempotency key, since the request changed.
 */
async function createCheckout(
  h: OrgHandle,
  provider: PaymentProvider,
  inv: InvoiceRow,
  base: Omit<CreateSessionInput, "customerId">,
) {
  let customerId = await ensureProviderCustomer(h, provider, inv.customerId);
  let { methods, idempotencyKey } = base;
  let recreated = false;
  let dropped: PaymentMethodType | null = null;
  for (;;) {
    try {
      const session = await provider.createSession({ ...base, methods, customerId, idempotencyKey });
      return { session, dropped };
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      if (!recreated && e.code === "resource_missing" && e.param === "customer") {
        recreated = true;
        customerId = await replaceProviderCustomer(h, provider, inv.customerId, customerId);
        idempotencyKey = `${idempotencyKey}-${customerId}`;
        continue;
      }
      const bad: PaymentMethodType | null = dropped ? null : rejectedMethod(e, methods);
      if (bad) await recordInactiveMethod(h, bad);
      if (bad && methods.length > 1) {
        dropped = bad;
        methods = methods.filter((m) => m !== bad);
        idempotencyKey = `${idempotencyKey}-without-${bad}`;
        continue;
      }
      throw e;
    }
  }
}

/** Add a method to the stored setup check's inactive list, so later checkouts leave it out. */
async function recordInactiveMethod(h: OrgHandle, method: PaymentMethodType) {
  await h.write((tx) =>
    patchOptionsTx(tx, (o) => {
      const c = (o.setup_check ?? {
        checked_at: new Date().toISOString(),
        missing: [],
        inactive_methods: [],
        unknown_methods: [],
        missing_events: [],
      }) as StoredSetupCheck;
      const inactive = Array.isArray(c.inactive_methods) ? c.inactive_methods : [];
      if (!inactive.includes(method)) c.inactive_methods = [...inactive, method];
      if (Array.isArray(c.unknown_methods)) c.unknown_methods = c.unknown_methods.filter((m) => m !== method);
      o.setup_check = c;
    }),
  );
}

async function ensureProviderCustomer(h: OrgHandle, provider: PaymentProvider, contactId: string) {
  const known = await h.db
    .select()
    .from(org.providerCustomers)
    .where(
      and(eq(org.providerCustomers.contactId, contactId), eq(org.providerCustomers.provider, provider.name)),
    )
    .get();
  if (known) return known.providerCustomerId;
  const c = await mustGetContact(h.db, contactId);
  const id = await provider.ensureCustomer({ id: c.id, name: c.name, email: c.email });
  await h.write((tx) =>
    tx
      .insert(org.providerCustomers)
      .values({ contactId, provider: provider.name, providerCustomerId: id })
      .onConflictDoNothing(),
  );
  return id;
}

/**
 * The saved customer isn't in this Stripe account or mode: forget it and create another. The key
 * is new, because the per-contact key would replay the customer that's gone.
 */
async function replaceProviderCustomer(
  h: OrgHandle,
  provider: PaymentProvider,
  contactId: string,
  missingId: string,
) {
  await h.write((tx) =>
    tx
      .delete(org.providerCustomers)
      .where(
        and(
          eq(org.providerCustomers.contactId, contactId),
          eq(org.providerCustomers.provider, provider.name),
          eq(org.providerCustomers.providerCustomerId, missingId),
        ),
      ),
  );
  const c = await mustGetContact(h.db, contactId);
  const id = await provider.ensureCustomer(
    { id: c.id, name: c.name, email: c.email },
    `cosimo-customer-${c.id}-${Date.now()}`,
  );
  await h.write((tx) =>
    tx
      .insert(org.providerCustomers)
      .values({ contactId, provider: provider.name, providerCustomerId: id })
      .onConflictDoNothing(),
  );
  return id;
}

// ----------------------------------------------------------------------------- recording

export type ReconcileResult =
  | "recorded"
  | "already_recorded"
  | "processing"
  | "failed"
  | "expired"
  | "open"
  | "ignored";

/**
 * The single recording path. Fetches the session from the provider and brings Cosimo in line:
 * processing marks the invoice; failed or expired clears its session; succeeded records the payment
 * into the clearing account and the fee against it, once.
 */
export async function reconcileSession(
  ctx: AppContext,
  orgId: string,
  sessionId: string,
): Promise<ReconcileResult> {
  const h = await ctx.orgs.mustOpen(orgId);
  const provider = providerFor(ctx.secrets, await settingsRow(h.db));
  if (!provider) return "ignored";
  const r = await provider.getSession(sessionId);
  switch (r.kind) {
    case "open":
      return "open";
    case "payment_processing":
      if (r.invoiceId)
        await h.write((tx) =>
          tx
            .update(org.invoices)
            .set({ onlinePayStatus: "processing" })
            .where(and(eq(org.invoices.id, r.invoiceId!), inArray(org.invoices.status, ["sent", "partial"]))),
        );
      return "processing";
    case "payment_failed":
    case "expired":
      if (r.invoiceId) await clearSession(h, orgId, r.invoiceId, sessionId, r.kind);
      return r.kind === "expired" ? "expired" : "failed";
    case "payment_succeeded":
      return recordSucceeded(h, orgId, provider, r);
  }
}

async function clearSession(h: OrgHandle, orgId: string, invoiceId: string, sessionId: string, why: string) {
  await h.write(async (tx) => {
    const inv = await tx.select().from(org.invoices).where(eq(org.invoices.id, invoiceId)).get();
    if (!inv || inv.paySessionId !== sessionId) return;
    await tx
      .update(org.invoices)
      .set({ onlinePayStatus: null, paySessionId: null, paySessionAmount: null, paySessionExpiresAt: null })
      .where(eq(org.invoices.id, inv.id));
    await appendAudit(tx, orgId, STRIPE_ACTOR, {
      action: why === "expired" ? "invoice.online_payment_expired" : "invoice.online_payment_failed",
      targetType: "invoice",
      targetId: inv.id,
      after: { session_id: sessionId },
    });
  });
}

/** Why a provider payment must wait for a person, or null when it matches an open invoice. */
function mismatch(inv: InvoiceRow | null, gross: number, currency: string): string | null {
  if (!inv) return "The online payment doesn't match an invoice in Cosimo.";
  if (inv.status === "void")
    return `Invoice ${inv.number} is void; the online payment stays as customer credit.`;
  if (inv.status === "draft") return `Invoice ${inv.number} is not posted yet.`;
  const balance = inv.total - inv.amountPaid;
  if (inv.status === "paid" || balance <= 0)
    return `Invoice ${inv.number} is already paid; the online payment stays as customer credit.`;
  if (currency !== inv.currency) return `The payment is in ${currency}, the invoice in ${inv.currency}.`;
  if (gross > balance)
    return `Overpayment: ${formatCents(gross)} received against a balance of ${formatCents(balance)} on invoice ${inv.number}; the difference stays as customer credit.`;
  return null;
}

async function recordSucceeded(
  h: OrgHandle,
  orgId: string,
  provider: PaymentProvider,
  r: Extract<SessionResult, { kind: "payment_succeeded" }>,
): Promise<ReconcileResult> {
  try {
    return await recordSucceededTx(h, orgId, provider, r);
  } catch (e) {
    // Another path recorded the same payment first: its transaction won, this one rolled back.
    if (/UNIQUE constraint failed: provider_payments/.test(errorText(e))) return "already_recorded";
    throw e;
  }
}

function errorText(e: unknown) {
  const parts: string[] = [];
  for (let cur: unknown = e, i = 0; cur && i < 5; cur = (cur as { cause?: unknown }).cause, i++)
    parts.push(String((cur as Error)?.message ?? cur));
  return parts.join("\n");
}

async function recordSucceededTx(
  h: OrgHandle,
  orgId: string,
  provider: PaymentProvider,
  r: Extract<SessionResult, { kind: "payment_succeeded" }>,
): Promise<ReconcileResult> {
  return h.write(async (tx) => {
    const seen = await tx
      .select()
      .from(org.providerPayments)
      .where(
        and(
          eq(org.providerPayments.provider, provider.name),
          eq(org.providerPayments.providerPaymentId, r.paymentId),
        ),
      )
      .get();
    const inv = r.invoiceId
      ? ((await tx.select().from(org.invoices).where(eq(org.invoices.id, r.invoiceId)).get()) ?? null)
      : null;
    const clear = async () => {
      if (!inv) return;
      const patch: Partial<typeof org.invoices.$inferInsert> = { onlinePayStatus: null };
      if (inv.paySessionId === r.sessionId)
        Object.assign(patch, { paySessionId: null, paySessionAmount: null, paySessionExpiresAt: null });
      await tx.update(org.invoices).set(patch).where(eq(org.invoices.id, inv.id));
    };
    if (seen) {
      await clear();
      return "already_recorded";
    }
    const s = await settingsRow(tx);
    if (!s.paymentClearingAccountId || !s.paymentFeeAccountId)
      throw new Error("Online payments have no clearing or fee account set.");
    let contactId = inv?.customerId ?? null;
    if (!contactId && r.customerId) {
      const pc = await tx
        .select()
        .from(org.providerCustomers)
        .where(
          and(
            eq(org.providerCustomers.provider, provider.name),
            eq(org.providerCustomers.providerCustomerId, r.customerId),
          ),
        )
        .get();
      contactId = pc?.contactId ?? null;
    }
    if (!contactId)
      throw new Error(`No customer in Cosimo matches the ${provider.name} payment ${r.paymentId}.`);

    const off = mismatch(inv, r.gross, r.currency);
    // An open invoice gets up to its balance; an overpayment's rest stays as credit once approved.
    const applyAmount =
      inv && (!off || off.startsWith("Overpayment")) ? Math.min(r.gross, inv.total - inv.amountPaid) : 0;
    let reason = off;
    const lock = checkLock(r.paidAt, s, { actor: STRIPE_ACTOR.actor, role: STRIPE_ACTOR.role });
    if (!reason && !lock.ok) reason = `The payment date ${r.paidAt} is in a locked period.`;
    const method = METHOD_LABEL[r.methodType ?? ""] ?? r.methodType ?? "online";
    const context = {
      provider_payment: {
        provider: provider.name,
        payment_id: r.paymentId,
        session_id: r.sessionId,
        invoice_id: r.invoiceId,
        gross: r.gross,
        fee: r.fee,
      },
    };
    const out = await recordPaymentTx(
      tx,
      orgId,
      STRIPE_ACTOR,
      {
        direction: "received",
        contact_id: contactId,
        date: r.paidAt,
        amount: r.gross,
        account_id: s.paymentClearingAccountId,
        method: provider.name,
        reference: r.paymentId,
        memo: `Paid online by ${method}${inv ? `, invoice ${inv.number}` : ""}`,
        applications: inv && applyAmount > 0 ? [{ document_id: inv.id, amount: applyAmount }] : [],
      },
      { requireReview: reason ?? undefined, reviewContext: context },
    );
    // The unique key is the backstop: a concurrent recording of the same payment fails here and the
    // whole transaction, payment included, rolls back.
    await tx.insert(org.providerPayments).values({
      provider: provider.name,
      providerPaymentId: r.paymentId,
      paymentId: out.payment.id,
      invoiceId: inv?.id ?? null,
      gross: r.gross,
      fee: r.fee,
      methodType: r.methodType,
      balanceTxnId: r.balanceTxnId,
    });
    if (r.fee) {
      const feeEntryId = await postFeeTx(tx, orgId, s, {
        paymentId: out.payment.id,
        date: r.paidAt,
        fee: r.fee,
        invoiceNumber: inv?.number ?? null,
        reason:
          reason ??
          (out.result.entry.status === "posted" ? null : "The payment it belongs to is waiting for review."),
      });
      await tx
        .update(org.providerPayments)
        .set({ feeEntryId })
        .where(
          and(
            eq(org.providerPayments.provider, provider.name),
            eq(org.providerPayments.providerPaymentId, r.paymentId),
          ),
        );
    }
    await clear();
    return "recorded";
  });
}

/** The provider's fee: Dr fee account, Cr clearing, linked to the payment. */
async function postFeeTx(
  tx: OrgTx,
  orgId: string,
  s: SettingsRow,
  f: { paymentId: string; date: string; fee: number; invoiceNumber: string | null; reason: string | null },
) {
  const memo = `Stripe fee${f.invoiceNumber ? `, invoice ${f.invoiceNumber}` : ""}`;
  const r = await submitEntryTx(
    tx,
    orgId,
    STRIPE_ACTOR,
    {
      date: f.date,
      memo,
      lines: [
        { accountId: s.paymentFeeAccountId!, amount: f.fee, description: memo },
        { accountId: s.paymentClearingAccountId!, amount: -f.fee, description: memo },
      ],
      sourceType: "payment_fee",
      sourceId: f.paymentId,
    },
    { requireReview: f.reason ?? undefined },
  );
  return r.entry.id;
}

/** Bank payments settle later: post fees that weren't known when the payment was recorded. */
export async function fillMissingFees(ctx: AppContext, orgId: string) {
  const h = await ctx.orgs.mustOpen(orgId);
  const provider = providerFor(ctx.secrets, await settingsRow(h.db));
  if (!provider) return 0;
  const rows = await h.db
    .select()
    .from(org.providerPayments)
    .where(and(eq(org.providerPayments.provider, provider.name), isNull(org.providerPayments.fee)))
    .all();
  let filled = 0;
  for (const row of rows) if (await fillFeeFor(h, orgId, provider, row)) filled++;
  return filled;
}

type ProviderPaymentRow = typeof org.providerPayments.$inferSelect;

async function findProviderPayment(db: Reader, provider: string, providerPaymentId: string) {
  return db
    .select()
    .from(org.providerPayments)
    .where(
      and(
        eq(org.providerPayments.provider, provider),
        eq(org.providerPayments.providerPaymentId, providerPaymentId),
      ),
    )
    .get();
}

/**
 * Post the fee of one recorded payment, once the provider has settled it. The webhook
 * (`charge.updated`) and the polling job can both get here for the same payment: the fee is
 * rechecked inside the write, so only the first posts it. Returns whether this call posted it.
 */
async function fillFeeFor(h: OrgHandle, orgId: string, provider: PaymentProvider, row: ProviderPaymentRow) {
  const f = await provider.paymentFee(row.providerPaymentId);
  if (!f) return false;
  return h.write(async (tx) => {
    const cur = await tx
      .select()
      .from(org.providerPayments)
      .where(
        and(
          eq(org.providerPayments.provider, row.provider),
          eq(org.providerPayments.providerPaymentId, row.providerPaymentId),
        ),
      )
      .get();
    if (!cur || cur.fee !== null) return false;
    const p = await tx.select().from(org.payments).where(eq(org.payments.id, cur.paymentId)).get();
    const pe = p?.entryId
      ? await tx.select().from(org.journalEntries).where(eq(org.journalEntries.id, p.entryId)).get()
      : null;
    const inv = cur.invoiceId
      ? await tx.select().from(org.invoices).where(eq(org.invoices.id, cur.invoiceId)).get()
      : null;
    let feeEntryId: string | null = null;
    if (f.fee > 0 && p && !p.voidedAt)
      feeEntryId = await postFeeTx(tx, orgId, await settingsRow(tx), {
        paymentId: cur.paymentId,
        date: p.date,
        fee: f.fee,
        invoiceNumber: inv?.number ?? null,
        reason: pe?.status === "posted" ? null : "The payment it belongs to is waiting for review.",
      });
    await tx
      .update(org.providerPayments)
      .set({ fee: f.fee, feeEntryId, balanceTxnId: f.balanceTxnId })
      .where(
        and(
          eq(org.providerPayments.provider, row.provider),
          eq(org.providerPayments.providerPaymentId, row.providerPaymentId),
        ),
      );
    return true;
  });
}

/**
 * A charge got its balance transaction, so its fee is known. A payment already recorded without
 * its fee gets the fee now. One not recorded yet (this event beat `checkout.session.completed`) is
 * reconciled from its session, which records the payment with the fee; a charge that isn't from a
 * Checkout session isn't Cosimo's and is ignored.
 */
async function chargeUpdated(
  ctx: AppContext,
  h: OrgHandle,
  orgId: string,
  provider: PaymentProvider,
  paymentIntentId: string,
): Promise<"recorded" | "ignored"> {
  let row = await findProviderPayment(h.db, provider.name, paymentIntentId);
  let recorded = false;
  if (!row) {
    const sessionId = await provider.sessionForPaymentIntent(paymentIntentId);
    if (!sessionId) return "ignored";
    recorded = (await reconcileSession(ctx, orgId, sessionId)) === "recorded";
    // Recorded here with the fee, or by another path meanwhile, maybe before the fee was known.
    row = await findProviderPayment(h.db, provider.name, paymentIntentId);
  }
  if (row && row.fee === null && (await fillFeeFor(h, orgId, provider, row))) recorded = true;
  return recorded ? "recorded" : "ignored";
}

// ----------------------------------------------------------------------------- webhooks and polling

async function processEvent(
  ctx: AppContext,
  h: OrgHandle,
  orgId: string,
  provider: PaymentProvider,
  rowId: string,
  ev: ProviderEvent,
) {
  let result: "recorded" | "ignored" | "unhandled" | "error" = "ignored";
  let error: string | null = null;
  try {
    if (ev.kind === "unhandled") result = "unhandled";
    else if (ev.kind === "charge") result = await chargeUpdated(ctx, h, orgId, provider, ev.paymentIntentId);
    else if (ev.kind === "session" || ev.kind === "payment_intent") {
      const sessionId =
        ev.kind === "session" ? ev.sessionId : await provider.sessionForPaymentIntent(ev.paymentIntentId);
      if (sessionId)
        result = (await reconcileSession(ctx, orgId, sessionId)) === "recorded" ? "recorded" : "ignored";
    }
  } catch (e) {
    result = "error";
    error = String((e as Error)?.message ?? e).slice(0, 1000);
    ctx.logger.warn("payment webhook processing failed", {
      org_id: orgId,
      event: ev.id,
      type: ev.type,
      error,
    });
  }
  // A failed event keeps processed_at empty so the polling job retries it.
  await h.write((tx) =>
    tx
      .update(org.providerEvents)
      .set({ result, error, processedAt: result === "error" ? null : new Date().toISOString() })
      .where(eq(org.providerEvents.id, rowId)),
  );
  return result;
}

/**
 * Receive a webhook: verify the signature, store the event once (a redelivery is a no-op), and
 * process it. `done` settles when processing finishes; the HTTP handler answers without waiting.
 */
export async function handlePaymentWebhook(
  ctx: AppContext,
  providerName: string,
  orgId: string,
  rawBody: string,
  signature: string | undefined,
): Promise<{ action: string; done: Promise<unknown> }> {
  if (providerName !== "stripe") throw notFound("Payment provider");
  const reg = await ctx.orgs.get(orgId).catch(() => null);
  const h = reg ? await ctx.orgs.open(orgId) : null;
  if (!h) throw notFound("Organization");
  const provider = providerFor(ctx.secrets, await settingsRow(h.db));
  if (!provider) throw badRequest("Online payments are not set up.", undefined, "payments_not_configured");
  let ev: ProviderEvent;
  try {
    ev = provider.verifyWebhook(signature, rawBody);
  } catch (e) {
    if (e instanceof WebhookSignatureError)
      throw new ApiError(401, "invalid_signature", "Webhook signature verification failed.");
    throw e;
  }
  const rowId = newId();
  const inserted = await h.write((tx) =>
    tx
      .insert(org.providerEvents)
      .values({ id: rowId, provider: provider.name, eventId: ev.id, type: ev.type })
      .onConflictDoNothing()
      .returning({ id: org.providerEvents.id }),
  );
  if (!inserted.length) return { action: "duplicate", done: Promise.resolve() };
  return { action: ev.kind, done: processEvent(ctx, h, orgId, provider, rowId, ev) };
}

/**
 * Webhooks off: poll every 15 minutes. Webhooks on: a safety net every 6 hours, or every 15
 * minutes while a recorded payment waits for its fee or a webhook event waits for a retry.
 */
export const POLL_MINUTES_WITHOUT_WEBHOOK = 15;
export const POLL_HOURS_WITH_WEBHOOK = 6;

/** Retry window for events whose processing failed. */
const EVENT_RETRY_DAYS = 7;

/** How often the polling job should run for this org, in ms, or null when it has nothing to do. */
export async function pollInterval(ctx: AppContext, orgId: string): Promise<number | null> {
  const h = await ctx.orgs.open(orgId);
  if (!h) return null;
  const s = await settingsRow(h.db);
  if (s.paymentProvider !== "stripe") return null;
  const c = stripeSecrets(ctx.secrets, s);
  if (!c) return null;
  const soon = POLL_MINUTES_WITHOUT_WEBHOOK * 60_000;
  if (!c.webhook_secret) return soon;
  const feeDue = await h.db
    .select({ id: org.providerPayments.providerPaymentId })
    .from(org.providerPayments)
    .where(isNull(org.providerPayments.fee))
    .limit(1)
    .get();
  if (feeDue) return soon;
  const since = new Date(Date.now() - EVENT_RETRY_DAYS * 86_400_000).toISOString();
  const retry = await h.db
    .select({ id: org.providerEvents.id })
    .from(org.providerEvents)
    .where(and(isNull(org.providerEvents.processedAt), gt(org.providerEvents.receivedAt, since)))
    .limit(1)
    .get();
  return retry ? soon : POLL_HOURS_WITH_WEBHOOK * 3_600_000;
}

/**
 * An endpoint registered by an older release lacks newer events (`charge.updated`): add them. A
 * failure is logged and reported by doctor; the job goes on, and tries again on its next run.
 */
async function updateWebhookEvents(ctx: AppContext, h: OrgHandle, orgId: string) {
  const s = await settingsRow(h.db);
  const c = stripeSecrets(ctx.secrets, s);
  if (!c?.webhook_endpoint_id || stripeOptions(s).webhook_events_version >= WEBHOOK_EVENTS_VERSION) return;
  const err = await syncWebhookEvents(c.secret_key, c.webhook_endpoint_id);
  if (err) {
    ctx.logger.warn("could not update the Stripe webhook endpoint's events", { org_id: orgId, error: err });
    return;
  }
  await h.write((tx) => patchOptionsTx(tx, (o) => (o.webhook_events_version = WEBHOOK_EVENTS_VERSION)));
}

/**
 * The polling job: reconcile invoices with an open or processing checkout, retry failed webhook
 * events, and post fees that have settled since.
 */
export async function pollPayments(ctx: AppContext, orgId: string) {
  const h = await ctx.orgs.mustOpen(orgId);
  const provider = providerFor(ctx.secrets, await settingsRow(h.db));
  const out = { reconciled: 0, recorded: 0, events: 0, fees: 0, failed: 0 };
  if (!provider) return out;
  await updateWebhookEvents(ctx, h, orgId);
  const open = await h.db
    .select({ id: org.invoices.id, sessionId: org.invoices.paySessionId })
    .from(org.invoices)
    .where(or(isNotNull(org.invoices.paySessionId), eq(org.invoices.onlinePayStatus, "processing")))
    .all();
  for (const inv of open) {
    if (!inv.sessionId) continue;
    try {
      const r = await reconcileSession(ctx, orgId, inv.sessionId);
      out.reconciled++;
      if (r === "recorded") out.recorded++;
    } catch (e) {
      out.failed++;
      ctx.logger.warn("payment poll failed", {
        org_id: orgId,
        invoice_id: inv.id,
        error: (e as Error).message,
      });
    }
  }
  const since = new Date(Date.now() - EVENT_RETRY_DAYS * 86_400_000).toISOString();
  const pending = await h.db
    .select()
    .from(org.providerEvents)
    .where(and(isNull(org.providerEvents.processedAt), gt(org.providerEvents.receivedAt, since)))
    .all();
  for (const row of pending) {
    try {
      const ev = await provider.fetchEvent(row.eventId);
      const r = await processEvent(ctx, h, orgId, provider, row.id, ev);
      out.events++;
      if (r === "error") out.failed++;
    } catch (e) {
      out.failed++;
      ctx.logger.warn("payment event retry failed", {
        org_id: orgId,
        event: row.eventId,
        error: (e as Error).message,
      });
    }
  }
  try {
    out.fees = await fillMissingFees(ctx, orgId);
  } catch (e) {
    out.failed++;
    ctx.logger.warn("payment fee fill failed", { org_id: orgId, error: (e as Error).message });
  }
  return out;
}
