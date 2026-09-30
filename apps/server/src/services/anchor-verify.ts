/**
 * Checking public timestamps against the books (SPEC §6.5, #11). `verifyOrg` folds the result into
 * its `ok`: a stored anchor whose heads no longer match the chain, whose digest isn't the digest of
 * its heads, or whose proof doesn't commit to that digest means the books changed after they were
 * timestamped. Coverage (how much of the ledger is timestamped, and how promptly) is reported but
 * never fails verification. Anchoring itself is in anchors.ts; this file has no network I/O beyond
 * the optional Bitcoin block lookup.
 */
import type { X509Certificate } from "node:crypto";
import { anchorDigest, auditGenesis, ledgerGenesis, otsReplay, ProofError, tsaVerify } from "@cosimo/core";
import { type OrgDb, type OrgTx, org } from "@cosimo/db";
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";

type Reader = OrgDb | OrgTx;

/** A Bitcoin block explorer with the Esplora API (blockstream.info, mempool.space). */
export interface BitcoinLookup {
  fetch: typeof fetch;
  /** e.g. https://blockstream.info/api */
  api: string;
}

export interface BlockInfo {
  height: number;
  hash: string;
  /** As explorers print it (byte-reversed from the header), which `otsReplay` matches. */
  merkleRoot: string;
  time: string;
}

/** `GET /block-height/{h}` then `GET /block/{hash}`. Throws when the explorer can't answer. */
export async function lookupBlock(net: BitcoinLookup, height: number): Promise<BlockInfo> {
  const base = net.api.replace(/\/+$/, "");
  const opts = () => ({ signal: AbortSignal.timeout(20_000) });
  const r1 = await net.fetch(`${base}/block-height/${height}`, opts());
  if (!r1.ok) throw new Error(`block explorer returned HTTP ${r1.status} for height ${height}`);
  const hash = (await r1.text()).trim();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("block explorer returned an unexpected block hash");
  const r2 = await net.fetch(`${base}/block/${hash}`, opts());
  if (!r2.ok) throw new Error(`block explorer returned HTTP ${r2.status} for block ${hash}`);
  const b = (await r2.json()) as { height?: number; merkle_root?: string; timestamp?: number };
  if (b.height !== height || typeof b.merkle_root !== "string" || typeof b.timestamp !== "number")
    throw new Error("block explorer returned an unexpected block");
  return { height, hash, merkleRoot: b.merkle_root, time: new Date(b.timestamp * 1000).toISOString() };
}

export interface AnchorProblem {
  id: string;
  kind: "ots" | "rfc3161";
  service: string;
  ledger_seq: number;
  audit_seq: number;
  problem: string;
}

export interface AnchorCoverage {
  /** The furthest ledger link a complete proof covers, and the earliest time a proof shows for it. */
  anchored_through: { ledger_seq: number; at: string } | null;
  earliest_anchor_at: string | null;
  /** Ledger links after `anchored_through`. */
  unanchored_links: number;
  /** Entries whose first covering proof is more than 48 hours after they were posted. */
  late_entries: number;
}

export interface AnchorVerifyResult {
  ok: boolean;
  /** Rows checked (every row that isn't failed). */
  checked: number;
  complete: number;
  pending: number;
  failed: number;
  /** "checked": every complete OpenTimestamps proof was confirmed against a block explorer. */
  bitcoin: "checked" | "not checked" | "unavailable" | "none";
  /** RFC 3161 signers checked against trusted roots ("not checked" without roots). */
  tsa_trust: "checked" | "not checked" | "none";
  problems: AnchorProblem[];
  coverage: AnchorCoverage;
}

export interface AnchorVerifyOptions {
  /** Trusted TSA roots. Without them, a token's signer isn't checked against any authority. */
  roots?: X509Certificate[];
  /** Confirm Bitcoin attestations against a block explorer. */
  network?: BitcoinLookup;
}

const LATE_MS = 48 * 3_600_000;

async function hashesAt(db: Reader, chain: "ledger" | "audit", seqs: number[]) {
  const out = new Map<number, string>();
  const want = [...new Set(seqs.filter((s) => s > 0))];
  for (let i = 0; i < want.length; i += 500) {
    const part = want.slice(i, i + 500);
    const rows =
      chain === "ledger"
        ? await db
            .select({ seq: org.journalEntries.chainSeq, hash: org.journalEntries.entryHash })
            .from(org.journalEntries)
            .where(inArray(org.journalEntries.chainSeq, part))
            .all()
        : await db
            .select({ seq: org.auditLog.seq, hash: org.auditLog.hash })
            .from(org.auditLog)
            .where(inArray(org.auditLog.seq, part))
            .all();
    for (const r of rows) if (r.seq != null && r.hash) out.set(r.seq, r.hash);
  }
  return out;
}

/** Check every stored anchor against the chains and its own proof, and summarise coverage. */
export async function verifyAnchors(
  db: Reader,
  orgId: string,
  opts: AnchorVerifyOptions = {},
): Promise<AnchorVerifyResult> {
  const rows = await db.select().from(org.chainAnchors).orderBy(asc(org.chainAnchors.ledgerSeq)).all();
  const live = rows.filter((r) => r.status !== "failed");
  const ledgerHashes = await hashesAt(
    db,
    "ledger",
    live.map((r) => r.ledgerSeq),
  );
  const auditHashes = await hashesAt(
    db,
    "audit",
    live.map((r) => r.auditSeq),
  );
  const lgen = ledgerGenesis(orgId);
  const agen = auditGenesis(orgId);

  const problems: AnchorProblem[] = [];
  const blocks = new Map<number, Promise<BlockInfo>>();
  let bitcoinChecked = 0;
  let bitcoinSkipped = 0;
  let tsaCount = 0;
  const good: { ledgerSeq: number; at: string }[] = [];

  for (const r of live) {
    const fail = (problem: string) =>
      problems.push({
        id: r.id,
        kind: r.kind,
        service: r.service,
        ledger_seq: r.ledgerSeq,
        audit_seq: r.auditSeq,
        problem,
      });
    const ledgerNow = r.ledgerSeq === 0 ? lgen : (ledgerHashes.get(r.ledgerSeq) ?? null);
    const auditNow = r.auditSeq === 0 ? agen : (auditHashes.get(r.auditSeq) ?? null);
    if (ledgerNow !== r.ledgerHash) {
      fail(
        `ledger link #${r.ledgerSeq} ${ledgerNow ? "has a different hash" : "is missing"} since it was timestamped`,
      );
      continue;
    }
    if (auditNow !== r.auditHash) {
      fail(
        `audit link #${r.auditSeq} ${auditNow ? "has a different hash" : "is missing"} since it was timestamped`,
      );
      continue;
    }
    let digest: string;
    try {
      digest = anchorDigest(
        orgId,
        { seq: r.ledgerSeq, hash: r.ledgerHash },
        { seq: r.auditSeq, hash: r.auditHash },
      );
    } catch (e) {
      fail(`the stored heads are malformed: ${(e as Error).message}`);
      continue;
    }
    if (digest !== r.digest) {
      fail("the stored digest isn't the digest of the stored heads");
      continue;
    }
    if (!r.proof) {
      fail("the proof is missing");
      continue;
    }
    const proof = new Uint8Array(Buffer.from(r.proof, "base64"));
    try {
      if (r.kind === "rfc3161") {
        tsaCount++;
        if (r.status !== "complete") throw new ProofError("an RFC 3161 token is never pending");
        const v = tsaVerify(proof, digest, { roots: opts.roots });
        if (v.trusted === false)
          throw new ProofError(
            "the token's signer doesn't chain to a trusted root (FreeTSA's, or one in anchoring.tsa_ca_file)",
          );
        if (v.genTime !== r.attestedAt)
          throw new ProofError("the stored time differs from the token's genTime");
        good.push({ ledgerSeq: r.ledgerSeq, at: v.genTime });
        continue;
      }
      const replay = otsReplay(proof);
      if (replay.digest !== digest) throw new ProofError("the proof doesn't commit to the digest");
      if (r.status === "pending") continue;
      const att = replay.attestations.find((a) => a.kind === "bitcoin" && a.height === r.blockHeight);
      if (att?.kind !== "bitcoin" || !r.attestedAt)
        throw new ProofError("the proof has no Bitcoin attestation at the stored block height");
      if (opts.network) {
        let block: BlockInfo | null = null;
        try {
          if (!blocks.has(att.height)) blocks.set(att.height, lookupBlock(opts.network, att.height));
          block = await blocks.get(att.height)!;
        } catch {
          bitcoinSkipped++;
        }
        if (block) {
          if (block.merkleRoot !== att.merkleRoot)
            throw new ProofError(`the proof doesn't match Bitcoin block ${att.height}'s merkle root`);
          if (block.time !== r.attestedAt)
            throw new ProofError(`the stored time differs from Bitcoin block ${att.height}'s time`);
          bitcoinChecked++;
        }
      } else bitcoinSkipped++;
      good.push({ ledgerSeq: r.ledgerSeq, at: r.attestedAt });
    } catch (e) {
      if (!(e instanceof ProofError)) throw e;
      fail(e.message);
    }
  }

  const complete = rows.filter((r) => r.status === "complete").length;
  const otsComplete = rows.filter((r) => r.status === "complete" && r.kind === "ots").length;
  return {
    ok: problems.length === 0,
    checked: live.length,
    complete,
    pending: rows.filter((r) => r.status === "pending").length,
    failed: rows.length - live.length,
    bitcoin: !otsComplete
      ? "none"
      : !opts.network
        ? "not checked"
        : bitcoinSkipped
          ? "unavailable"
          : bitcoinChecked
            ? "checked"
            : "none",
    tsa_trust: !tsaCount ? "none" : opts.roots ? "checked" : "not checked",
    problems,
    coverage: await coverage(db, good),
  };
}

/**
 * How much of the ledger the good proofs cover. For each entry, the first covering proof is the
 * earliest-attested proof whose ledger seq is at or after the entry's.
 */
async function coverage(db: Reader, good: { ledgerSeq: number; at: string }[]): Promise<AnchorCoverage> {
  const head = await db
    .select({ seq: org.journalEntries.chainSeq })
    .from(org.journalEntries)
    .where(isNotNull(org.journalEntries.chainSeq))
    .orderBy(desc(org.journalEntries.chainSeq))
    .limit(1)
    .get();
  const headSeq = head?.seq ?? 0;
  if (!good.length)
    return { anchored_through: null, earliest_anchor_at: null, unanchored_links: headSeq, late_entries: 0 };

  // Suffix minimum of attestation times by ledger seq: firstAt[i] covers every seq <= seqs[i].
  const bySeq = new Map<number, number>();
  for (const g of good) {
    const t = Date.parse(g.at);
    bySeq.set(g.ledgerSeq, Math.min(bySeq.get(g.ledgerSeq) ?? t, t));
  }
  const seqs = [...bySeq.keys()].sort((a, b) => a - b);
  const firstAt = seqs.map((s) => bySeq.get(s)!);
  for (let i = firstAt.length - 2; i >= 0; i--) firstAt[i] = Math.min(firstAt[i]!, firstAt[i + 1]!);
  const through = seqs[seqs.length - 1]!;

  const entries = await db
    .select({ seq: org.journalEntries.chainSeq, postedAt: org.journalEntries.postedAt })
    .from(org.journalEntries)
    .where(and(isNotNull(org.journalEntries.chainSeq), eq(org.journalEntries.status, "posted")))
    .all();
  let late = 0;
  for (const e of entries) {
    if (e.seq == null || e.seq > through || !e.postedAt) continue;
    // First index with seqs[i] >= e.seq.
    let lo = 0;
    let hi = seqs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seqs[mid]! >= e.seq) hi = mid;
      else lo = mid + 1;
    }
    if (firstAt[lo]! - Date.parse(e.postedAt) > LATE_MS) late++;
  }
  return {
    anchored_through: { ledger_seq: through, at: new Date(firstAt[firstAt.length - 1]!).toISOString() },
    earliest_anchor_at: new Date(Math.min(...firstAt)).toISOString(),
    unanchored_links: Math.max(0, headSeq - through),
    late_entries: late,
  };
}
