import type { ContentfulStatusCode } from "hono/utils/http-status";

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>, code = "bad_request") =>
  new ApiError(400, code, message, details);
export const unauthorized = (message = "Authentication required.", code = "unauthorized") =>
  new ApiError(401, code, message);
export const forbidden = (message = "You do not have permission to do that.", code = "forbidden") =>
  new ApiError(403, code, message);
export const notFound = (what = "Resource") => new ApiError(404, "not_found", `${what} not found.`);
export const conflict = (message: string, code = "conflict", details?: Record<string, unknown>) =>
  new ApiError(409, code, message, details);
export const unprocessable = (message: string, code = "unprocessable", details?: Record<string, unknown>) =>
  new ApiError(422, code, message, details);
export const tooMany = (retryAfter: number) =>
  new ApiError(429, "rate_limited", "Too many requests. Try again later.", { retry_after: retryAfter });

/** Map database invariant violations (trigger RAISE messages) to API errors. */
export function fromDbError(e: unknown): ApiError | null {
  // Drizzle wraps driver errors ("Failed query: ...") and keeps the original as `cause`.
  const parts: string[] = [];
  for (let cur: unknown = e, i = 0; cur && i < 5; cur = (cur as { cause?: unknown }).cause, i++) {
    parts.push(String((cur as Error)?.message ?? cur));
  }
  const msg = parts.join("\n");
  const m = /invariant: ([^\n]+?)(?:$|\n|")/.exec(msg);
  if (m) return new ApiError(422, "invariant_violation", m[1]!.trim());
  if (/UNIQUE constraint failed/i.test(msg))
    return new ApiError(409, "conflict", "A record with those values already exists.");
  return null;
}
