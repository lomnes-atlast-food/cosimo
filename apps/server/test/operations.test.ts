/**
 * Operations (SPEC §14): backups (snapshot, manifest, retention, chain anchoring), restore, and the
 * open export format round trip (export → delete → import reproduces identical reports).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectOrg, org } from "@cosimo/db";
import { eq } from "drizzle-orm";
import { readZip } from "../src/services/archive.ts";
import { type BackupManifest, createBackup, restoreBackup, retentionPlan } from "../src/services/backup.ts";
import { verifyOrg } from "../src/services/chain.ts";
import { type ExportManifest, exportOrg, importOrgArchive } from "../src/services/export.ts";
import { type Client, createOrg, createTestEnv, DB_MODE, login, type TestEnv } from "./harness.ts";

const down = (async () => {
  throw new Error("connection refused");
}) as unknown as typeof fetch;

let env: TestEnv;
let owner: Client;
let orgId: string;
const tmp = mkdtempSync(join(tmpdir(), "cosimo-ops-"));
const base = () => `/api/v1/orgs/${orgId}`;
let acct: Record<string, string>;
let invoiceId: string;

async function post(date: string, amount: number, memo: string) {
  const r = await owner.json("POST", `${base()}/entries`, {
    date,
    memo,
    lines: [
      { account_id: acct["1000"], amount },
      { account_id: acct["4000"], amount: -amount },
    ],
  });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.entry.id as string;
}

/** Every report, minus the generation timestamp. */
async function allReports() {
  const out: Record<string, unknown> = {};
  const q = "from=2026-01-01&to=2026-12-31&as_of=2026-12-31&year=2026";
  for (const key of [
    "trial_balance",
    "profit_and_loss",
    "balance_sheet",
    "cash_flow",
    "tax_line_summary",
    "general_ledger",
    "ar_aging",
    "ap_aging",
    "vendor_1099",
  ]) {
    for (const basis of ["accrual", "cash"]) {
      const r = await owner.json("GET", `${base()}/reports/${key}?${q}&basis=${basis}`);
      expect(r.status).toBe(200);
      const { meta, ...rest } = r.body;
      const { generated_at: _g, ...m } = meta ?? {};
      out[`${key}:${basis}`] = { ...rest, meta: m };
    }
  }
  return out;
}

beforeAll(async () => {
  env = await createTestEnv();
  owner = await login(env, "ops-owner@example.com");
  orgId = await createOrg(env, owner, "Ops Co", { basis: "accrual" });
  acct = Object.fromEntries(
    (await owner.json("GET", `${base()}/accounts`)).body.data.map((a: { code: string; id: string }) => [
      a.code,
      a.id,
    ]),
  );
  await post("2026-01-05", 150000, "January sales");
  await post("2026-02-05", 90000, "February sales");
  const customer = (await owner.json("POST", `${base()}/contacts`, { kind: "customer", name: "Globex" })).body
    .id;
  const inv = (
    await owner.json("POST", `${base()}/invoices`, {
      customer_id: customer,
      issue_date: "2026-03-01",
      lines: [{ description: "Work", quantity_milli: 2000, unit_price: 50000, account_id: acct["4000"] }],
    })
  ).body;
  invoiceId = inv.id;
  await owner.json("POST", `${base()}/invoices/${inv.id}/finalize`, {});
  await owner.json("POST", `${base()}/payments`, {
    direction: "received",
    contact_id: customer,
    date: "2026-03-20",
    amount: 40000,
    account_id: acct["1000"],
    applications: [{ document_id: inv.id, amount: 40000 }],
  });
  const ba = (await owner.json("POST", `${base()}/bank-accounts`, { name: "Ops checking", kind: "checking" }))
    .body;
  await owner.json("POST", `${base()}/bank-accounts/${ba.id}/import`, {
    filename: "apr.csv",
    content: "Date,Description,Amount\n2026-04-02,COFFEE,-4.50\n2026-04-03,CLIENT,300.00\n",
  });
  const fd = new FormData();
  fd.append(
    "file",
    new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 10])], "r.pdf", {
      type: "application/pdf",
    }),
  );
  fd.append("target_type", "invoice");
  fd.append("target_id", inv.id);
  const up = await owner.req("POST", `${base()}/attachments`, fd);
  expect(up.status).toBe(201);
});

afterAll(async () => {
  await env.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("admin update check", () => {
  test("instance admin only", async () => {
    expect((await owner.json("GET", "/api/v1/admin/update")).status).toBe(403);
  });

  test("an admin gets an UpdateStatus (a source run never calls out)", async () => {
    const admin = await login(env, "ops-admin@example.com", { admin: true });
    const r = await admin.json("GET", "/api/v1/admin/update");
    expect(r.status).toBe(200);
    // `bun test` is a source run, so VERSION is the dev version and the check never fires.
    expect(r.body).toMatchObject({ status: "dev", latest: null, instructions: [] });
  });
});

describe(`backups (${DB_MODE})`, () => {
  test("a backup holds consistent database snapshots, a clean config, and anchors the chain heads", async () => {
    const r = await createBackup(env.ctx, { reason: "manual" });
    expect(r.destination).toBe("local");
    expect(r.name).toMatch(/^cosimo-backup-\d{8}T\d{6}Z\.zip$/);
    expect(r.secrets_omitted).toBe(true);
    const files = readZip(new Uint8Array(readFileSync(r.file)));
    const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]!)) as BackupManifest;
    expect(manifest.orgs.map((o) => o.id)).toContain(orgId);
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(["system.db", `orgs/${orgId}.db`, "config.toml"]),
    );
    expect(manifest.attachments).toBe("included");
    expect(Object.keys(files).some((f) => f.startsWith("attachments/"))).toBe(true);
    const cfg = new TextDecoder().decode(files["config.toml"]!);
    expect(cfg).not.toContain(env.config.security.master_key);
    expect(cfg).toContain('master_key = ""');

    // The snapshot is a real, verifiable database with the same chain head.
    const snap = join(tmp, "snap.db");
    writeFileSync(snap, files[`orgs/${orgId}.db`]!);
    const h = connectOrg(`file:${snap}`);
    const v = await verifyOrg(h.db, orgId);
    h.close();
    expect(v.ok).toBe(true);
    const head = manifest.orgs.find((o) => o.id === orgId)!.ledger_head;
    expect(head.seq).toBeGreaterThan(0);

    const live = await env.ctx.orgs.mustOpen(orgId);
    const cps = await live.db
      .select()
      .from(org.chainCheckpoints)
      .where(eq(org.chainCheckpoints.reason, "backup"))
      .all();
    expect(cps.map((c) => c.exportedTo)).toEqual([r.file, r.file]);
    expect((await env.ctx.settings.get("last_backup"))?.file).toBe(r.file);
  });

  test("retention keeps 14 daily, 8 weekly, 12 monthly", () => {
    const names: string[] = [];
    const start = Date.UTC(2025, 0, 1);
    for (let d = 0; d < 500; d++) {
      const iso = new Date(start + d * 86_400_000).toISOString();
      names.push(`cosimo-backup-${iso.slice(0, 10).replace(/-/g, "")}T030000Z.zip`);
    }
    names.push("unrelated.txt");
    const plan = retentionPlan(names, { daily: 14, weekly: 8, monthly: 12 });
    expect(plan.keep.length).toBeLessThanOrEqual(14 + 8 + 12);
    expect(plan.keep).toContain(names[499]!);
    expect(plan.keep).toContain(names[486]!); // 14th most recent day
    expect(plan.remove).not.toContain("unrelated.txt");
    expect(plan.keep.length + plan.remove.length).toBe(500);
    // Monthly: the newest backup of each of the last 12 months survives.
    const months = new Set(plan.keep.map((n) => n.slice(14, 20)));
    expect(months.size).toBe(12);
  });

  test.skipIf(DB_MODE !== "sqlite")(
    "restore brings back the backed-up state into a stopped instance",
    async () => {
      const r2 = await createBackup(env.ctx, { reason: "manual" });
      const before = await allReports();
      await post("2026-05-05", 1000, "after the backup");
      expect(await allReports()).not.toEqual(before);

      const cfg = env.config;
      await env.ctx.close();
      const res = await restoreBackup(cfg, r2.file, { fetchImpl: down });
      expect(res.orgs.find((o) => o.id === orgId)).toMatchObject({ chains_ok: true, integrity: "ok" });
      expect(res.previous_data).toContain("data.before-restore-");
      expect(res.attachments_restored).toBeGreaterThan(0);
      expect(res.warnings.join(" ")).toContain("no secrets");

      // Reopen the instance on the restored files.
      const reopened = await createTestEnv({ configure: (c) => Object.assign(c, structuredClone(cfg)) });
      env = reopened;
      owner = await login(env, "ops-owner@example.com");
      expect(await allReports()).toEqual(before);

      const running = await restoreBackup(cfg, r2.file, {
        fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch,
      }).catch((e) => e);
      expect(running.code).toBe("server_running");
    },
  );
});

describe(`open-format export and import (${DB_MODE})`, () => {
  test("export → delete → import reproduces identical reports and intact chains", async () => {
    const before = await allReports();
    const zip = join(tmp, "ops.zip");
    const manifest: ExportManifest = await exportOrg(env.ctx, orgId, zip);
    expect(manifest.secrets_omitted).toBe(true);
    expect(manifest.tables.journal_entries!.rows).toBeGreaterThan(0);
    const files = readZip(new Uint8Array(readFileSync(zip)));
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(["manifest.json", "org.json", "members.json", "tables/journal_entries.jsonl"]),
    );
    expect(Object.keys(files).some((f) => f.startsWith("attachments/"))).toBe(true);

    // Importing over an existing org is refused.
    const dup = await importOrgArchive(env.ctx, new Uint8Array(readFileSync(zip)), {
      userId: owner.userId,
    }).catch((e) => e);
    expect(dup.code).toBe("org_exists");

    await env.ctx.orgs.destroy(orgId);
    expect((await owner.json("GET", `${base()}/reports/trial_balance?as_of=2026-12-31`)).status).toBe(404);

    const res = await importOrgArchive(env.ctx, new Uint8Array(readFileSync(zip)), { userId: owner.userId });
    expect(res).toMatchObject({ org_id: orgId, name: "Ops Co", chains_ok: true });
    expect(res.attachments).toBeGreaterThan(0);
    expect(await allReports()).toEqual(before);
    const h = await env.ctx.orgs.mustOpen(orgId);
    expect((await verifyOrg(h.db, orgId)).ok).toBe(true);

    // The attachment is served again.
    const list = await owner.json("GET", `${base()}/attachments?target_type=invoice&target_id=${invoiceId}`);
    expect(list.body.data).toHaveLength(1);
    const dl = await owner.req("GET", `${base()}/attachments/${list.body.data[0].id}`);
    expect(dl.status).toBe(200);
    expect(new Uint8Array(await dl.arrayBuffer()).slice(0, 5)).toEqual(
      new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
    );
  });

  test("a tampered export is rejected", async () => {
    const zip = join(tmp, "ops2.zip");
    await exportOrg(env.ctx, orgId, zip);
    const { zipSync } = await import("fflate");
    const files = readZip(new Uint8Array(readFileSync(zip)));
    // Change an amount but fix up the checksum, as a forger would.
    const text = new TextDecoder().decode(files["tables/journal_lines.jsonl"]!);
    const forged = text
      .replace(/"amount":150000/, '"amount":150001')
      .replace(/"amount":-150000/, '"amount":-150001');
    expect(forged).not.toBe(text);
    files["tables/journal_lines.jsonl"] = new TextEncoder().encode(forged);
    const m = JSON.parse(new TextDecoder().decode(files["manifest.json"]!)) as ExportManifest;
    const { sha256Hex } = await import("@cosimo/core");
    m.files["tables/journal_lines.jsonl"] = {
      sha256: sha256Hex(files["tables/journal_lines.jsonl"]!),
      bytes: forged.length,
    };
    files["manifest.json"] = new TextEncoder().encode(JSON.stringify(m));
    await env.ctx.orgs.destroy(orgId);
    const err = await importOrgArchive(env.ctx, zipSync(files), { userId: owner.userId }).catch((e) => e);
    expect(err.code).toBe("chain_broken");
    expect(await env.ctx.orgs.get(orgId)).toBeFalsy();

    // Damaged (checksum mismatch) is caught before anything is created.
    files["tables/journal_lines.jsonl"] = new TextEncoder().encode(`${forged} `);
    const err2 = await importOrgArchive(env.ctx, zipSync(files), { userId: owner.userId }).catch((e) => e);
    expect(err2.code).toBe("checksum_mismatch");
  });
});
