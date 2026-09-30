/**
 * Online invoice payments API (#55): provider settings (owner), per-invoice online payment and
 * link rotation, the provider webhook, and the customer-facing pay link at /pay/{orgId}/{token}.
 */
import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { AppContext } from "../../context.ts";
import { invoiceView } from "../../services/documents.ts";
import {
  getSettings,
  handlePaymentWebhook,
  invoiceCashBalance,
  openPayLink,
  type PayPage,
  payLinker,
  rotatePayLink,
  saveSettings,
  setOnlinePay,
  testConnection,
} from "../../services/online-payments.ts";
import { PAYMENT_METHOD_TYPES } from "../../services/payment-providers/types.ts";
import { clientIp, rateLimit, requireOwner, requireWriter } from "../middleware.ts";
import { bearerSecurity, errorResponses, Id, json, jsonBody, newRouter, OrgParams, z } from "../openapi.ts";
import type { AppEnv } from "../types.ts";
import { InvoiceSchema } from "./documents.ts";

const tags = ["Online payments"];

const Method = z.enum(PAYMENT_METHOD_TYPES);

const Permission = z.object({
  name: z.string().describe("As the Stripe dashboard names it, for example `Customers: Write`."),
  ok: z.boolean().nullable().describe("Null when Cosimo couldn't check it."),
  detail: z.string().nullable(),
});

const MethodCheck = z.object({
  type: Method,
  status: z
    .enum(["active", "inactive", "pending", "unknown"])
    .describe("`unknown` when the key can't read the account (Account: Read is optional)."),
  detail: z.string().nullable(),
});

const SetupCheckSchema = z
  .object({
    checked_at: z.string(),
    missing: z.array(z.string()).describe("Permissions the key lacks."),
    inactive_methods: z.array(Method).describe("Methods not active in Stripe; checkouts leave them out."),
    unknown_methods: z.array(Method),
    missing_events: z.array(z.string()).describe("Events the webhook endpoint doesn't send."),
  })
  .nullable()
  .describe("The last check of the key's permissions and the payment methods (Save or Test connection).");

const SettingsSchema = z
  .object({
    provider: z.enum(["off", "manual_link", "stripe"]),
    secret_key_set: z.boolean().describe("A Stripe key is stored. Keys are never returned."),
    webhook_secret_set: z.boolean(),
    webhook_mode: z
      .enum(["registered", "manual", "polling"])
      .nullable()
      .describe(
        "`registered`: Cosimo created the webhook endpoint; `manual`: a signing secret was pasted; `polling`: no webhook, Cosimo checks every 15 minutes.",
      ),
    webhook_url: z
      .string()
      .nullable()
      .describe("The webhook URL for this org; null without a public HTTPS URL."),
    methods: z.array(Method),
    account_name: z.string().nullable(),
    livemode: z.boolean().nullable().describe("False for a test-mode key."),
    clearing_account_id: z.string().nullable(),
    fee_account_id: z.string().nullable(),
    refund_account_id: z
      .string()
      .nullable()
      .describe("Stripe refunds are debited here (Refunds and Allowances unless chosen)."),
    chargeback_account_id: z
      .string()
      .nullable()
      .describe("Amounts Stripe takes back for disputes are debited here (Chargebacks unless chosen)."),
    online_pay_default: z.boolean(),
    last_event_at: z.string().nullable(),
    setup_check: SetupCheckSchema,
    webhook_events: z.array(z.string()).describe("The events a webhook endpoint set up by hand must send."),
    last_pay_error: z
      .object({
        invoice_id: z.string(),
        number: z.string(),
        at: z.string().nullable(),
        message: z.string(),
      })
      .nullable()
      .describe("The invoice whose pay link failed most recently, with Stripe's reason."),
  })
  .openapi("OnlinePaymentSettings");

const SettingsInput = z.object({
  provider: z.enum(["off", "manual_link", "stripe"]),
  secret_key: z.string().trim().min(1).max(300).optional().openapi({
    description: "Stripe secret (sk_) or restricted (rk_) key. Omit to keep the stored key.",
  }),
  webhook_secret: z.string().trim().max(300).nullable().optional().openapi({
    description:
      "Fallback when Cosimo can't register the webhook itself: the endpoint's signing secret (whsec_...). Null clears it.",
  }),
  methods: z.array(Method).min(1).max(3).optional(),
  clearing_account_id: Id.nullable().optional(),
  fee_account_id: Id.nullable().optional(),
  refund_account_id: Id.nullable().optional().describe("An active income or expense account."),
  chargeback_account_id: Id.nullable().optional().describe("An active expense account."),
  online_pay_default: z.boolean().optional(),
});

const InvoiceParams = OrgParams.extend({
  invoiceId: Id.openapi({ param: { name: "invoiceId", in: "path" } }),
});

export function onlinePaymentRoutes() {
  const r = newRouter();

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/online-payments",
      tags,
      summary: "Online payment settings (owner; secrets are never returned)",
      security: bearerSecurity,
      request: { params: OrgParams },
      responses: { 200: json(SettingsSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireOwner(c);
      return c.json(await getSettings(c.get("ctx"), o.id, o.actor), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "put",
      path: "/orgs/{orgId}/online-payments",
      tags,
      summary: "Set up online payments (owner)",
      description:
        "Stripe keys are checked with Stripe before they are stored, encrypted. On first setup Cosimo creates a Stripe Clearing account and uses (or creates) Bank and Merchant Fees, Refunds and Allowances, and Chargebacks unless you choose accounts. With an HTTPS public URL Cosimo registers the webhook endpoint in your Stripe account; otherwise it polls.",
      security: bearerSecurity,
      request: { params: OrgParams, body: jsonBody(SettingsInput) },
      responses: {
        200: json(
          SettingsSchema.extend({
            warning: z
              .string()
              .nullable()
              .describe(
                "What to fix in Stripe (missing permissions, inactive methods); the settings are saved.",
              ),
          }),
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = requireOwner(c);
      return c.json(await saveSettings(c.get("ctx"), o.id, o.actor, c.req.valid("json")), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/online-payments/test",
      tags,
      summary: "Check a Stripe key (the stored one, or one being entered) without saving",
      description:
        "Checks every permission Cosimo uses and whether the chosen payment methods are active. Testing the stored key also updates the stored check.",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        body: {
          ...jsonBody(z.object({ secret_key: z.string().trim().max(300).nullable().optional() })),
          required: false,
        },
      },
      responses: {
        200: json(
          z
            .object({
              account_name: z.string(),
              livemode: z.boolean(),
              permissions: z.array(Permission),
              methods: z.array(MethodCheck),
              missing_events: z
                .array(z.string())
                .nullable()
                .describe("Events the webhook endpoint doesn't send; null when it can't be read."),
            })
            .openapi("PaymentConnectionTest"),
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = requireOwner(c);
      const b = c.req.valid("json") ?? {};
      return c.json(await testConnection(c.get("ctx"), o.id, o.actor, b.secret_key), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/invoices/{invoiceId}/online-pay",
      tags: ["Invoices"],
      summary: "Turn online payment on or off for an invoice",
      description: "A finalized invoice gets its pay link when online payment is turned on.",
      security: bearerSecurity,
      request: { params: InvoiceParams, body: jsonBody(z.object({ enabled: z.boolean() })) },
      responses: { 200: json(InvoiceSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const ctx = c.get("ctx");
      const inv = await setOnlinePay(
        ctx,
        o.id,
        o.actor,
        c.req.valid("param").invoiceId,
        c.req.valid("json").enabled,
      );
      return c.json(await invoiceView(o.handle.db, inv, await payLinker(ctx, o.handle.db, o.id)), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/invoices/{invoiceId}/rotate-pay-link",
      tags: ["Invoices"],
      summary: "Replace the invoice's pay link (owner); the old link stops working",
      security: bearerSecurity,
      request: { params: InvoiceParams },
      responses: { 200: json(InvoiceSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireOwner(c);
      const ctx = c.get("ctx");
      const inv = await rotatePayLink(ctx, o.id, o.actor, c.req.valid("param").invoiceId);
      return c.json(await invoiceView(o.handle.db, inv, await payLinker(ctx, o.handle.db, o.id)), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/invoices/{invoiceId}/online-pay/cash-balance",
      tags: ["Invoices"],
      summary: "Funds Stripe holds for the invoice's customer that aren't applied to a payment",
      description:
        "Bank transfers Stripe received from the customer but couldn't match to a payment (Stripe returns them after 75 days). Read from Stripe when the stored balance is more than 5 minutes old; only for orgs that offer bank transfers.",
      security: bearerSecurity,
      request: { params: InvoiceParams },
      responses: {
        200: json(
          z
            .object({
              amount: z
                .number()
                .int()
                .nullable()
                .describe(
                  "Cents; null when the org doesn't offer bank transfers or the customer never checked out.",
                ),
              currency: z.string(),
              checked_at: z.string().nullable(),
              error: z
                .string()
                .nullable()
                .describe("Why the live read failed; the stored balance is returned."),
            })
            .openapi("CustomerCashBalance"),
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = requireWriter(c);
      return c.json(await invoiceCashBalance(c.get("ctx"), o.id, c.req.valid("param").invoiceId), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/webhooks/payments/{provider}/{orgId}",
      tags,
      summary: "Payment provider webhook receiver (verified with the provider's signature)",
      request: {
        params: OrgParams.extend({
          provider: z.enum(["stripe"]).openapi({ param: { name: "provider", in: "path" } }),
        }),
      },
      responses: {
        200: json(z.object({ received: z.literal(true), action: z.string() })),
        ...errorResponses,
      },
    }),
    async (c) => {
      const raw = await c.req.text();
      const p = c.req.valid("param");
      const ctx = c.get("ctx");
      const res = await handlePaymentWebhook(ctx, p.provider, p.orgId, raw, c.req.header("stripe-signature"));
      // Answer now; processing continues (and records failures for the polling job to retry).
      res.done.catch((e) => ctx.logger.warn("payment webhook failed", { org_id: p.orgId, error: String(e) }));
      return c.json({ received: true as const, action: res.action }, 200);
    },
  );

  return r;
}

// ----------------------------------------------------------------------------- customer pay link

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

type StatusPage = Exclude<PayPage, { kind: "redirect" }>;

const COPY: Record<StatusPage["page"] | "error", { title: string; body: string }> = {
  unavailable: {
    title: "This payment link isn't available",
    body: "It may have been replaced, or the invoice can't be paid online. Contact the business that sent it.",
  },
  paid: { title: "This invoice is paid", body: "Thank you. There is nothing left to pay." },
  processing: {
    title: "Your payment is processing",
    body: "Bank payments can take a few business days to arrive. There is nothing more to do; you don't need to pay again.",
  },
  cancelled: { title: "Payment not completed", body: "You left checkout before paying." },
  too_small: {
    title: "This amount can't be paid online",
    body: "This amount is below the minimum for online payment. Please pay another way.",
  },
  error: {
    title: "Online payment isn't working right now",
    body: "Please try again later, or contact the business that sent the invoice.",
  },
};

/**
 * A small server-rendered status page: org name and invoice number only, no scripts. An error page
 * shows the request ID as a reference the business can find in its server log.
 */
export function payPageHtml(
  p: Omit<StatusPage, "page"> & { page: StatusPage["page"] | "error"; reference?: string | null },
) {
  const copy = COPY[p.page];
  const heading =
    p.orgName && p.invoiceNumber
      ? `<p style="color:#666;margin:0 0 .5rem">${esc(p.orgName)} · Invoice ${esc(p.invoiceNumber)}</p>`
      : "";
  const again = p.payUrl ? `<p><a href="${esc(p.payUrl)}">Pay now</a></p>` : "";
  const ref = p.reference ? `<p style="color:#666;font-size:.85rem">Reference: ${esc(p.reference)}</p>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(copy.title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5">${heading}<h1 style="font-size:1.4rem">${esc(copy.title)}</h1><p>${esc(copy.body)}</p>${again}${ref}</body></html>`;
}

/** GET /pay/{orgId}/{token}: redirect to Checkout, or explain why not. */
export function mountPay(app: OpenAPIHono<AppEnv>, ctx: AppContext) {
  app.get("/pay/:orgId/:token", async (c) => {
    c.set("ip", clientIp(c));
    rateLimit(c, "pay", 30, 60_000);
    c.header("cache-control", "no-store");
    const ret = c.req.query("return");
    let res: PayPage;
    try {
      res = await openPayLink(ctx, c.req.param("orgId"), c.req.param("token"), {
        returned: ret === "success" || ret === "cancel" ? ret : null,
      });
    } catch (e) {
      const requestId = c.get("requestId");
      ctx.logger.warn("pay link failed", { error: (e as Error).message, request_id: requestId });
      return c.html(
        payPageHtml({
          kind: "page",
          page: "error",
          orgName: null,
          invoiceNumber: null,
          reference: requestId,
        }),
        503,
      );
    }
    if (res.kind === "redirect") return c.redirect(res.url, 303);
    return c.html(payPageHtml(res), res.page === "unavailable" ? 404 : 200);
  });
}
