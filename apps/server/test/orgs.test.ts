import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { addMember, createOrg, createTestEnv, login, type TestEnv } from "./harness.ts";

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(() => env.close());

describe("demo organizations", () => {
  test("POST /sample-org creates a demo org, then reports it already exists", async () => {
    const owner = await login(env, "sample-owner@example.com");

    const first = await owner.json("POST", "/api/v1/sample-org");
    expect(first.status).toBe(201);
    const orgId = first.body.id as string;

    const orgs = await owner.json("GET", "/api/v1/orgs");
    const row = orgs.body.data.find((o: { id: string }) => o.id === orgId);
    expect(row.is_sample).toBe(true);

    const second = await owner.json("POST", "/api/v1/sample-org");
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("sample_exists");
    expect(second.body.error.details.id).toBe(orgId);
  });

  test("DELETE ?permanent=true refuses a real org", async () => {
    const owner = await login(env, "real-owner@example.com");
    const orgId = await createOrg(env, owner, "Real Co");

    const res = await owner.json("DELETE", `/api/v1/orgs/${orgId}?permanent=true`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("not_sample");

    const orgs = await owner.json("GET", "/api/v1/orgs");
    expect(orgs.body.data.map((o: { id: string }) => o.id)).toContain(orgId);
  });

  test("DELETE ?permanent=true permanently removes a demo org", async () => {
    const owner = await login(env, "demo-owner@example.com");
    const created = await owner.json("POST", "/api/v1/sample-org");
    const orgId = created.body.id as string;

    const res = await owner.json("DELETE", `/api/v1/orgs/${orgId}?permanent=true`);
    expect(res.status).toBe(200);

    const orgs = await owner.json("GET", "/api/v1/orgs");
    expect(orgs.body.data.map((o: { id: string }) => o.id)).not.toContain(orgId);
    expect(await env.ctx.orgs.get(orgId)).toBeUndefined();
  });

  test("DELETE ?permanent=false archives a demo org instead of deleting it", async () => {
    const owner = await login(env, "demo-false@example.com");
    const created = await owner.json("POST", "/api/v1/sample-org");
    const orgId = created.body.id as string;

    const res = await owner.json("DELETE", `/api/v1/orgs/${orgId}?permanent=false`);
    expect(res.status).toBe(200);
    const row = await env.ctx.orgs.get(orgId);
    expect(row?.archivedAt).toBeTruthy();
  });

  test("a non-owner cannot delete or archive an org", async () => {
    const owner = await login(env, "member-owner@example.com");
    const orgId = await createOrg(env, owner, "Member Co");
    const member = await login(env, "member@example.com");
    await addMember(env, orgId, member.userId, "bookkeeper");

    const del = await member.json("DELETE", `/api/v1/orgs/${orgId}`);
    expect(del.status).toBe(403);
  });

  test("archiving a real org hides it from the list", async () => {
    const owner = await login(env, "archive-owner@example.com");
    const orgId = await createOrg(env, owner, "Archive Co");

    const res = await owner.json("DELETE", `/api/v1/orgs/${orgId}`);
    expect(res.status).toBe(200);

    const orgs = await owner.json("GET", "/api/v1/orgs");
    expect(orgs.body.data.map((o: { id: string }) => o.id)).not.toContain(orgId);
  });

  test("GET /orgs orders sample organizations last", async () => {
    const owner = await login(env, "order-owner@example.com");
    await createOrg(env, owner, "Zebra Co");
    await createOrg(env, owner, "Acme Co");
    await owner.json("POST", "/api/v1/sample-org");

    const orgs = await owner.json("GET", "/api/v1/orgs");
    const names = orgs.body.data.map((o: { name: string; is_sample: boolean }) => ({
      name: o.name,
      is_sample: o.is_sample,
    }));
    const sampleIdx = names.findIndex((n: { is_sample: boolean }) => n.is_sample);
    expect(sampleIdx).toBe(names.length - 1);
    const realNames = names
      .filter((n: { is_sample: boolean }) => !n.is_sample)
      .map((n: { name: string }) => n.name);
    expect(realNames).toEqual(["Acme Co", "Zebra Co"]);
  });
});
