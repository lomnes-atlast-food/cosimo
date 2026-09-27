/**
 * QuickBooks Online / Xero / Wave import (SPEC §14.2) through the API, plus the operations admin
 * endpoints (status, backups) and open-format export/import over HTTP.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyOrg } from "../src/services/chain.ts";
import { type Client, createOrg, createTestEnv, login, type TestEnv } from "./harness.ts";

const FIX = join(import.meta.dir, "../../../packages/core/src/importers/fixtures");
const files = (prefix: string) =>
  readdirSync(FIX)
    .filter((f) => f.startsWith(prefix))
    .map((name) => ({ name, content: readFileSync(join(FIX, name), "utf8") }));

let env: TestEnv;
let admin: Client;
let owner: Client;
const tmp = mkdtempSync(join(tmpdir(), "cosimo-pimport-"));

beforeAll(async () => {
  env = await createTestEnv({
    configure: (c) => {
      c.backups.dir = join(tmp, "backups");
    },
  });
  admin = await login(env, "admin@example.com", { admin: true });
  owner = await login(env, "owner@example.com");
});
afterAll(async () => {
  await env.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function entries(orgId: string, status = "posted") {
  const r = await owner.json(
    "GET",
    `/api/v1/orgs/${orgId}/entries?source_type=import&limit=500&status=${status}`,
  );
  expect(r.status).toBe(200);
  return r.body.data as { status: string; lines: { amount: number }[] }[];
}

describe.each(["qbo", "xero", "wave"])("%s import", (product) => {
  let orgId: string;
  const url = () => `/api/v1/orgs/${orgId}/imports/product`;

  beforeAll(async () => {
    orgId = await createOrg(env, owner, `Import ${product}`);
  });

  test("dry run writes nothing; commit holds one review batch; approval posts; re-import adds nothing", async () => {
    const dry = await owner.json("POST", url(), { files: files(product) });
    expect(dry.status).toBe(200);
    expect(dry.body.source).toBe(product);
    expect(dry.body.committed).toBe(false);
    expect(dry.body.can_commit).toBe(true);
    expect(dry.body.entries.new).toBeGreaterThan(0);
    expect(dry.body.accounts.match).toBeGreaterThan(0); // A/R, A/P, etc. map onto system accounts
    expect(await entries(orgId)).toHaveLength(0);

    const done = await owner.json("POST", url(), { files: files(product), dry_run: false });
    expect(done.status).toBe(200);
    expect(done.body.committed).toBe(true);
    expect(done.body.created.entries).toBe(dry.body.entries.new);
    expect(done.body.created.accounts).toBe(dry.body.accounts.create);
    expect(await entries(orgId)).toHaveLength(0);
    expect(await entries(orgId, "pending_review")).toHaveLength(dry.body.entries.new);
    const queue = await owner.json("GET", `/api/v1/orgs/${orgId}/review?status=pending`);
    expect(queue.body.data).toHaveLength(1);
    expect(queue.body.data[0]).toMatchObject({ id: done.body.review_item_id, item_type: "import_batch" });
    expect(queue.body.data[0].payload.import.entries).toBe(dry.body.entries.new);

    const ok = await owner.json(
      "POST",
      `/api/v1/orgs/${orgId}/review/${done.body.review_item_id}/approve`,
      {},
    );
    expect(ok.status).toBe(200);
    const posted = await entries(orgId);
    expect(posted).toHaveLength(dry.body.entries.new);
    for (const e of posted) expect(e.lines.reduce((s, l) => s + l.amount, 0)).toBe(0);

    const tb = await owner.json("GET", `/api/v1/orgs/${orgId}/reports/trial_balance?as_of=2030-12-31`);
    expect(tb.status).toBe(200);

    const again = await owner.json("POST", url(), { files: files(product), dry_run: false });
    expect(again.body.entries).toMatchObject({ new: 0, already_imported: dry.body.entries.new });
    expect(again.body.accounts.create).toBe(0);
    expect(again.body.contacts.create).toBe(0);
    expect(again.body.committed).toBe(false);
    expect(await entries(orgId)).toHaveLength(dry.body.entries.new);

    const h = await env.ctx.orgs.mustOpen(orgId);
    expect((await verifyOrg(h.db, orgId)).ok).toBe(true);
  });
});

test("entries in a locked period block the commit", async () => {
  const orgId = await createOrg(env, owner, "Locked");
  const lock = await owner.json("PUT", `/api/v1/orgs/${orgId}/lock-dates`, { hard_lock_date: "2030-01-01" });
  expect(lock.status).toBe(200);
  const url = `/api/v1/orgs/${orgId}/imports/product`;
  const dry = await owner.json("POST", url, { files: files("qbo") });
  expect(dry.body.can_commit).toBe(false);
  expect(dry.body.errors.some((e: { message: string }) => e.message.includes("locked period"))).toBe(true);
  const r = await owner.json("POST", url, { files: files("qbo"), dry_run: false });
  expect(r.status).toBe(422);
  expect(r.body.error.code).toBe("locked_period");
  expect(await entries(orgId)).toHaveLength(0);
});

test("rejecting a batch rejects every entry, and the files can be imported again", async () => {
  const orgId = await createOrg(env, owner, "Rejected");
  const url = `/api/v1/orgs/${orgId}/imports/product`;
  const first = await owner.json("POST", url, { files: files("wave"), dry_run: false });
  const n = first.body.created.entries;
  const no = await owner.json("POST", `/api/v1/orgs/${orgId}/review/${first.body.review_item_id}/reject`, {
    note: "wrong file",
  });
  expect(no.status).toBe(200);
  expect(await entries(orgId, "rejected")).toHaveLength(n);
  expect(await entries(orgId, "pending_review")).toHaveLength(0);
  const second = await owner.json("POST", url, { files: files("wave") });
  expect(second.body.entries.new).toBe(n);
  expect(second.body.accounts.create).toBe(0);
});

test("unrecognized files are reported, not thrown", async () => {
  const orgId = await createOrg(env, owner, "Junk");
  const r = await owner.json("POST", `/api/v1/orgs/${orgId}/imports/product`, {
    files: [{ name: "x.csv", content: "a,b\n1,2\n" }],
  });
  expect(r.status).toBe(200);
  expect(r.body.can_commit).toBe(false);
  expect(r.body.errors[0].message).toContain("Not a recognized");
});

describe("admin operations", () => {
  test("status, backup now, and backup list are admin-only", async () => {
    expect((await owner.json("GET", "/api/v1/admin/status")).status).toBe(403);
    expect((await owner.json("POST", "/api/v1/admin/backups")).status).toBe(403);
    const b = await admin.json("POST", "/api/v1/admin/backups");
    expect(b.status).toBe(201);
    expect(b.body.name).toMatch(/^cosimo-backup-/);
    const list = await admin.json("GET", "/api/v1/admin/backups");
    expect(list.body.data[0].name).toBe(b.body.name);
    const s = await admin.json("GET", "/api/v1/admin/status");
    expect(s.status).toBe(200);
    expect(s.body.backups.last.file).toContain(b.body.name);
    expect(s.body.orgs).toBeGreaterThan(0);
    expect(JSON.stringify(s.body)).not.toContain(env.config.security.master_key);
  }, 30_000);

  test("export over HTTP (owner) and import as a new owner", async () => {
    const orgId = await createOrg(env, owner, "Round Trip");
    const res = await owner.req("GET", `/api/v1/orgs/${orgId}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toContain("Round-Trip-");
    const zip = new Uint8Array(await res.arrayBuffer());

    const fd = new FormData();
    fd.set("file", new File([zip], "export.zip", { type: "application/zip" }));
    const clash = await owner.json("POST", "/api/v1/imports/org", fd);
    expect(clash.status).toBe(409);

    await env.ctx.orgs.destroy(orgId);
    const fd2 = new FormData();
    fd2.set("file", new File([zip], "export.zip", { type: "application/zip" }));
    fd2.set("name", "Round Trip Restored");
    const ok = await owner.json("POST", "/api/v1/imports/org", fd2);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ org_id: orgId, name: "Round Trip Restored" });
    expect((await owner.json("GET", `/api/v1/orgs/${orgId}/accounts`)).status).toBe(200);
  });
});
