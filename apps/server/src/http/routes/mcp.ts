/**
 * MCP endpoint (SPEC §10.2): streamable HTTP at `/mcp`, stateless, answering each JSON-RPC POST
 * with `application/json` (no server-initiated SSE stream; GET returns 405).
 *
 * Authentication is a bearer token only (OAuth access token or API token); cookies are ignored so
 * a browser session can't be used cross-site. Unauthenticated requests get 401 with
 * `WWW-Authenticate` pointing at the protected resource metadata, which starts the OAuth flow.
 * Every call acts as the `mcp` actor in the token's single organization.
 */
import { system } from "@cosimo/db";
import { minRole, VERSION } from "@cosimo/shared";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { inArray } from "drizzle-orm";
import type { Context } from "hono";
import type { AppContext } from "../../context.ts";
import { TOKEN_PREFIX } from "../../crypto.ts";
import { callTool, listTools, type ToolCtx, ToolInputError } from "../../services/mcp-tools.ts";
import {
  accountNamesByCode,
  getProfile,
  listNotes,
  notesMarkdown,
  profileMarkdown,
} from "../../services/notes.ts";
import type { OAuthService } from "../../services/oauth.ts";
import { ApiError } from "../errors.ts";
import { clientIp } from "../middleware.ts";
import type { AppEnv, OrgScope, Principal } from "../types.ts";

export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `Cosimo is double-entry bookkeeping for one organization.
- Start by reading the resources org://profile (what the business does, which accounts to use) and org://notes (what has been learned before).
- Money is integer cents; journal lines are debit-positive; bank amounts are positive for money in.
- Every write tool needs a short rationale. Writes are proposals: they wait in the review queue until a person approves them. Tell the person what is waiting (list_pending_reviews).
- You cannot approve, reject, void, delete, or change lock dates. Reversals, replacements, and payment date changes are proposals.
- When you learn something durable about how this business books things, record it with append_note.`;

export interface McpResource {
  uri: string;
  name: string;
  title?: string;
  description: string;
  mimeType: string;
  read(t: ToolCtx): Promise<string>;
}
const resources: McpResource[] = [];
export function registerMcpResource(r: McpResource) {
  resources.push(r);
}

type JsonRpc = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

const rpcError = (id: JsonRpc["id"], code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

function challenge(c: Context<AppEnv>, ctx: AppContext, error?: string, description?: string) {
  const base = ctx.config.server.public_url.replace(/\/$/, "");
  const parts = [`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description.replace(/"/g, "'")}"`);
  c.header("www-authenticate", `Bearer ${parts.join(", ")}`);
  return c.json(
    { error: { code: error ?? "unauthorized", message: description ?? "Authentication required." } },
    401,
  );
}

async function principalFor(ctx: AppContext, token: string): Promise<Principal | null> {
  if (token.startsWith(TOKEN_PREFIX.api)) {
    const row = await ctx.users.resolveApiToken(token);
    if (!row) return null;
    return {
      kind: "api_token",
      userId: row.user.id,
      email: row.user.email,
      name: row.user.name,
      isInstanceAdmin: false,
      apiTokenId: row.token.id,
      orgId: row.token.orgId,
      roleCap: row.token.role,
      proposeOnly: row.token.proposeOnly,
    };
  }
  if (token.startsWith(TOKEN_PREFIX.oauthAccess))
    return (ctx.services.oauth as OAuthService).resolveAccessToken(token);
  return null;
}

async function scopeFor(ctx: AppContext, p: Principal, ip: string): Promise<OrgScope | null> {
  if (!p.orgId) return null;
  const member = await ctx.orgs.membership(p.userId, p.orgId);
  const handle = member ? await ctx.orgs.open(p.orgId) : null;
  if (!member || !handle) return null;
  const role = p.roleCap ? minRole(p.roleCap, member) : member;
  return {
    id: p.orgId,
    handle,
    role,
    actor: {
      actor: "mcp",
      role,
      userId: p.userId,
      apiTokenId: p.apiTokenId ?? null,
      oauthClientId: p.oauthClientId ?? null,
      ip,
      proposeOnly: p.kind === "oauth" ? true : (p.proposeOnly ?? false),
      displayName: p.name || p.email,
    },
  };
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(value && typeof value === "object" && !Array.isArray(value) ? { structuredContent: value } : {}),
    isError: false,
  };
}

function toolError(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function handle(t: ToolCtx, msg: JsonRpc) {
  const id = msg.id;
  const params = msg.params ?? {};
  switch (msg.method) {
    case "initialize": {
      const asked = String(params.protocolVersion ?? "");
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false, subscribe: false },
          },
          serverInfo: { name: "cosimo", title: "Cosimo bookkeeping", version: VERSION },
          instructions: INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: listTools() } };
    case "tools/call": {
      const name = String(params.name ?? "");
      try {
        const out = await callTool(t, name, params.arguments);
        if (out === null) return rpcError(id, -32602, `Unknown tool: ${name}`);
        return { jsonrpc: "2.0", id, result: toolResult(out) };
      } catch (e) {
        if (e instanceof ToolInputError)
          return { jsonrpc: "2.0", id, result: toolError(`Invalid input: ${e.message}`) };
        if (e instanceof ApiError)
          return { jsonrpc: "2.0", id, result: toolError(`${e.message} (${e.code})`) };
        throw e;
      }
    }
    case "resources/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resources: resources.map(({ read: _r, ...r }) => r),
        },
      };
    case "resources/templates/list":
      return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };
    case "resources/read": {
      const r = resources.find((x) => x.uri === params.uri);
      if (!r) return rpcError(id, -32002, `Resource not found: ${String(params.uri)}`);
      return {
        jsonrpc: "2.0",
        id,
        result: { contents: [{ uri: r.uri, mimeType: r.mimeType, text: await r.read(t) }] },
      };
    }
    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    case "logging/setLevel":
      return { jsonrpc: "2.0", id, result: {} };
    default:
      return rpcError(id, -32601, `Method not found: ${String(msg.method)}`);
  }
}

async function userNames(ctx: AppContext, ids: string[]) {
  const rows = await ctx.system.db
    .select({ id: system.users.id, email: system.users.email, name: system.users.name })
    .from(system.users)
    .where(inArray(system.users.id, ids))
    .all();
  return new Map(rows.map((u) => [u.id, u.name || u.email]));
}

registerMcpResource({
  uri: "org://profile",
  name: "profile",
  title: "Business profile",
  description:
    "What the business does, how it bills, typical customers and vendors, and which accounts to use for recurring items. Read this first.",
  mimeType: "text/markdown",
  async read(t) {
    const db = t.scope.handle.db;
    const p = await getProfile(db);
    const reg = await t.ctx.orgs.get(t.scope.id);
    return `# ${reg?.name ?? "Business"}\n\n${profileMarkdown(p.profile, await accountNamesByCode(db))}`;
  },
});

registerMcpResource({
  uri: "org://notes",
  name: "notes",
  title: "Bookkeeping notes",
  description:
    "Dated, attributed notes on how this business books things, newest first. Add to them with append_note.",
  mimeType: "text/markdown",
  async read(t) {
    return notesMarkdown(await listNotes(t.scope.handle.db, (ids) => userNames(t.ctx, ids)));
  },
});

export function mountMcp(app: OpenAPIHono<AppEnv>, ctx: AppContext) {
  const publicOrigin = new URL(ctx.config.server.public_url).origin;

  app.on(["GET", "DELETE"], "/mcp", (c) => {
    c.header("allow", "POST");
    return c.json(
      { error: { code: "method_not_allowed", message: "This server is stateless: POST JSON-RPC messages." } },
      405,
    );
  });

  app.post("/mcp", async (c) => {
    // DNS-rebinding protection (MCP transport spec): browsers must come from our own origin.
    const origin = c.req.header("origin");
    if (origin && origin !== publicOrigin)
      return c.json({ error: { code: "forbidden_origin", message: "Origin not allowed." } }, 403);
    const version = c.req.header("mcp-protocol-version");
    if (version && !MCP_PROTOCOL_VERSIONS.includes(version))
      return c.json(
        {
          error: {
            code: "unsupported_protocol_version",
            message: `Supported: ${MCP_PROTOCOL_VERSIONS.join(", ")}`,
          },
        },
        400,
      );

    const auth = c.req.header("authorization");
    if (!auth?.toLowerCase().startsWith("bearer ")) return challenge(c, ctx);
    const ip = clientIp(c);
    const p = await principalFor(ctx, auth.slice(7).trim());
    if (!p) return challenge(c, ctx, "invalid_token", "The access token is invalid, expired, or revoked.");
    const scope = await scopeFor(ctx, p, ip);
    if (!scope)
      return challenge(
        c,
        ctx,
        "invalid_token",
        "The token's organization is no longer available to this user.",
      );

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(rpcError(null, -32700, "Parse error"), 400);
    }
    const t: ToolCtx = { ctx, scope };
    const batch = Array.isArray(body);
    const msgs = (batch ? body : [body]) as JsonRpc[];
    const out = [];
    for (const m of msgs) {
      if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") {
        out.push(rpcError(null, -32600, "Invalid request"));
        continue;
      }
      if (m.id === undefined || m.id === null) continue; // notification or response: nothing to answer
      try {
        out.push(await handle(t, m));
      } catch (e) {
        ctx.logger.error("mcp error", { err: e, method: m.method, request_id: c.get("requestId") });
        out.push(rpcError(m.id, -32603, "Internal error"));
      }
    }
    if (!out.length) return c.body(null, 202);
    return c.json(batch ? out : out[0]!, 200);
  });
}
