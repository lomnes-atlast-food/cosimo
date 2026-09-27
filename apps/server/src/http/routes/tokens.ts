import { createRoute } from "@hono/zod-openapi";
import { appendAudit } from "../../services/audit.ts";
import { forbidden, notFound } from "../errors.ts";
import { requireAuth, requireOwner, requireSession } from "../middleware.ts";
import {
  bearerSecurity,
  errorResponses,
  Id,
  json,
  jsonBody,
  newRouter,
  OkSchema,
  OrgParams,
  RoleSchema,
  z,
} from "../openapi.ts";

const TokenSchema = z
  .object({
    id: z.string(),
    user_id: z.string(),
    org_id: z.string(),
    name: z.string(),
    role: RoleSchema,
    propose_only: z.boolean(),
    last_used_at: z.string().nullable(),
    created_at: z.string(),
    revoked_at: z.string().nullable(),
  })
  .openapi("ApiToken");

type TokenRow = Awaited<ReturnType<import("../../services/users.ts").UserService["listApiTokens"]>>[number];
const view = (t: TokenRow) => ({
  id: t.id,
  user_id: t.userId,
  org_id: t.orgId,
  name: t.name,
  role: t.role,
  propose_only: t.proposeOnly,
  last_used_at: t.lastUsedAt,
  created_at: t.createdAt,
  revoked_at: t.revokedAt,
});

export function tokenRoutes() {
  const r = newRouter();

  r.openapi(
    createRoute({
      method: "get",
      path: "/tokens",
      tags: ["API tokens"],
      summary: "List your personal API tokens",
      security: bearerSecurity,
      responses: { 200: json(z.object({ data: z.array(TokenSchema) })), ...errorResponses },
    }),
    async (c) => {
      const p = requireSession(c);
      const rows = await c.get("ctx").users.listApiTokens({ userId: p.userId });
      return c.json({ data: rows.map(view) }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/tokens",
      tags: ["API tokens"],
      summary: "Create a personal API token scoped to one org. The token is shown once.",
      security: bearerSecurity,
      request: {
        body: jsonBody(
          z.object({
            org_id: Id,
            name: z.string().min(1).max(100),
            role: RoleSchema,
            propose_only: z.boolean().default(false),
          }),
        ),
      },
      responses: {
        201: json(
          z.object({ id: z.string(), token: z.string(), role: RoleSchema, propose_only: z.boolean() }),
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      const p = requireSession(c);
      const b = c.req.valid("json");
      const ctx = c.get("ctx");
      const userRole = await ctx.orgs.membership(p.userId, b.org_id);
      if (!userRole) throw notFound("Organization");
      const res = await ctx.users.createApiToken({
        userId: p.userId,
        orgId: b.org_id,
        name: b.name,
        role: b.role,
        userRole,
        proposeOnly: b.propose_only,
      });
      const h = await ctx.orgs.mustOpen(b.org_id);
      await h.write((tx) =>
        appendAudit(
          tx,
          b.org_id,
          { actor: "user", role: userRole, userId: p.userId, ip: c.get("ip") },
          {
            action: "api_token.create",
            targetType: "api_token",
            targetId: res.id,
            after: { name: b.name, role: res.role, propose_only: b.propose_only },
          },
        ),
      );
      return c.json({ id: res.id, token: res.token, role: res.role, propose_only: b.propose_only }, 201);
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/tokens/{tokenId}",
      tags: ["API tokens"],
      summary: "Revoke one of your API tokens",
      security: bearerSecurity,
      request: { params: z.object({ tokenId: Id }) },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const p = requireAuth(c);
      if (p.kind === "api_token" && p.apiTokenId !== c.req.valid("param").tokenId) {
        throw forbidden("A token can only revoke itself.");
      }
      const ctx = c.get("ctx");
      const t = await ctx.users.revokeApiToken(c.req.valid("param").tokenId, p.userId);
      if (!t) throw notFound("Token");
      const h = await ctx.orgs.open(t.orgId);
      await h?.write((tx) =>
        appendAudit(
          tx,
          t.orgId,
          { actor: "user", role: "viewer", userId: p.userId, ip: c.get("ip") },
          {
            action: "api_token.revoke",
            targetType: "api_token",
            targetId: t.id,
          },
        ),
      );
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/tokens",
      tags: ["API tokens"],
      summary: "List all API tokens for an org (owner)",
      security: bearerSecurity,
      request: { params: OrgParams },
      responses: { 200: json(z.object({ data: z.array(TokenSchema) })), ...errorResponses },
    }),
    async (c) => {
      const o = requireOwner(c);
      const rows = await c.get("ctx").users.listApiTokens({ orgId: o.id });
      return c.json({ data: rows.map(view) }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/orgs/{orgId}/tokens/{tokenId}",
      tags: ["API tokens"],
      summary: "Revoke any API token for this org (owner)",
      security: bearerSecurity,
      request: { params: OrgParams.extend({ tokenId: Id }) },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireOwner(c);
      const ctx = c.get("ctx");
      const { tokenId } = c.req.valid("param");
      const list = await ctx.users.listApiTokens({ orgId: o.id });
      if (!list.some((t) => t.id === tokenId)) throw notFound("Token");
      await ctx.users.revokeApiToken(tokenId);
      await o.handle.write((tx) =>
        appendAudit(tx, o.id, o.actor, {
          action: "api_token.revoke",
          targetType: "api_token",
          targetId: tokenId,
        }),
      );
      return c.json({ ok: true as const }, 200);
    },
  );

  return r;
}
