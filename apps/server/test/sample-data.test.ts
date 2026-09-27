import { afterAll, beforeAll, expect, test } from "bun:test";
import { loadSampleData, SAMPLE_ORG_NAME } from "../src/services/sample-data.ts";
import { type Client, createTestEnv, login, type TestEnv } from "./harness.ts";

let env: TestEnv;
let owner: Client;

beforeAll(async () => {
  env = await createTestEnv();
  owner = await login(env, "demo@example.com");
});
afterAll(() => env.close());

test("sample data builds a demo org with posted books and work to review", async () => {
  const orgId = await loadSampleData(env.ctx, owner.userId);
  expect(orgId).toBeString();
  const base = `/api/v1/orgs/${orgId}`;

  const orgs = await owner.json("GET", "/api/v1/orgs");
  expect(orgs.body.data.map((o: { name: string }) => o.name)).toContain(SAMPLE_ORG_NAME);

  const tb = await owner.json("GET", `${base}/reports/trial_balance`);
  expect(tb.status).toBe(200);
  expect(tb.body.lines.length).toBeGreaterThan(3);

  const uncategorized = await owner.json("GET", `${base}/bank-transactions?status=uncategorized`);
  expect(uncategorized.body.data.length).toBeGreaterThan(0);

  const invoices = await owner.json("GET", `${base}/invoices`);
  expect(invoices.body.data).toHaveLength(1);
  expect(invoices.body.data[0].status).not.toBe("draft");

  const verify = await owner.json("POST", `${base}/verify`);
  expect(verify.body.ledger.ok).toBe(true);
  expect(verify.body.ledger.checked).toBeGreaterThan(5);

  // Running it again does not add a second demo org.
  expect(await loadSampleData(env.ctx, owner.userId)).toBeUndefined();
});
