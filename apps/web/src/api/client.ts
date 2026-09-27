import createClient, { type Middleware } from "openapi-fetch";
import type { paths } from "./schema";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function readCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]!) : null;
}

const csrf: Middleware = {
  onRequest({ request }) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      const token = readCookie("cosimo_csrf");
      if (token) request.headers.set("x-csrf-token", token);
    }
    return request;
  },
};

export const api = createClient<paths>({ baseUrl: "", credentials: "same-origin" });
api.use(csrf);

/** Unwrap an openapi-fetch result: return data or throw ApiError. */
export async function unwrap<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await p;
  if (error || !response.ok) {
    const e = (error as { error?: { code?: string; message?: string; details?: Record<string, unknown> } })
      ?.error;
    throw new ApiError(response.status, e?.code ?? "error", e?.message ?? response.statusText, e?.details);
  }
  return data as T;
}

/** Raw fetch helper for endpoints returning files (CSV, PDF, ZIP) or multipart uploads. */
export async function rawFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== "GET") {
    const token = readCookie("cosimo_csrf");
    if (token) headers.set("x-csrf-token", token);
  }
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  if (!res.ok) {
    let body: { error?: { code?: string; message?: string } } = {};
    try {
      body = await res.json();
    } catch {}
    throw new ApiError(res.status, body.error?.code ?? "error", body.error?.message ?? res.statusText);
  }
  return res;
}

export async function download(path: string, filename: string) {
  const res = await rawFetch(path);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
