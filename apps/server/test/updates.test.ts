/**
 * The admin update check (issue #12): dev/disabled short-circuits, the in-memory cache (12h ok /
 * 1h error, shared in-flight promise, `refresh` bypass), and the private-repo token hint.
 */
import { describe, expect, test } from "bun:test";
import type { AppContext } from "../src/context.ts";
import { type CheckDeps, checkForUpdate } from "../src/services/updates.ts";

/** Only `config` and `secrets.reveal` are touched by checkForUpdate; everything else is unused. */
function fakeCtx(over: { check?: boolean; token?: string; target?: "local" | "docker" | "fly" } = {}) {
  return {
    config: {
      updates: { check: over.check ?? true, github_token: over.token ?? "" },
      instance: { target: over.target ?? "local", created_at: "" },
    },
    secrets: { reveal: (v: string | null | undefined) => (v ? v : null) },
  } as unknown as AppContext;
}

/** A `CheckDeps` whose `fetch` records how many times, and with what headers, it was called. */
function fakeDeps(
  over: Partial<Pick<CheckDeps, "current" | "env" | "now">> & {
    respond?: () => Response | Promise<Response>;
  } = {},
) {
  const calls: Headers[] = [];
  const respond = over.respond ?? (() => Response.json({ tag_name: "v2.0.0" }));
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    calls.push(new Headers(init?.headers));
    return respond();
  }) as unknown as typeof fetch;
  const deps: CheckDeps = {
    fetch: fetchImpl,
    env: over.env ?? {},
    now: over.now ?? (() => Date.now()),
    current: over.current ?? "1.0.0",
  };
  return { deps, calls };
}

describe("checkForUpdate", () => {
  test("dev build never calls out", async () => {
    const { deps, calls } = fakeDeps({ current: "0.0.0-dev" });
    const r = await checkForUpdate(fakeCtx(), deps);
    expect(r).toMatchObject({ status: "dev", latest: null, checked_at: null });
    expect(calls).toHaveLength(0);
  });

  test("disabled never calls out", async () => {
    const { deps, calls } = fakeDeps();
    const r = await checkForUpdate(fakeCtx({ check: false }), deps);
    expect(r.status).toBe("disabled");
    expect(calls).toHaveLength(0);
  });

  test("a newer release is available, with upgrade instructions for the target", async () => {
    const { deps } = fakeDeps({
      respond: () =>
        Response.json({ tag_name: "v2.0.0", html_url: "https://x/2.0.0", published_at: "2026-01-01" }),
    });
    const r = await checkForUpdate(fakeCtx({ target: "fly" }), deps);
    expect(r.status).toBe("available");
    expect(r.latest).toEqual({ version: "2.0.0", url: "https://x/2.0.0", published_at: "2026-01-01" });
    expect(r.instructions.join("\n")).toContain("fly deploy --image");
  });

  test("up to date has no instructions", async () => {
    const { deps } = fakeDeps({ current: "1.0.0", respond: () => Response.json({ tag_name: "v1.0.0" }) });
    const r = await checkForUpdate(fakeCtx(), deps);
    expect(r.status).toBe("up_to_date");
    expect(r.instructions).toEqual([]);
  });

  test("caches a success for 12h, then refetches", async () => {
    let now = 0;
    const { deps, calls } = fakeDeps({ now: () => now });
    const ctx = fakeCtx();
    await checkForUpdate(ctx, deps);
    await checkForUpdate(ctx, deps);
    expect(calls).toHaveLength(1);
    now = 12 * 3_600_000 + 1;
    await checkForUpdate(ctx, deps);
    expect(calls).toHaveLength(2);
  });

  test("refresh bypasses the cache", async () => {
    const { deps, calls } = fakeDeps();
    const ctx = fakeCtx();
    await checkForUpdate(ctx, deps);
    await checkForUpdate(ctx, deps, { refresh: true });
    expect(calls).toHaveLength(2);
  });

  test("concurrent callers share one in-flight request", async () => {
    let resolve!: (r: Response) => void;
    const gate = new Promise<Response>((r) => (resolve = r));
    const { deps, calls } = fakeDeps({ respond: () => gate });
    const ctx = fakeCtx();
    const [a, b] = [checkForUpdate(ctx, deps), checkForUpdate(ctx, deps)];
    resolve(Response.json({ tag_name: "v2.0.0" }));
    expect(await a).toEqual(await b);
    expect(calls).toHaveLength(1);
  });

  test("a failure is cached for 1h, with the error message", async () => {
    let now = 0;
    const { deps, calls } = fakeDeps({
      now: () => now,
      respond: () => new Response("boom", { status: 500 }),
    });
    const ctx = fakeCtx();
    const r1 = await checkForUpdate(ctx, deps);
    expect(r1.status).toBe("unknown");
    expect(r1.error).toContain("500");
    await checkForUpdate(ctx, deps);
    expect(calls).toHaveLength(1);
    now = 3_600_000 + 1;
    await checkForUpdate(ctx, deps);
    expect(calls).toHaveLength(2);
  });

  test("a 404 without a token names the setting", async () => {
    const { deps } = fakeDeps({ respond: () => new Response("not found", { status: 404 }) });
    const r = await checkForUpdate(fakeCtx(), deps);
    expect(r.status).toBe("unknown");
    expect(r.error).toContain("updates.github_token");
  });

  test("the configured token is sent as a bearer header", async () => {
    const { deps, calls } = fakeDeps();
    await checkForUpdate(fakeCtx({ token: "shh" }), deps);
    expect(calls[0]?.get("authorization")).toBe("Bearer shh");
  });
});
