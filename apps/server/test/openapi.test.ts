/** OpenAPI completeness (SPEC §10.1): every /api/v1 route is documented, and the docs page loads. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestEnv, type TestEnv } from "./harness.ts";

let env: TestEnv;
let doc: { paths: Record<string, Record<string, any>> };

beforeAll(async () => {
  env = await createTestEnv();
  doc = (await (await env.app.request("/api/v1/openapi.json")).json()) as typeof doc;
});
afterAll(() => env.close());

test("every /api/v1 route is in the OpenAPI document with a summary, tag, and responses", () => {
  const missing: string[] = [];
  for (const r of (env.app as unknown as { routes: { method: string; path: string }[] }).routes) {
    if (r.method === "ALL" || !r.path.startsWith("/api/v1/") || r.path === "/api/v1/openapi.json") continue;
    const path = r.path.replace(/:(\w+)/g, "{$1}");
    const op = doc.paths[path]?.[r.method.toLowerCase()];
    if (!op) missing.push(`${r.method} ${path}`);
    else {
      expect(op.summary, `${r.method} ${path} summary`).toBeTruthy();
      expect(op.tags?.length, `${r.method} ${path} tags`).toBeGreaterThan(0);
      expect(Object.keys(op.responses ?? {}).length).toBeGreaterThan(0);
    }
  }
  expect([...new Set(missing)]).toEqual([]);
  expect(Object.keys(doc.paths).length).toBeGreaterThan(100);
});

test("mutating operations document Idempotency-Key", () => {
  const op = doc.paths["/api/v1/orgs/{orgId}/entries"]!.post;
  expect(op.parameters.some((p: { name: string }) => p.name === "Idempotency-Key")).toBe(true);
  expect(
    doc.paths["/api/v1/orgs/{orgId}/entries"]!.get.parameters.some(
      (p: { name: string }) => p.name === "Idempotency-Key",
    ),
  ).toBe(false);
});

test("/api/docs serves the Scalar reference pinned with SRI", async () => {
  const r = await env.app.request("/api/docs");
  expect(r.status).toBe(200);
  const html = await r.text();
  expect(html).toContain('data-url="/api/v1/openapi.json"');
  expect(html).toMatch(/integrity="sha384-[A-Za-z0-9+/=]+"/);
  expect(r.headers.get("content-security-policy")).toContain("https://cdn.jsdelivr.net");
});
