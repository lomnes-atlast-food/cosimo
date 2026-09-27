/**
 * `Idempotency-Key` for mutating API requests (SPEC §10.1). The first request with a key runs
 * and its response is stored; a retry with the same key, method, path and body gets the stored
 * response (header `idempotent-replayed: true`) without running again. Reusing a key for a
 * different request is refused (422), and a retry while the first is still running gets 409.
 * Keys are per caller (session user, API token, or OAuth grant) and expire after 24 hours.
 * Server errors (5xx) are not stored, so they can be retried.
 */
import { createHash } from "node:crypto";
import { system } from "@cosimo/db";
import { and, eq, lt } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { AppContext } from "../context.ts";
import { ApiError } from "./errors.ts";
import type { AppEnv, Principal } from "./types.ts";

export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;
const MAX_STORED_BYTES = 1_000_000;

function principalKey(p: Principal) {
  if (p.kind === "api_token") return `token:${p.apiTokenId}`;
  if (p.kind === "oauth") return `oauth:${p.oauthTokenId}`;
  return `user:${p.userId}`;
}

export const idempotency: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = c.req.header("idempotency-key");
  const p = c.get("principal");
  if (!key || !p || !["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) return next();
  if (key.length > 255)
    throw new ApiError(400, "invalid_idempotency_key", "Idempotency-Key is at most 255 characters.");

  const ctx = c.get("ctx");
  const principal = principalKey(p);
  const body = new Uint8Array(await c.req.raw.clone().arrayBuffer());
  const requestHash = createHash("sha256")
    .update(`${c.req.method} ${c.req.path}\n`)
    .update(body)
    .digest("hex");
  const where = and(eq(system.idempotencyKeys.principal, principal), eq(system.idempotencyKeys.key, key));

  const claimed = await ctx.system.write(async (tx) => {
    const row = await tx.select().from(system.idempotencyKeys).where(where).get();
    if (row && Date.parse(row.createdAt) > Date.now() - IDEMPOTENCY_TTL_MS) return row;
    if (row) await tx.delete(system.idempotencyKeys).where(where);
    await tx.insert(system.idempotencyKeys).values({
      principal,
      key,
      method: c.req.method,
      path: c.req.path,
      requestHash,
    });
    return null;
  });

  if (claimed) {
    if (claimed.requestHash !== requestHash)
      throw new ApiError(
        422,
        "idempotency_key_reused",
        "This Idempotency-Key was already used for a different request.",
      );
    if (claimed.status == null)
      throw new ApiError(
        409,
        "idempotency_in_progress",
        "A request with this Idempotency-Key is still running.",
      );
    c.header("idempotent-replayed", "true");
    return c.body(claimed.responseBody ?? "", claimed.status as 200, { "content-type": "application/json" });
  }

  let stored = false;
  try {
    await next();
    const res = c.res;
    const type = res.headers.get("content-type") ?? "";
    if (res.status < 500 && (type.includes("json") || res.status === 204)) {
      const text = await res.clone().text();
      if (text.length <= MAX_STORED_BYTES) {
        await ctx.system.write((tx) =>
          tx.update(system.idempotencyKeys).set({ status: res.status, responseBody: text }).where(where),
        );
        stored = true;
      }
    }
  } finally {
    // 4xx answers (including thrown ApiErrors, which Hono renders before `next` returns) are
    // stored above; anything else leaves the key free so the client can retry.
    if (!stored) await ctx.system.write((tx) => tx.delete(system.idempotencyKeys).where(where));
  }
};

/** Housekeeping: drop expired keys. */
export async function pruneIdempotencyKeys(ctx: AppContext) {
  const cutoff = new Date(Date.now() - IDEMPOTENCY_TTL_MS).toISOString();
  await ctx.system.write((tx) =>
    tx.delete(system.idempotencyKeys).where(lt(system.idempotencyKeys.createdAt, cutoff)),
  );
}
