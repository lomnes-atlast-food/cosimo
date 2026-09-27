import { orgMigrations, pendingMigrations, systemMigrations } from "@cosimo/db";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppContext } from "../context.ts";
import { serveWeb } from "../web/static.ts";
import { ApiError, fromDbError } from "./errors.ts";
import { idempotency } from "./idempotency.ts";
import { csrf, orgScope, resolvePrincipal, securityHeaders } from "./middleware.ts";
import { newRouter } from "./openapi.ts";
import { adminRoutes } from "./routes/admin.ts";
import { authRoutes } from "./routes/auth.ts";
import { orgRoutes } from "./routes/orgs.ts";
import { tokenRoutes } from "./routes/tokens.ts";
import type { AppEnv } from "./types.ts";

/** Scalar API reference, pinned; the hash matches the npm package's file. */
const SCALAR_URL = "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.1/dist/browser/standalone.js";
const SCALAR_SRI = "sha384-U11tb2XnKvmwt8RlTvnwUnYgrN+ur4Xyh9htLhjajWNR/Oyl5AX5DEz00qRmlrmK";

/** Document the Idempotency-Key header on every mutating operation. */
function withIdempotencyHeader<T>(doc: T): T {
  const paths = (doc as { paths?: Record<string, Record<string, { parameters?: unknown[] }>> }).paths ?? {};
  for (const ops of Object.values(paths))
    for (const [method, op] of Object.entries(ops)) {
      if (!["post", "put", "patch", "delete"].includes(method)) continue;
      op.parameters = [
        ...(op.parameters ?? []),
        {
          name: "Idempotency-Key",
          in: "header",
          required: false,
          description: "Makes a retry safe: the same key and body replay the first response.",
          schema: { type: "string", maxLength: 255 },
        },
      ];
    }
  return doc;
}

export type RouteModule = () => OpenAPIHono<AppEnv>;
const apiModules: RouteModule[] = [authRoutes, orgRoutes, tokenRoutes, adminRoutes];
const rootMounts: ((app: OpenAPIHono<AppEnv>, ctx: AppContext) => void)[] = [];

/** Later modules (ledger, banking, ...) register their /api/v1 routers here. */
export function registerApiModule(m: RouteModule) {
  apiModules.push(m);
}
/** Register non-API routes (MCP endpoint, OAuth, webhooks). */
export function registerRootMount(m: (app: OpenAPIHono<AppEnv>, ctx: AppContext) => void) {
  rootMounts.push(m);
}

export function createApp(ctx: AppContext): Hono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("ctx", ctx);
    c.set("requestId", c.req.header("x-request-id") ?? crypto.randomUUID());
    const started = performance.now();
    await next();
    c.header("x-request-id", c.get("requestId"));
    if (c.req.path !== "/healthz") {
      ctx.logger.info("request", {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - started),
        request_id: c.get("requestId"),
      });
    }
  });
  app.use("*", securityHeaders());

  app.get("/healthz", (c) => c.json({ status: "ok", version: ctx.version }));
  app.get("/readyz", async (c) => {
    try {
      await ctx.system.client.execute("SELECT 1");
      const pendingSystem = await pendingMigrations(ctx.system.client, systemMigrations);
      let pendingOrgs = 0;
      for (const o of await ctx.orgs.list()) {
        const h = await ctx.orgs.mustOpen(o.id);
        pendingOrgs += (await pendingMigrations(h.client, orgMigrations)).length;
      }
      const ok = pendingSystem.length === 0 && pendingOrgs === 0;
      return c.json(
        {
          status: ok ? "ready" : "migrations_pending",
          pending_system: pendingSystem.length,
          pending_orgs: pendingOrgs,
        },
        ok ? 200 : 503,
      );
    } catch (e) {
      return c.json({ status: "unavailable", error: (e as Error).message }, 503);
    }
  });

  const api = newRouter();
  api.use("*", resolvePrincipal);
  api.use("*", csrf);
  api.use("*", idempotency);
  api.use("/orgs/:orgId/*", orgScope);
  api.use("/orgs/:orgId", async (c, next) => (c.req.method === "POST" ? next() : orgScope(c, next)));
  for (const m of apiModules) api.route("/", m());
  app.route("/api/v1", api);

  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    description: "Personal API token (cosimo_pat_...) or OAuth access token",
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "cookieAuth", {
    type: "apiKey",
    in: "cookie",
    name: "cosimo_session",
    description: "Browser session; state-changing requests also need the x-csrf-token header",
  });
  const docConfig = {
    openapi: "3.1.0",
    info: {
      title: "Cosimo API",
      version: ctx.version,
      description:
        "Self-hosted double-entry bookkeeping. Money is integer cents with an ISO currency code; dates are YYYY-MM-DD. Mutating requests accept an `Idempotency-Key` header: a retry with the same key and body returns the first response without running again (24 hours).",
    },
    servers: [{ url: ctx.config.server.public_url }],
  };
  let openapiDoc: unknown = null;
  app.get("/api/v1/openapi.json", (c) => {
    openapiDoc ??= withIdempotencyHeader(app.getOpenAPI31Document(docConfig as never));
    return c.json(openapiDoc as object);
  });
  app.get("/api/docs", (c) =>
    c.html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cosimo API reference</title>
</head>
<body>
<script id="api-reference" data-url="/api/v1/openapi.json"></script>
<script src="${SCALAR_URL}" integrity="${SCALAR_SRI}" crossorigin="anonymous"></script>
</body>
</html>`),
  );

  for (const m of rootMounts) m(app, ctx);

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
    }
    if (err instanceof HTTPException) {
      return c.json({ error: { code: "http_error", message: err.message } }, err.status);
    }
    const dbErr = fromDbError(err);
    if (dbErr) return c.json({ error: { code: dbErr.code, message: dbErr.message } }, dbErr.status);
    ctx.logger.error("unhandled error", { err, path: c.req.path, request_id: c.get("requestId") });
    return c.json(
      {
        error: {
          code: "internal_error",
          message: "Something went wrong.",
          details: { request_id: c.get("requestId") },
        },
      },
      500,
    );
  });

  app.notFound((c) => {
    const p = c.req.path;
    if (
      p.startsWith("/api/") ||
      p.startsWith("/mcp") ||
      p.startsWith("/oauth") ||
      p.startsWith("/.well-known")
    ) {
      return c.json({ error: { code: "not_found", message: "Not found." } }, 404);
    }
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      return c.json({ error: { code: "not_found", message: "Not found." } }, 404);
    }
    return serveWeb(c);
  });

  return app;
}
