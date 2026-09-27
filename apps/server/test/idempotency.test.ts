/** Idempotency-Key on mutating API requests (SPEC §10.1). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { type Client, createOrg, createTestEnv, login, type TestEnv } from "./harness.ts";

let env: TestEnv;
let owner: Client;
let orgId: string;
let acct: Record<string, string>;

beforeAll(async () => {
  env = await createTestEnv();
  owner = await login(env, "owner@example.com");
  orgId = await createOrg(env, owner);
  const accounts = (await owner.json("GET", `/api/v1/orgs/${orgId}/accounts`)).body.data as {
    code: string;
    id: string;
  }[];
  acct = Object.fromEntries(accounts.map((a) => [a.code, a.id]));
});
afterAll(() => env.close());

const entry = (amount: number) => ({
  date: "2026-02-01",
  memo: "idem",
  lines: [
    { account_id: acct["1000"], amount },
    { account_id: acct["3100"], amount: -amount },
  ],
});

async function count() {
  return (await owner.json("GET", `/api/v1/orgs/${orgId}/entries?limit=500`)).body.data.length as number;
}

test("a retried request with the same key runs once and replays the response", async () => {
  const url = `/api/v1/orgs/${orgId}/entries`;
  const a = await owner.req("POST", url, entry(700), { "idempotency-key": "k-1" });
  expect(a.status).toBe(201);
  const first = await a.json();
  const b = await owner.req("POST", url, entry(700), { "idempotency-key": "k-1" });
  expect(b.status).toBe(201);
  expect(b.headers.get("idempotent-replayed")).toBe("true");
  expect(await b.json()).toEqual(first);
  expect(await count()).toBe(1);

  // Same key, different body: refused.
  const c = await owner.req("POST", url, entry(800), { "idempotency-key": "k-1" });
  expect(c.status).toBe(422);
  expect((await c.json()).error.code).toBe("idempotency_key_reused");

  // Without a key, or with a new key, requests run normally.
  expect((await owner.req("POST", url, entry(700))).status).toBe(201);
  expect((await owner.req("POST", url, entry(700), { "idempotency-key": "k-2" })).status).toBe(201);
  expect(await count()).toBe(3);
});

test("client errors are replayed too; keys are per caller", async () => {
  const url = `/api/v1/orgs/${orgId}/entries`;
  const bad = { ...entry(100), lines: [{ account_id: acct["1000"], amount: 100 }] };
  const a = await owner.req("POST", url, bad, { "idempotency-key": "bad-1" });
  expect(a.status).toBe(422);
  const b = await owner.req("POST", url, bad, { "idempotency-key": "bad-1" });
  expect(b.status).toBe(422);
  expect(b.headers.get("idempotent-replayed")).toBe("true");

  const other = await login(env, "other@example.com");
  const otherOrg = await createOrg(env, other, "Other");
  const r = await other.req(
    "POST",
    `/api/v1/orgs/${otherOrg}/contacts`,
    { kind: "customer", name: "X" },
    { "idempotency-key": "k-1" },
  );
  expect(r.status).toBe(201);
  expect(r.headers.get("idempotent-replayed")).toBeNull();
});
