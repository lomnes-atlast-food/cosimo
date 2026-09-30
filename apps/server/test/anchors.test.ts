/**
 * Public timestamps of the chain heads (#11) against a fake network (anchor-mocks.ts): anchoring,
 * upgrades, verification, coverage, the year-end package, and export/import.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anchorDigest, entryHash, otsReplay, parsePemCertificates, tsaVerify } from "@cosimo/core";
import { org } from "@cosimo/db";
import { asc, eq } from "drizzle-orm";
import { strFromU8, unzipSync } from "fflate";
import { registeredJobs, type Scheduler } from "../src/jobs/scheduler.ts";
import { anchorDeps, anchorVerifyOptions, upgradePending } from "../src/services/anchors.ts";
import { verifyOrg } from "../src/services/chain.ts";
import { exportOrg, importOrgArchive } from "../src/services/export.ts";
import type { Mailer } from "../src/services/mailer.ts";
import { CALENDARS, FakeAnchorNet, fakeAnchoring, TEST_TSA_DIR, TSA_URL } from "./anchor-mocks.ts";
import { type Client, createOrg, createTestEnv, DB_MODE, login, type TestEnv } from "./harness.ts";

let env: TestEnv;
let net: FakeAnchorNet;
let owner: Client;
const testRoots = parsePemCertificates(readFileSync(join(TEST_TSA_DIR, "ca.pem"), "utf8"));
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

const job = (name: string) => registeredJobs().find((j) => j.name === name)!;
const run = (name: string, orgId: string) =>
  (env.ctx.services.scheduler as Scheduler).runJob(job(name), orgId);

async function newOrg(name: string) {
  const id = await createOrg(env, owner, name);
  const r = await owner.json("GET", `/api/v1/orgs/${id}/accounts`);
  const acct = Object.fromEntries((r.body.data as { code: string; id: string }[]).map((a) => [a.code, a.id]));
  const post = async (amount: number, date = "2026-03-01") => {
    const res = await owner.json("POST", `/api/v1/orgs/${id}/entries`, {
      date,
      memo: `sale ${amount}`,
      lines: [
        { account_id: acct["1000"], amount },
        { account_id: acct["4000"], amount: -amount },
      ],
    });
    expect(res.status).toBe(201);
    return res.body.entry.id as string;
  };
  return { id, post, h: await env.ctx.orgs.mustOpen(id) };
}

async function anchors(orgId: string) {
  const h = await env.ctx.orgs.mustOpen(orgId);
  return h.db.select().from(org.chainAnchors).orderBy(asc(org.chainAnchors.createdAt)).all();
}

/** Drop every trigger on a table, as someone with raw database access could. */
async function dropTriggers(
  h: { client: { execute: (s: string) => Promise<{ rows: unknown[] }> } },
  table: string,
) {
  const r = await h.client.execute(
    `select name from sqlite_master where type = 'trigger' and tbl_name = '${table}'`,
  );
  for (const row of r.rows as { name: string }[]) await h.client.execute(`drop trigger "${row.name}"`);
}

beforeAll(async () => {
  env = await createTestEnv({ configure: (c) => fakeAnchoring(c) });
  net = new FakeAnchorNet();
  env.ctx.services.anchorFetch = net.fetch;
  owner = await login(env, "anchor-owner@example.com");
});
afterAll(async () => {
  await env.close();
});

describe(`public timestamps (${DB_MODE})`, () => {
  test("the daily job timestamps the heads once, and every proof checks out", async () => {
    const o = await newOrg("Anchor Co");
    await o.post(1000);
    await o.post(2000);
    const first = await run("chain.anchor", o.id);
    expect(first).toMatchObject({ status: "ok" });
    expect(first.detail).toContain("Timestamped ledger #2");

    const rows = await anchors(o.id);
    expect(rows.map((r) => `${r.kind} ${r.status}`).sort()).toEqual([
      "ots pending",
      "ots pending",
      "rfc3161 complete",
    ]);
    expect(new Set(rows.map((r) => r.digest)).size).toBe(1);
    expect(rows.every((r) => r.ledgerSeq === 2 && r.reason === "daily")).toBe(true);
    // Only the digest (behind a nonce, for calendars) went out.
    expect(
      net.calls
        .filter((c) => c.method === "POST")
        .map((c) => c.url)
        .sort(),
    ).toEqual([...CALENDARS.map((c) => `${c}/digest`), TSA_URL].sort());

    const list = await owner.json("GET", `/api/v1/orgs/${o.id}/anchors`);
    expect(list.status).toBe(200);
    expect(list.body.enabled).toBe(true);
    expect(list.body.data).toHaveLength(3);
    expect(list.body.data[0].proof).toBeUndefined();
    expect(list.body.check).toMatchObject({ ok: true, complete: 1, pending: 2, tsa_trust: "checked" });
    expect(list.body.check.coverage).toMatchObject({
      anchored_through: { ledger_seq: 2 },
      unanchored_links: 0,
    });

    // The downloads are what a third party checks.
    const tsaRow = rows.find((r) => r.kind === "rfc3161")!;
    const txt = await owner.req("GET", `/api/v1/orgs/${o.id}/anchors/${tsaRow.id}/proof?file=preimage`);
    const preimage = await txt.text();
    expect(preimage).toStartWith(`cosimo-anchor v1\norg ${o.id}\nledger 2 `);
    expect(sha256(preimage)).toBe(tsaRow.digest);
    const tsr = await owner.req("GET", `/api/v1/orgs/${o.id}/anchors/${tsaRow.id}/proof`);
    expect(tsr.headers.get("content-disposition")).toContain("anchor-2.tsr");
    const v = tsaVerify(new Uint8Array(await tsr.arrayBuffer()), tsaRow.digest, { roots: testRoots });
    expect(v.trusted).toBe(true);
    const otsRow = rows.find((r) => r.kind === "ots")!;
    const ots = await owner.req("GET", `/api/v1/orgs/${o.id}/anchors/${otsRow.id}/proof`);
    expect(ots.headers.get("content-disposition")).toContain("anchor-2.txt.ots");
    const replay = otsReplay(new Uint8Array(await ots.arrayBuffer()));
    expect(replay.digest).toBe(otsRow.digest);
    expect(replay.attestations[0]).toMatchObject({ kind: "pending", url: otsRow.service });

    const verify = await owner.json("POST", `/api/v1/orgs/${o.id}/verify`);
    expect(verify.body.ok).toBe(true);
    expect(verify.body.anchors).toMatchObject({ ok: true, checked: 3, bitcoin: "none" });

    // Nothing changed: no new requests, no new rows.
    const calls = net.calls.length;
    expect((await run("chain.anchor", o.id)).detail).toBe("no activity");
    expect(net.calls.length).toBe(calls);
    expect(await anchors(o.id)).toHaveLength(3);
  });

  test("a failed authority records a failed row, backs off, and never blocks posting", async () => {
    const o = await newOrg("Offline Co");
    await o.post(500);
    net.down.add(TSA_URL);
    try {
      const r = await run("chain.anchor", o.id);
      expect(r.status).toBe("error");
      expect(r.detail).toContain("tsa.test");
      const rows = await anchors(o.id);
      const failed = rows.find((x) => x.kind === "rfc3161")!;
      expect(failed).toMatchObject({ status: "failed", proof: null });
      expect(failed.lastError).toContain("connection refused");
      expect(rows.filter((x) => x.kind === "ots" && x.status === "pending")).toHaveLength(2);

      // Posting goes on, and verification ignores failed rows.
      await o.post(600);
      expect((await verifyOrg(o.h.db, o.id)).ok).toBe(true);

      // Same heads again: the authority isn't asked again until the back-off passes.
      const h2 = await newOrg("Offline Co 2");
      await h2.post(1);
      await run("chain.anchor", h2.id);
      const calls = net.calls.length;
      const again = await run("chain.anchor", h2.id);
      expect(again.status).toBe("ok");
      expect(again.detail).toContain("Waiting to retry");
      expect(net.calls.length).toBe(calls);
    } finally {
      net.down.delete(TSA_URL);
    }
  });

  test("pending proofs complete once in Bitcoin, and the block is checked", async () => {
    const o = await newOrg("Bitcoin Co");
    await o.post(700);
    await run("chain.anchor", o.id);
    expect((await run("chain.anchor.upgrade", o.id)).detail).toContain("0 completed, 2 still pending");

    const minedAt = new Date("2026-10-01T02:03:04.000Z");
    net.confirmAll(915_000, minedAt);
    const up = await run("chain.anchor.upgrade", o.id);
    expect(up.detail).toContain("2 completed");
    const ots = (await anchors(o.id)).filter((r) => r.kind === "ots");
    expect(ots.map((r) => [r.status, r.blockHeight, r.attestedAt])).toEqual([
      ["complete", 915_000, minedAt.toISOString()],
      ["complete", 915_000, minedAt.toISOString()],
    ]);
    const proof = otsReplay(new Uint8Array(Buffer.from(ots[0]!.proof!, "base64")));
    expect(proof.attestations).toContainEqual({
      kind: "bitcoin",
      height: 915_000,
      merkleRoot: net.blocks.get(915_000)!.merkle_root,
    });

    const online = await owner.json("POST", `/api/v1/orgs/${o.id}/verify?network=true`);
    expect(online.body).toMatchObject({ ok: true, anchors: { bitcoin: "checked" } });
    const offline = await owner.json("POST", `/api/v1/orgs/${o.id}/verify`);
    expect(offline.body).toMatchObject({ ok: true, anchors: { bitcoin: "not checked" } });

    // An unreachable explorer isn't a failure.
    net.explorerDown = true;
    const down = await owner.json("POST", `/api/v1/orgs/${o.id}/verify?network=true`);
    expect(down.body).toMatchObject({ ok: true, anchors: { bitcoin: "unavailable" } });
    net.explorerDown = false;

    // A block whose merkle root differs is.
    const block = net.blocks.get(915_000)!;
    const real = block.merkle_root;
    block.merkle_root = "00".repeat(32);
    const wrong = await owner.json("POST", `/api/v1/orgs/${o.id}/verify?network=true`);
    expect(wrong.body.ok).toBe(false);
    expect(wrong.body.anchors.problems[0].problem).toContain("merkle root");
    block.merkle_root = real;
  });

  test("a proof still pending after 7 days is marked failed", async () => {
    const o = await newOrg("Slow Co");
    await o.post(800);
    await run("chain.anchor", o.id);
    const later = new Date(Date.now() + 8 * 24 * 3_600_000);
    const r = await upgradePending(env.ctx, o.h, o.id, { ...anchorDeps(env.ctx), now: () => later });
    expect(r).toMatchObject({ checked: 2, failed: 2 });
    const ots = (await anchors(o.id)).filter((x) => x.kind === "ots");
    expect(ots.every((x) => x.status === "failed" && x.lastError?.includes("7 days"))).toBe(true);
  });

  test("anchor rows are append-only", async () => {
    const o = await newOrg("Trigger Co");
    await o.post(900);
    await run("chain.anchor", o.id);
    const [tsa] = (await anchors(o.id)).filter((r) => r.kind === "rfc3161");
    const [ots] = (await anchors(o.id)).filter((r) => r.kind === "ots");
    const rejects = async (sql: string) =>
      expect(o.h.client.execute({ sql, args: [] })).rejects.toThrow(/invariant: /);
    await rejects(`delete from chain_anchors where id = '${tsa!.id}'`);
    await rejects(`update chain_anchors set digest = 'x' where id = '${ots!.id}'`);
    await rejects(`update chain_anchors set ledger_hash = 'x' where id = '${ots!.id}'`);
    await rejects(`update chain_anchors set created_at = 'x' where id = '${ots!.id}'`);
    // Complete and failed rows are frozen; only a pending one moves on.
    await rejects(`update chain_anchors set status = 'failed' where id = '${tsa!.id}'`);
    await rejects(`update chain_anchors set proof = null where id = '${tsa!.id}'`);
    await o.h.client.execute(`update chain_anchors set attempts = attempts + 1 where id = '${ots!.id}'`);
    await expect(
      o.h.client.execute(`update chain_anchors set status = 'bogus' where id = '${ots!.id}'`),
    ).rejects.toThrow();
    await o.h.client.execute(`update chain_anchors set status = 'failed' where id = '${ots!.id}'`);
    await rejects(`update chain_anchors set status = 'pending' where id = '${ots!.id}'`);
  });

  test("rewriting an entry and recomputing the chain fails on the timestamp, though the chain checks pass", async () => {
    const o = await newOrg("Rewrite Co");
    const ids = [await o.post(100), await o.post(200), await o.post(300)];
    await run("chain.anchor", o.id);
    expect((await verifyOrg(o.h.db, o.id)).ok).toBe(true);

    // Someone with the database file edits entry #2 and rebuilds every hash after it, checkpoints
    // included, so the chain checks alone see nothing wrong.
    await dropTriggers(o.h, "journal_entries");
    await o.h.client.execute({
      sql: "update journal_entries set memo = 'cooked' where id = ?",
      args: [ids[1]!],
    });
    const entries = await o.h.db
      .select()
      .from(org.journalEntries)
      .where(eq(org.journalEntries.status, "posted"))
      .orderBy(asc(org.journalEntries.chainSeq))
      .all();
    const lines = await o.h.db.select().from(org.journalLines).all();
    let prev = entries[0]!.prevHash!;
    for (const e of entries) {
      const hash = entryHash(o.id, prev, {
        id: e.id,
        chainSeq: e.chainSeq!,
        date: e.date,
        memo: e.memo,
        sourceType: e.sourceType,
        sourceId: e.sourceId,
        reversesEntryId: e.reversesEntryId,
        createdBy: e.createdBy,
        createdByActor: e.createdByActor,
        postedAt: e.postedAt!,
        postedBy: e.postedBy,
        lockOverrideNote: e.lockOverrideNote,
        lines: lines.filter((l) => l.entryId === e.id),
      });
      await o.h.client.execute({
        sql: "update journal_entries set prev_hash = ?, entry_hash = ? where id = ?",
        args: [prev, hash, e.id],
      });
      prev = hash;
    }
    await dropTriggers(o.h, "chain_checkpoints");
    const cps = await o.h.db
      .select()
      .from(org.chainCheckpoints)
      .where(eq(org.chainCheckpoints.chain, "ledger"))
      .all();
    for (const cp of cps) {
      const e = await o.h.db
        .select({ hash: org.journalEntries.entryHash })
        .from(org.journalEntries)
        .where(eq(org.journalEntries.chainSeq, cp.seq))
        .get();
      if (e)
        await o.h.client.execute({
          sql: "update chain_checkpoints set head_hash = ? where id = ?",
          args: [e.hash, cp.id],
        });
    }

    const v = await verifyOrg(o.h.db, o.id, { anchors: anchorVerifyOptions(env.ctx) });
    expect(v.ledger.ok).toBe(true);
    expect(v.audit.ok).toBe(true);
    expect(v.checkpoints.ok).toBe(true);
    expect(v.anchors.ok).toBe(false);
    expect(v.ok).toBe(false);
    expect(v.anchors.problems).toHaveLength(3);
    expect(v.anchors.problems[0]!.problem).toBe(
      "ledger link #3 has a different hash since it was timestamped",
    );

    // Rewriting the anchors to the new heads doesn't help: the proofs commit to the old digest.
    await dropTriggers(o.h, "chain_anchors");
    const row = (await anchors(o.id))[0]!;
    const forged = anchorDigest(o.id, { seq: 3, hash: prev }, { seq: row.auditSeq, hash: row.auditHash });
    await o.h.client.execute({
      sql: "update chain_anchors set ledger_hash = ?, digest = ?",
      args: [prev, forged],
    });
    const v2 = await verifyOrg(o.h.db, o.id, { anchors: anchorVerifyOptions(env.ctx) });
    expect(v2.ok).toBe(false);
    expect(v2.anchors.problems.map((p) => p.problem).sort()).toEqual([
      "the proof doesn't commit to the digest",
      "the proof doesn't commit to the digest",
      "the token's imprint doesn't match the digest",
    ]);

    // The weekly check alerts owners, and nothing new is timestamped over the broken books.
    const mail = (env.ctx.services.mailer as Mailer).useTestTransport();
    const weekly = await run("chain.verify", o.id);
    expect(weekly.status).toBe("error");
    expect(weekly.detail).toContain("timestamp of ledger seq 3");
    expect(mail.length).toBe(1);
    // Posting still works; timestamping refuses.
    await o.post(400);
    const now = await owner.json("POST", `/api/v1/orgs/${o.id}/anchors`);
    expect(now.status).toBe(200);
    expect(now.body.result.status).toBe("broken");
  });

  test("deleted anchors show up as a coverage gap, not a failure", async () => {
    const saved = env.ctx.config.anchoring.ots_calendars;
    env.ctx.config.anchoring.ots_calendars = "";
    try {
      const o = await newOrg("Gap Co");
      const at = (days: number) => () => new Date(Date.now() + days * 24 * 3_600_000).toISOString();
      await o.post(1);
      await run("chain.anchor", o.id);
      await o.post(2);
      await run("chain.anchor", o.id);
      await o.post(3);
      net.genTime = at(5);
      await run("chain.anchor", o.id);
      net.genTime = at(0);
      const rows = await anchors(o.id);
      expect(rows.map((r) => r.ledgerSeq)).toEqual([1, 2, 3]);

      const check = async () =>
        (await verifyOrg(o.h.db, o.id, { anchors: anchorVerifyOptions(env.ctx) })).anchors;
      const full = await check();
      expect(full.ok).toBe(true);
      expect(full.coverage).toMatchObject({
        anchored_through: { ledger_seq: 3 },
        unanchored_links: 0,
        late_entries: 1,
      });
      expect(full.coverage.earliest_anchor_at).toBe(rows[0]!.attestedAt);

      await dropTriggers(o.h, "chain_anchors");
      await o.h.client.execute({ sql: "delete from chain_anchors where id = ?", args: [rows[1]!.id] });
      const gap = await check();
      expect(gap.ok).toBe(true);
      expect(gap.coverage).toMatchObject({ anchored_through: { ledger_seq: 3 }, late_entries: 2 });

      await o.h.client.execute({ sql: "delete from chain_anchors where id = ?", args: [rows[2]!.id] });
      const tail = await check();
      expect(tail.ok).toBe(true);
      expect(tail.coverage).toMatchObject({
        anchored_through: { ledger_seq: 1 },
        unanchored_links: 2,
        late_entries: 0,
      });
    } finally {
      env.ctx.config.anchoring.ots_calendars = saved;
      net.genTime = () => new Date().toISOString();
    }
  });

  test("the year-end package carries the proofs and their preimage", async () => {
    const o = await newOrg("Year End Co");
    await o.post(1234, "2025-06-30");
    const res = await owner.req("GET", `/api/v1/orgs/${o.id}/year-end?year=2025`);
    expect(res.status).toBe(200);
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const chain = JSON.parse(strFromU8(files["chain.json"]!));
    expect(chain.anchors).toHaveLength(1);
    const a = chain.anchors[0];
    expect(a).toMatchObject({
      ledger: chain.ledger,
      audit: chain.audit,
      file: `anchors/anchor-${chain.ledger.seq}.txt`,
    });
    expect(a.proofs.map((p: { kind: string }) => p.kind).sort()).toEqual(["ots", "ots", "rfc3161"]);
    const txt = files[a.file]!;
    expect(sha256(txt)).toBe(a.digest);
    const ots = otsReplay(files[`${a.file}.ots`]!);
    expect(ots.digest).toBe(a.digest);
    // The calendars' proofs are combined into one file, as `ots stamp` writes them.
    expect(ots.attestations.map((x) => (x as { url: string }).url).sort()).toEqual(CALENDARS);
    const tsr = files[`anchors/anchor-${chain.ledger.seq}.tsr`]!;
    expect(tsaVerify(tsr, a.digest, { roots: testRoots }).trusted).toBe(true);
    expect(strFromU8(files["anchors/tsa.crt"]!)).toContain("BEGIN CERTIFICATE");
    // FreeTSA's root only ships with FreeTSA's tokens.
    expect(files["anchors/cacert.pem"]).toBeUndefined();
    const readme = strFromU8(files["README.txt"]!);
    expect(readme).toContain("ots upgrade anchors/anchor-<n>.txt.ots");
    expect(readme).toContain("openssl ts -verify");

    // With every service down the package still builds.
    for (const u of [...CALENDARS, TSA_URL]) net.down.add(u);
    try {
      await o.post(1, "2025-07-01");
      const offline = await owner.req("GET", `/api/v1/orgs/${o.id}/year-end?year=2025`);
      expect(offline.status).toBe(200);
      const f2 = unzipSync(new Uint8Array(await offline.arrayBuffer()));
      expect(strFromU8(f2["README.txt"]!)).toContain("Note: Timestamping failed");
    } finally {
      net.down.clear();
    }
  });

  test("export and import keep the anchors, and they still verify", async () => {
    const o = await newOrg("Export Co");
    await o.post(4242);
    await run("chain.anchor", o.id);
    const before = await anchors(o.id);
    const tmp = mkdtempSync(join(tmpdir(), "cosimo-anchor-export-"));
    try {
      const zip = join(tmp, "export.zip");
      const manifest = await exportOrg(env.ctx, o.id, zip);
      expect(manifest.tables.chain_anchors!.rows).toBe(3);
      await env.ctx.orgs.destroy(o.id);
      const res = await importOrgArchive(env.ctx, new Uint8Array(readFileSync(zip)), {
        userId: owner.userId,
      });
      expect(res.chains_ok).toBe(true);
      const h = await env.ctx.orgs.mustOpen(o.id);
      expect(
        await h.db.select().from(org.chainAnchors).orderBy(asc(org.chainAnchors.createdAt)).all(),
      ).toEqual(before);
      const v = await verifyOrg(h.db, o.id, { anchors: anchorVerifyOptions(env.ctx) });
      expect(v.ok).toBe(true);
      expect(v.anchors.checked).toBe(3);
      await expect(h.client.execute("delete from chain_anchors")).rejects.toThrow(/invariant: /);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe(`public timestamps turned off (${DB_MODE})`, () => {
  let off: TestEnv;
  beforeAll(async () => {
    off = await createTestEnv();
  });
  afterAll(async () => {
    await off.close();
  });

  test("no anchoring jobs run, the API says so, and verify still reports", async () => {
    expect(off.ctx.config.anchoring.enabled).toBe(false);
    // Jobs register once per process; with anchoring off they are never due.
    for (const name of ["chain.anchor", "chain.anchor.upgrade"]) {
      const j = registeredJobs().find((x) => x.name === name);
      if (j) expect(await j.due(new Date("2026-06-07T12:00:00Z"), null, off.ctx, null)).toBe(false);
    }
    const o = await login(off, "off-owner@example.com");
    const id = await createOrg(off, o, "Off Co");
    const list = await o.json("GET", `/api/v1/orgs/${id}/anchors`);
    expect(list.body).toMatchObject({ enabled: false, data: [], check: { ok: true, checked: 0 } });
    const now = await o.json("POST", `/api/v1/orgs/${id}/anchors`);
    expect(now.status).toBe(409);
    expect(now.body.error.code).toBe("anchoring_disabled");
    const v = await o.json("POST", `/api/v1/orgs/${id}/verify`);
    expect(v.body).toMatchObject({ ok: true, anchors: { ok: true, coverage: { anchored_through: null } } });
  });
});
