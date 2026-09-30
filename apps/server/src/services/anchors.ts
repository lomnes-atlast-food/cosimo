/**
 * Public timestamps of the chain heads (SPEC §6.5, #11). Once a day (and on demand, and in the
 * year-end package) the digest of both chain heads (docs/chain-format.md "Anchors") goes to
 * OpenTimestamps calendars, whose proofs complete in Bitcoin a few hours later, and to an RFC 3161
 * timestamp authority, whose signed token is immediate. Only the digest leaves the server; the
 * OpenTimestamps commitment adds a random nonce as the reference client does.
 *
 * Nothing here blocks bookkeeping: HTTP happens outside any org transaction, and failures are
 * recorded on the row and in job_runs. Checking stored anchors is in anchor-verify.ts.
 */
import { randomBytes as cryptoRandomBytes, type X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  anchorDigest,
  anchorPreimage,
  FREETSA_ROOT_PEM,
  otsCombine,
  otsCommitment,
  otsMerge,
  otsNew,
  otsReplay,
  parsePemCertificates,
  tsaRequest,
  tsaVerify,
} from "@cosimo/core";
import { newId, org } from "@cosimo/db";
import { VERSION } from "@cosimo/shared";
import { and, desc, eq } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { AppContext } from "../context.ts";
import { type AnchorVerifyOptions, lookupBlock } from "./anchor-verify.ts";
import { auditHead, ledgerHead, verifyOrg } from "./chain.ts";
import type { OrgHandle } from "./types.ts";

type AnchorRow = typeof org.chainAnchors.$inferSelect;

const TIMEOUT_MS = 20_000;
/** A service that failed for a digest isn't asked again for that digest for this long. */
const RETRY_AFTER_MS = 3 * 3_600_000;
/** A pending OpenTimestamps proof with no Bitcoin attestation after this long is marked failed. */
const PENDING_LIMIT_MS = 7 * 24 * 3_600_000;
const MAX_CALENDAR_RESPONSE = 10_000;
const MAX_TSA_RESPONSE = 64_000;
const OTS_ACCEPT = "application/vnd.opentimestamps.v1";

export interface AnchorDeps {
  fetch: typeof fetch;
  now: () => Date;
  randomBytes: (n: number) => Uint8Array;
}

/** Real network by default; tests put a fake in `ctx.services.anchorFetch`. */
export function anchorDeps(ctx: AppContext): AnchorDeps {
  return {
    fetch: (ctx.services.anchorFetch as typeof fetch | undefined) ?? fetch,
    now: () => new Date(),
    randomBytes: (n) => new Uint8Array(cryptoRandomBytes(n)),
  };
}

export function otsCalendars(cfg: Config): string[] {
  return cfg.anchoring.ots_calendars
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/** FreeTSA's root plus any in `anchoring.tsa_ca_file`. */
export function tsaRoots(cfg: Config): X509Certificate[] {
  const roots = parsePemCertificates(FREETSA_ROOT_PEM);
  const file = cfg.anchoring.tsa_ca_file;
  if (file) {
    let pem: string;
    try {
      pem = readFileSync(file, "utf8");
    } catch (e) {
      throw new Error(`anchoring.tsa_ca_file can't be read: ${(e as Error).message}`);
    }
    const extra = parsePemCertificates(pem);
    if (!extra.length) throw new Error(`anchoring.tsa_ca_file (${file}) holds no PEM certificates`);
    roots.push(...extra);
  }
  return roots;
}

/** What `verifyOrg` needs to check anchors fully: trusted roots, and the explorer when `network`. */
export function anchorVerifyOptions(
  ctx: AppContext,
  opts: { network?: boolean; deps?: AnchorDeps } = {},
): AnchorVerifyOptions {
  const deps = opts.deps ?? anchorDeps(ctx);
  return {
    roots: tsaRoots(ctx.config),
    network:
      opts.network && ctx.config.anchoring.bitcoin_api
        ? { fetch: deps.fetch, api: ctx.config.anchoring.bitcoin_api }
        : undefined,
  };
}

async function readLimited(res: Response, max: number): Promise<Uint8Array> {
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > max) throw new Error(`response too large (${buf.length} bytes)`);
  return buf;
}

function httpError(res: Response, body: Uint8Array) {
  const text = new TextDecoder()
    .decode(body.subarray(0, 160))
    .replace(/[^\x20-\x7e]/g, "_")
    .trim();
  return new Error(`HTTP ${res.status}${text ? `: ${text}` : ""}`);
}

const errText = (e: unknown) =>
  (e as Error)?.name === "TimeoutError" ? "timed out" : String((e as Error)?.message ?? e).slice(0, 500);

export interface AnchorNowResult {
  status: "anchored" | "partial" | "failed" | "unchanged" | "waiting" | "broken" | "disabled";
  message: string;
  digest: string | null;
  ledger_seq: number;
  audit_seq: number;
  created: number;
  errors: string[];
}

type NewRow = typeof org.chainAnchors.$inferInsert;

/**
 * Timestamp the current chain heads with every configured service that doesn't already hold a
 * pending or complete proof of them. Refuses when the tail of either chain doesn't verify, so a
 * broken chain is never timestamped as if it were sound.
 */
export async function anchorNow(
  ctx: AppContext,
  h: OrgHandle,
  orgId: string,
  reason: string,
  deps: AnchorDeps = anchorDeps(ctx),
): Promise<AnchorNowResult> {
  const cfg = ctx.config.anchoring;
  const lh = await ledgerHead(h.db, orgId);
  const ah = await auditHead(h.db, orgId);
  const base = { digest: null, ledger_seq: lh.seq, audit_seq: ah.seq, created: 0, errors: [] as string[] };
  if (!cfg.enabled)
    return { ...base, status: "disabled", message: "Timestamping is off (anchoring.enabled)" };
  const digest = anchorDigest(orgId, lh, ah);
  const calendars = otsCalendars(ctx.config);
  const services = [
    ...calendars.map((url) => ({ kind: "ots" as const, url })),
    ...(cfg.tsa_url ? [{ kind: "rfc3161" as const, url: cfg.tsa_url }] : []),
  ];
  if (!services.length)
    return { ...base, digest, status: "disabled", message: "No calendars or timestamp authority configured" };

  // Skip services that already hold these heads, and back off from ones that just failed on them.
  const existing = await h.db
    .select()
    .from(org.chainAnchors)
    .where(eq(org.chainAnchors.digest, digest))
    .all();
  const now = deps.now();
  const done = (s: { kind: string; url: string }) =>
    existing.some((r) => r.kind === s.kind && r.service === s.url && r.status !== "failed");
  const lastFailure = (s: { kind: string; url: string }) =>
    existing
      .filter((r) => r.kind === s.kind && r.service === s.url && r.status === "failed")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const todo = services.filter((s) => !done(s));
  if (!todo.length)
    return { ...base, digest, status: "unchanged", message: "These chain heads are already timestamped" };
  const due = todo.filter((s) => {
    const f = lastFailure(s);
    return !f || now.getTime() - Date.parse(f.createdAt) >= RETRY_AFTER_MS;
  });
  if (!due.length) {
    const errors = todo.map((s) => `${s.url}: ${lastFailure(s)?.lastError ?? "failed"}`);
    return { ...base, digest, status: "waiting", message: "Waiting to retry after a recent failure", errors };
  }

  // Never timestamp books whose recent history doesn't verify.
  const v = await verifyOrg(h.db, orgId, { tail: 1000, anchors: anchorVerifyOptions(ctx, { deps }) });
  if (!v.ok) {
    const b = v.firstBreak;
    const problem = b
      ? `${b.chain} seq ${b.seq}: ${b.reason}`
      : v.anchors.problems[0]
        ? `anchor for ledger #${v.anchors.problems[0].ledger_seq}: ${v.anchors.problems[0].problem}`
        : "checkpoint mismatch";
    return {
      ...base,
      digest,
      status: "broken",
      message: `Not timestamped: the books don't verify (${problem})`,
      errors: [problem],
    };
  }

  const heads = {
    ledgerSeq: lh.seq,
    ledgerHash: lh.hash,
    auditSeq: ah.seq,
    auditHash: ah.hash,
    digest,
    reason,
  };
  const rows: NewRow[] = await Promise.all(
    due.map(async (s): Promise<NewRow> => {
      const row = { id: newId(), kind: s.kind, service: s.url, ...heads, attempts: 1 };
      try {
        return s.kind === "ots"
          ? { ...row, status: "pending", proof: await submitOts(deps, s.url, digest) }
          : { ...row, status: "complete", ...(await requestTsa(deps, s.url, digest, tsaRoots(ctx.config))) };
      } catch (e) {
        return { ...row, status: "failed", proof: null, lastError: errText(e) };
      }
    }),
  );
  const stamp = now.toISOString();
  await h.write(async (tx) => {
    for (const r of rows)
      await tx.insert(org.chainAnchors).values({ ...r, createdAt: stamp, updatedAt: stamp });
  });

  const failed = rows.filter((r) => r.status === "failed");
  const status = !failed.length ? "anchored" : failed.length === rows.length ? "failed" : "partial";
  return {
    ...base,
    digest,
    created: rows.length,
    errors: failed.map((r) => `${r.service}: ${r.lastError}`),
    status,
    message:
      status === "anchored"
        ? `Timestamped ledger #${lh.seq}, audit #${ah.seq} with ${rows.length} service(s)`
        : status === "failed"
          ? "Timestamping failed"
          : `Timestamped with ${rows.length - failed.length} of ${rows.length} service(s)`,
  };
}

async function submitOts(deps: AnchorDeps, calendar: string, digest: string): Promise<string> {
  const nonce = deps.randomBytes(16);
  const res = await deps.fetch(`${calendar}/digest`, {
    method: "POST",
    body: new Uint8Array(otsCommitment(digest, nonce)),
    headers: { accept: OTS_ACCEPT, "user-agent": `cosimo/${VERSION}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await readLimited(res, MAX_CALENDAR_RESPONSE);
  if (res.status !== 200) throw httpError(res, body);
  const proof = otsNew(digest, nonce, body);
  if (!otsReplay(proof).attestations.length) throw new Error("the calendar's response has no attestation");
  return Buffer.from(proof).toString("base64");
}

async function requestTsa(deps: AnchorDeps, url: string, digest: string, roots: X509Certificate[]) {
  const nonce = BigInt(`0x${Buffer.from(deps.randomBytes(8)).toString("hex")}`);
  const res = await deps.fetch(url, {
    method: "POST",
    body: new Uint8Array(tsaRequest(digest, nonce)),
    headers: { "content-type": "application/timestamp-query", "user-agent": `cosimo/${VERSION}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await readLimited(res, MAX_TSA_RESPONSE);
  if (res.status !== 200) throw httpError(res, body);
  const v = tsaVerify(body, digest, { nonce, roots });
  if (v.trusted === false)
    throw new Error("the token's signer doesn't chain to a trusted root (add it to anchoring.tsa_ca_file)");
  return { proof: Buffer.from(body).toString("base64"), attestedAt: v.genTime };
}

export interface UpgradeResult {
  checked: number;
  completed: number;
  failed: number;
  pending: number;
  errors: string[];
}

/**
 * Ask each pending OpenTimestamps proof's calendar for its Bitcoin attestation. A calendar answers
 * 404 until the commitment is in a block; then the proof is merged, its block's merkle root and
 * time are confirmed with the block explorer, and the row completes. Network problems stay on the
 * row (`last_error`) for the next run.
 */
export async function upgradePending(
  ctx: AppContext,
  h: OrgHandle,
  orgId: string,
  deps: AnchorDeps = anchorDeps(ctx),
): Promise<UpgradeResult> {
  const rows = await h.db
    .select()
    .from(org.chainAnchors)
    .where(and(eq(org.chainAnchors.kind, "ots"), eq(org.chainAnchors.status, "pending")))
    .all();
  const out: UpgradeResult = { checked: rows.length, completed: 0, failed: 0, pending: 0, errors: [] };
  for (const r of rows) {
    const res = await upgradeOne(ctx, r, deps).catch((e) => ({ error: errText(e) }) as const);
    const now = deps.now();
    const stamp = now.toISOString();
    if ("complete" in res) {
      await h.write((tx) =>
        tx
          .update(org.chainAnchors)
          .set({
            status: "complete",
            proof: res.proof,
            blockHeight: res.height,
            attestedAt: res.time,
            attempts: r.attempts + 1,
            lastError: null,
            updatedAt: stamp,
          })
          .where(eq(org.chainAnchors.id, r.id)),
      );
      out.completed++;
      continue;
    }
    const expired = now.getTime() - Date.parse(r.createdAt) > PENDING_LIMIT_MS;
    const error = "error" in res ? res.error : null;
    if (error) out.errors.push(`${r.service}: ${error}`);
    await h.write((tx) =>
      tx
        .update(org.chainAnchors)
        .set({
          status: expired ? "failed" : "pending",
          proof: "proof" in res ? res.proof : r.proof,
          attempts: r.attempts + 1,
          lastError: expired
            ? `no Bitcoin attestation after 7 days${error ? ` (last error: ${error})` : ""}`
            : error,
          updatedAt: stamp,
        })
        .where(eq(org.chainAnchors.id, r.id)),
    );
    if (expired) out.failed++;
    else out.pending++;
  }
  return out;
}

type UpgradeOne =
  | { complete: true; proof: string; height: number; time: string }
  | { pending: true; proof?: string }
  | { error: string; proof?: string };

async function upgradeOne(ctx: AppContext, r: AnchorRow, deps: AnchorDeps): Promise<UpgradeOne> {
  let proof = new Uint8Array(Buffer.from(r.proof ?? "", "base64"));
  let replay = otsReplay(proof);
  if (replay.digest !== r.digest) return { error: "the stored proof doesn't commit to the digest" };
  let merged = false;
  if (!replay.attestations.some((a) => a.kind === "bitcoin")) {
    const pending = replay.attestations.find((a) => a.kind === "pending");
    if (pending?.kind !== "pending") return { error: "the proof has no pending attestation" };
    const res = await deps.fetch(`${r.service}/timestamp/${pending.commitment}`, {
      headers: { accept: OTS_ACCEPT, "user-agent": `cosimo/${VERSION}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await readLimited(res, MAX_CALENDAR_RESPONSE);
    if (res.status === 404) return { pending: true };
    if (res.status !== 200) throw httpError(res, body);
    proof = new Uint8Array(otsMerge(proof, pending.commitment, body));
    replay = otsReplay(proof);
    merged = true;
  }
  const b64 = Buffer.from(proof).toString("base64");
  const att = replay.attestations.find((a) => a.kind === "bitcoin");
  // The calendar may answer with a further pending step; keep what it gave for next time.
  if (att?.kind !== "bitcoin") return merged ? { pending: true, proof: b64 } : { pending: true };
  const api = ctx.config.anchoring.bitcoin_api;
  if (!api) return { error: "anchoring.bitcoin_api is empty, so the block can't be confirmed", proof: b64 };
  let block: Awaited<ReturnType<typeof lookupBlock>>;
  try {
    block = await lookupBlock({ fetch: deps.fetch, api }, att.height);
  } catch (e) {
    return { error: `block explorer: ${errText(e)}`, proof: b64 };
  }
  if (block.merkleRoot !== att.merkleRoot)
    return { error: `the proof doesn't match Bitcoin block ${att.height}'s merkle root`, proof: b64 };
  return { complete: true, proof: b64, height: att.height, time: block.time };
}

// ----------------------------------------------------------------------------- listing and files

export interface AnchorView {
  id: string;
  kind: "ots" | "rfc3161";
  service: string;
  status: "pending" | "complete" | "failed";
  ledger_seq: number;
  ledger_hash: string;
  audit_seq: number;
  audit_hash: string;
  digest: string;
  attested_at: string | null;
  block_height: number | null;
  reason: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export function anchorView(r: AnchorRow): AnchorView {
  return {
    id: r.id,
    kind: r.kind,
    service: r.service,
    status: r.status,
    ledger_seq: r.ledgerSeq,
    ledger_hash: r.ledgerHash,
    audit_seq: r.auditSeq,
    audit_hash: r.auditHash,
    digest: r.digest,
    attested_at: r.attestedAt,
    block_height: r.blockHeight,
    reason: r.reason,
    attempts: r.attempts,
    last_error: r.lastError,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  };
}

export async function listAnchors(h: OrgHandle, limit = 200) {
  return h.db
    .select()
    .from(org.chainAnchors)
    .orderBy(desc(org.chainAnchors.createdAt), desc(org.chainAnchors.id))
    .limit(limit)
    .all();
}

export async function getAnchor(h: OrgHandle, id: string) {
  return (await h.db.select().from(org.chainAnchors).where(eq(org.chainAnchors.id, id)).get()) ?? null;
}

/** The text a proof commits to, from the row's own heads. */
export function anchorPreimageOf(orgId: string, r: AnchorRow): string {
  return anchorPreimage(
    orgId,
    { seq: r.ledgerSeq, hash: r.ledgerHash },
    { seq: r.auditSeq, hash: r.auditHash },
  );
}

/** Download name for a proof: `anchor-<ledger seq>.txt.ots` (what `ots verify` expects) or `.tsr`. */
export function proofFileName(r: AnchorRow): string {
  return r.kind === "ots" ? `anchor-${r.ledgerSeq}.txt.ots` : `anchor-${r.ledgerSeq}.tsr`;
}

/**
 * Files for the year-end package's `anchors/` folder: for each service, its latest pending or
 * complete anchor, plus its latest complete one when that is older (a Bitcoin-confirmed proof
 * alongside the year-end one that may still be pending). Proofs of one digest share a preimage;
 * the calendars' proofs are combined into one `.ots`, as `ots stamp` writes them.
 */
export async function anchorPackageFiles(h: OrgHandle, orgId: string) {
  const rows = await h.db
    .select()
    .from(org.chainAnchors)
    .orderBy(desc(org.chainAnchors.createdAt), desc(org.chainAnchors.id))
    .all();
  const picked = new Map<string, AnchorRow>();
  for (const r of rows) {
    if (r.status === "failed" || !r.proof) continue;
    const key = `${r.kind} ${r.service}`;
    if (!picked.has(`${key} latest`)) picked.set(`${key} latest`, r);
    if (r.status === "complete" && !picked.has(`${key} complete`)) picked.set(`${key} complete`, r);
  }
  const byDigest = new Map<string, AnchorRow[]>();
  for (const r of new Set(picked.values())) byDigest.set(r.digest, [...(byDigest.get(r.digest) ?? []), r]);

  const files: Record<string, Uint8Array> = {};
  const anchors: {
    file: string;
    ledger: { seq: number; hash: string };
    audit: { seq: number; hash: string };
    digest: string;
    proofs: {
      kind: string;
      service: string;
      status: string;
      attested_at: string | null;
      block_height: number | null;
    }[];
  }[] = [];
  const freetsa = parsePemCertificates(FREETSA_ROOT_PEM);
  let tsaCerts: string[] | null = null;
  let fromFreetsa = false;
  const names = new Set<string>();
  for (const [digest, group] of byDigest) {
    const r0 = group[0]!;
    let name = `anchor-${r0.ledgerSeq}`;
    if (names.has(name)) name = `${name}-${digest.slice(0, 8)}`;
    names.add(name);
    files[`anchors/${name}.txt`] = new TextEncoder().encode(anchorPreimageOf(orgId, r0));
    const ots = group.filter((r) => r.kind === "ots");
    if (ots.length)
      files[`anchors/${name}.txt.ots`] = otsCombine(
        ots.map((r) => new Uint8Array(Buffer.from(r.proof!, "base64"))),
      );
    const tsa = group.filter((r) => r.kind === "rfc3161");
    tsa.forEach((r, i) => {
      const bytes = new Uint8Array(Buffer.from(r.proof!, "base64"));
      files[`anchors/${name}${i ? `-${i + 1}` : ""}.tsr`] = bytes;
      if (tsaCerts) return;
      try {
        const v = tsaVerify(bytes, digest, { roots: freetsa });
        tsaCerts = v.certificatesPem.filter((p) => !isSelfSigned(p));
        fromFreetsa = v.trusted === true;
      } catch {
        // verify reports it; the file still goes in
      }
    });
    anchors.push({
      file: `anchors/${name}.txt`,
      ledger: { seq: r0.ledgerSeq, hash: r0.ledgerHash },
      audit: { seq: r0.auditSeq, hash: r0.auditHash },
      digest,
      proofs: group.map((r) => ({
        kind: r.kind,
        service: r.service,
        status: r.status,
        attested_at: r.attestedAt,
        block_height: r.blockHeight,
      })),
    });
  }
  const certs = tsaCerts as string[] | null;
  if (certs?.length) files["anchors/tsa.crt"] = new TextEncoder().encode(certs.join(""));
  if (fromFreetsa) files["anchors/cacert.pem"] = new TextEncoder().encode(FREETSA_ROOT_PEM.trimStart());
  anchors.sort((a, b) => a.ledger.seq - b.ledger.seq || a.audit.seq - b.audit.seq);
  return { files, anchors };
}

function isSelfSigned(pem: string) {
  const [c] = parsePemCertificates(pem);
  return !!c && c.checkIssued(c) && c.verify(c.publicKey);
}
