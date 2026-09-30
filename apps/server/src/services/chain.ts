/**
 * Ledger and audit chain helpers: heads, checkpoints, verification (SPEC §6.5).
 */
import {
  auditGenesis,
  auditHash,
  type ChainBreak,
  entryHash,
  ledgerGenesis,
  type VerifyResult,
  verifyChain,
} from "@cosimo/core";
import { newId, type OrgDb, type OrgTx, org } from "@cosimo/db";
import { and, asc, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { type AnchorVerifyOptions, type AnchorVerifyResult, verifyAnchors } from "./anchor-verify.ts";
import type { OrgHandle } from "./types.ts";

type Reader = OrgDb | OrgTx;

export interface ChainHead {
  seq: number;
  hash: string;
}

export async function ledgerHead(db: Reader, orgId: string): Promise<ChainHead> {
  const row = await db
    .select({ seq: org.journalEntries.chainSeq, hash: org.journalEntries.entryHash })
    .from(org.journalEntries)
    .where(isNotNull(org.journalEntries.chainSeq))
    .orderBy(desc(org.journalEntries.chainSeq))
    .limit(1)
    .get();
  return row?.seq ? { seq: row.seq, hash: row.hash! } : { seq: 0, hash: ledgerGenesis(orgId) };
}

/**
 * The ledger head recomputed from the rows themselves (SPEC §6.5, acceptance #9). Report footers
 * show this rather than the stored hash, so a row edited behind the app's back changes the
 * footer hash and it no longer matches earlier reports or the last checkpoint. `intact` is false
 * when any stored hash disagrees with the recomputed one.
 */
export async function recomputedLedgerHead(
  db: Reader,
  orgId: string,
): Promise<ChainHead & { intact: boolean }> {
  const rows = await loadLedgerRows(db, 1);
  let prev = ledgerGenesis(orgId);
  let intact = true;
  let seq = 0;
  for (const r of rows) {
    if (r.prevHash !== prev || r.seq !== seq + 1) intact = false;
    prev = entryHash(orgId, prev, r);
    if (prev !== r.hash) intact = false;
    seq = r.seq;
  }
  return { seq, hash: prev, intact };
}

export async function auditHead(db: Reader, orgId: string): Promise<ChainHead> {
  const row = await db
    .select({ seq: org.auditLog.seq, hash: org.auditLog.hash })
    .from(org.auditLog)
    .orderBy(desc(org.auditLog.seq))
    .limit(1)
    .get();
  return row ? { seq: row.seq, hash: row.hash } : { seq: 0, hash: auditGenesis(orgId) };
}

export async function lastCheckpoint(db: Reader, chain: "ledger" | "audit") {
  return db
    .select()
    .from(org.chainCheckpoints)
    .where(eq(org.chainCheckpoints.chain, chain))
    .orderBy(desc(org.chainCheckpoints.seq), desc(org.chainCheckpoints.createdAt))
    .limit(1)
    .get();
}

/** Record the current head of both chains. Must run inside the org write transaction. */
export async function checkpoint(tx: OrgTx, orgId: string, reason: string) {
  const out = [];
  for (const chain of ["ledger", "audit"] as const) {
    const head = chain === "ledger" ? await ledgerHead(tx, orgId) : await auditHead(tx, orgId);
    const row = { id: newId(), chain, seq: head.seq, headHash: head.hash, reason };
    await tx.insert(org.chainCheckpoints).values(row);
    out.push(row);
  }
  return out;
}

/** Checkpoint when either chain moved since its last checkpoint (the daily job). */
export async function checkpointIfChanged(h: OrgHandle, orgId: string, reason = "daily") {
  return h.write(async (tx) => {
    const lh = await ledgerHead(tx, orgId);
    const ah = await auditHead(tx, orgId);
    const lc = await lastCheckpoint(tx, "ledger");
    const ac = await lastCheckpoint(tx, "audit");
    if (lc?.headHash === lh.hash && ac?.headHash === ah.hash) return null;
    return checkpoint(tx, orgId, reason);
  });
}

async function loadLedgerRows(db: Reader, fromSeq: number) {
  const entries = await db
    .select()
    .from(org.journalEntries)
    .where(and(isNotNull(org.journalEntries.chainSeq), gte(org.journalEntries.chainSeq, fromSeq)))
    .orderBy(asc(org.journalEntries.chainSeq))
    .all();
  const ids = entries.map((e) => e.id);
  const lines = [];
  for (let i = 0; i < ids.length; i += 500) {
    lines.push(
      ...(await db
        .select()
        .from(org.journalLines)
        .where(inArray(org.journalLines.entryId, ids.slice(i, i + 500)))
        .all()),
    );
  }
  const byEntry = new Map<string, typeof lines>();
  for (const l of lines) {
    const list = byEntry.get(l.entryId) ?? [];
    list.push(l);
    byEntry.set(l.entryId, list);
  }
  return entries.map((e) => ({
    id: e.id,
    seq: e.chainSeq!,
    prevHash: e.prevHash ?? "",
    hash: e.entryHash ?? "",
    chainSeq: e.chainSeq!,
    date: e.date,
    memo: e.memo,
    sourceType: e.sourceType,
    sourceId: e.sourceId,
    reversesEntryId: e.reversesEntryId,
    createdBy: e.createdBy,
    createdByActor: e.createdByActor,
    postedAt: e.postedAt ?? "",
    postedBy: e.postedBy,
    lockOverrideNote: e.lockOverrideNote,
    status: e.status,
    lines: (byEntry.get(e.id) ?? []).map((l) => ({
      id: l.id,
      accountId: l.accountId,
      amount: l.amount,
      currency: l.currency,
      description: l.description,
      contactId: l.contactId,
      lineOrder: l.lineOrder,
    })),
  }));
}

export interface OrgVerifyResult {
  ok: boolean;
  ledger: VerifyResult;
  audit: VerifyResult;
  checkpoints: {
    ok: boolean;
    mismatches: { chain: string; seq: number; expected: string; actual: string | null }[];
  };
  firstBreak: ChainBreak | null;
  /** Public timestamps (anchor-verify.ts): a mismatch or invalid proof fails `ok`; coverage doesn't. */
  anchors: AnchorVerifyResult;
}

/**
 * Recompute both chains. With `tail`, verify only the last N links of each chain, starting from
 * the stored prev_hash of the first link verified (fast check for doctor). Every stored anchor is
 * checked either way; `anchors` adds trusted TSA roots and the Bitcoin block lookup.
 */
export async function verifyOrg(
  db: Reader,
  orgId: string,
  opts: { tail?: number; anchors?: AnchorVerifyOptions } = {},
): Promise<OrgVerifyResult> {
  const lh = await ledgerHead(db, orgId);
  const ah = await auditHead(db, orgId);
  const lFrom = opts.tail ? Math.max(1, lh.seq - opts.tail + 1) : 1;
  const aFrom = opts.tail ? Math.max(1, ah.seq - opts.tail + 1) : 1;

  const ledgerRows = await loadLedgerRows(db, lFrom);
  const lgen = ledgerGenesis(orgId);
  const lStartPrev = lFrom === 1 ? lgen : (ledgerRows[0]?.prevHash ?? lgen);
  const ledger = verifyChain("ledger", ledgerRows, (prev, r) => entryHash(orgId, prev, r), lgen, {
    seq: lFrom,
    prevHash: lStartPrev,
  });
  // A posted entry must be in the chain and a non-posted entry must not be.
  if (ledger.ok) {
    const stray = ledgerRows.find((r) => r.status !== "posted");
    if (stray) {
      ledger.ok = false;
      ledger.firstBreak = {
        chain: "ledger",
        seq: stray.seq,
        id: stray.id,
        reason: "chained entry is no longer posted",
      };
    }
  }
  if (ledger.ok && !opts.tail) {
    const unchained = await db
      .select({ id: org.journalEntries.id })
      .from(org.journalEntries)
      .where(and(eq(org.journalEntries.status, "posted")))
      .all();
    if (unchained.length !== ledgerRows.length) {
      ledger.ok = false;
      ledger.firstBreak = {
        chain: "ledger",
        seq: 0,
        id: null,
        reason: "posted entries exist outside the chain",
      };
    }
  }

  const auditRows = await db
    .select()
    .from(org.auditLog)
    .where(gte(org.auditLog.seq, aFrom))
    .orderBy(asc(org.auditLog.seq))
    .all();
  const agen = auditGenesis(orgId);
  const audit = verifyChain("audit", auditRows, (prev, r) => auditHash(orgId, prev, r), agen, {
    seq: aFrom,
    prevHash: aFrom === 1 ? agen : (auditRows[0]?.prevHash ?? agen),
  });

  // Checkpoints: the stored hash at each checkpointed seq must still match.
  const cps = await db.select().from(org.chainCheckpoints).orderBy(asc(org.chainCheckpoints.seq)).all();
  const mismatches: OrgVerifyResult["checkpoints"]["mismatches"] = [];
  const ledgerBySeq = new Map(ledgerRows.map((r) => [r.seq, r.hash]));
  const auditBySeq = new Map(auditRows.map((r) => [r.seq, r.hash]));
  for (const cp of cps) {
    if (cp.seq === 0) continue;
    const map = cp.chain === "ledger" ? ledgerBySeq : auditBySeq;
    const from = cp.chain === "ledger" ? lFrom : aFrom;
    if (cp.seq < from) continue;
    const actual = map.get(cp.seq) ?? null;
    if (actual !== cp.headHash)
      mismatches.push({ chain: cp.chain, seq: cp.seq, expected: cp.headHash, actual });
  }
  const firstBreak = ledger.firstBreak ?? audit.firstBreak ?? null;
  const anchors = await verifyAnchors(db, orgId, opts.anchors);
  return {
    ok: ledger.ok && audit.ok && mismatches.length === 0 && anchors.ok,
    ledger,
    audit,
    checkpoints: { ok: mismatches.length === 0, mismatches },
    firstBreak,
    anchors,
  };
}
