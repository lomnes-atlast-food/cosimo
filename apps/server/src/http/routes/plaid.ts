/** Plaid bank feeds API (SPEC §7.1): status, Link, connections, sync, reauth, and webhooks. */
import { createRoute } from "@hono/zod-openapi";
import {
  createLinkToken,
  disconnect,
  exchangePublicToken,
  getConnection,
  handleWebhook,
  listConnections,
  markReconnected,
  plaidStatus,
  syncConnection,
} from "../../services/plaid.ts";
import { requireOwner, requireWriter } from "../middleware.ts";
import { bearerSecurity, errorResponses, Id, json, jsonBody, newRouter, OrgParams, z } from "../openapi.ts";

const tags = ["Bank feeds"];

const ConnectionSchema = z
  .object({
    id: z.string(),
    provider: z.literal("plaid"),
    institution_name: z.string().nullable(),
    status: z.enum(["active", "needs_reauth", "error", "disconnected"]),
    error_code: z.string().nullable(),
    message: z.string().nullable().describe("Plain-language status for people; null when healthy."),
    last_synced_at: z.string().nullable(),
    created_at: z.string(),
    accounts: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        mask: z.string().nullable(),
        kind: z.enum(["checking", "savings", "credit_card", "other"]),
        is_active: z.boolean(),
      }),
    ),
  })
  .openapi("BankConnection");

const SyncSummarySchema = z
  .object({
    added: z.number().int(),
    modified: z.number().int(),
    removed: z.number().int(),
    skipped: z.number().int(),
    transfers_paired: z.number().int(),
    rules_applied: z.number().int(),
  })
  .openapi("SyncSummary");

const ConnParams = OrgParams.extend({
  connectionId: Id.openapi({ param: { name: "connectionId", in: "path" } }),
});

const AccountChoiceSchema = z.discriminatedUnion("action", [
  z.object({
    account_id: z.string(),
    action: z.literal("new"),
    ledger_account_id: Id.nullable().optional(),
    name: z.string().trim().max(200).nullable().optional(),
  }),
  z.object({ account_id: z.string(), action: z.literal("link"), bank_account_id: Id }),
  z.object({ account_id: z.string(), action: z.literal("skip") }),
]);

export function plaidRoutes() {
  const r = newRouter();

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/plaid",
      tags,
      summary: "Whether Plaid is set up for this organization (keys are never returned)",
      security: bearerSecurity,
      request: { params: OrgParams },
      responses: {
        200: json(
          z
            .object({
              configured: z.boolean(),
              env: z.enum(["sandbox", "production"]).nullable(),
              source: z.enum(["org", "instance"]).nullable(),
              webhooks: z.boolean().describe("True when Plaid can reach this instance over public HTTPS."),
              redirect_uri: z.string().nullable(),
            })
            .openapi("PlaidStatus"),
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = c.get("org");
      return c.json(await plaidStatus(c.get("ctx"), o.handle.db, o.id), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/plaid/link-token",
      tags,
      summary: "Create a Plaid Link token (owner). Pass connection_id to reconnect (update mode).",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        body: { ...jsonBody(z.object({ connection_id: Id.nullable().optional() })), required: false },
      },
      responses: {
        200: json(
          z
            .object({ link_token: z.string(), expiration: z.string(), update_mode: z.boolean() })
            .openapi("LinkToken"),
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = requireOwner(c);
      const b = c.req.valid("json") ?? {};
      return c.json(
        await createLinkToken(c.get("ctx"), o.id, o.actor, { connectionId: b.connection_id }),
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/plaid/exchange",
      tags,
      summary: "Finish Plaid Link: store the connection, add or link bank accounts, and run the first sync",
      description:
        "`accounts` chooses per Plaid account: `new` (creates a bank account and, unless given, its ledger account), `link` (attach to an existing bank account; feed transactions on or before its last statement import are skipped), or `skip`. Deposit and card accounts default to `new`, others to `skip`.",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        body: jsonBody(
          z.object({
            public_token: z.string().min(1).max(500),
            accounts: z.array(AccountChoiceSchema).max(100).optional(),
          }),
        ),
      },
      responses: {
        201: json(
          z.object({ connection: ConnectionSchema, sync: SyncSummarySchema.nullable() }),
          "Connected",
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = requireOwner(c);
      return c.json(await exchangePublicToken(c.get("ctx"), o.id, o.actor, c.req.valid("json")), 201);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/bank-connections",
      tags,
      summary: "List bank feed connections and their status",
      security: bearerSecurity,
      request: { params: OrgParams },
      responses: { 200: json(z.object({ data: z.array(ConnectionSchema) })), ...errorResponses },
    }),
    async (c) => c.json({ data: await listConnections(c.get("org").handle.db) }, 200),
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/bank-connections/{connectionId}",
      tags,
      summary: "Get a bank feed connection",
      security: bearerSecurity,
      request: { params: ConnParams },
      responses: { 200: json(ConnectionSchema), ...errorResponses },
    }),
    async (c) => c.json(await getConnection(c.get("org").handle.db, c.req.valid("param").connectionId), 200),
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/bank-connections/{connectionId}/sync",
      tags,
      summary: "Fetch new, changed, and removed transactions now",
      security: bearerSecurity,
      request: { params: ConnParams },
      responses: { 200: json(SyncSummarySchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const s = await syncConnection(c.get("ctx"), o.id, c.req.valid("param").connectionId, {
        userId: o.actor.userId,
      });
      return c.json(s, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/bank-connections/{connectionId}/reconnected",
      tags,
      summary: "Mark a connection healthy after Link update mode succeeded, then sync (owner)",
      security: bearerSecurity,
      request: { params: ConnParams },
      responses: {
        200: json(z.object({ connection: ConnectionSchema, sync: SyncSummarySchema.nullable() })),
        ...errorResponses,
      },
    }),
    async (c) => {
      const o = requireOwner(c);
      return c.json(
        await markReconnected(c.get("ctx"), o.id, o.actor, c.req.valid("param").connectionId),
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/orgs/{orgId}/bank-connections/{connectionId}",
      tags,
      summary: "Disconnect a bank feed (owner). Imported transactions and bank accounts are kept.",
      security: bearerSecurity,
      request: { params: ConnParams },
      responses: { 200: json(ConnectionSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireOwner(c);
      return c.json(await disconnect(c.get("ctx"), o.id, o.actor, c.req.valid("param").connectionId), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/webhooks/plaid/{orgId}",
      tags,
      summary: "Plaid webhook receiver (verified with the Plaid-Verification signature)",
      request: { params: OrgParams },
      responses: {
        200: json(z.object({ received: z.literal(true), action: z.string() })),
        ...errorResponses,
      },
    }),
    async (c) => {
      const raw = await c.req.text();
      const res = await handleWebhook(
        c.get("ctx"),
        c.req.valid("param").orgId,
        raw,
        c.req.header("plaid-verification"),
      );
      return c.json({ received: true as const, action: res.action }, 200);
    },
  );

  return r;
}
