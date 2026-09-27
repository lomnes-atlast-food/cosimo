/**
 * Tamper-evident hash chains (SPEC §6.5, docs/chain-format.md).
 */
import { canonicalJson } from "./canonical.ts";
import { sha256Hex } from "./hash.ts";

export const CHAIN_FORMAT_VERSION = 1;

export function ledgerGenesis(orgId: string): string {
  return sha256Hex(`cosimo:ledger:genesis:v${CHAIN_FORMAT_VERSION}:${orgId}`);
}

export function auditGenesis(orgId: string): string {
  return sha256Hex(`cosimo:audit:genesis:v${CHAIN_FORMAT_VERSION}:${orgId}`);
}

export interface ChainLine {
  id: string;
  accountId: string;
  amount: number;
  currency: string;
  description: string | null;
  contactId: string | null;
  lineOrder: number;
}

export interface ChainEntry {
  id: string;
  chainSeq: number;
  date: string;
  memo: string | null;
  sourceType: string;
  sourceId: string | null;
  reversesEntryId: string | null;
  createdBy: string | null;
  createdByActor: string;
  postedAt: string;
  postedBy: string | null;
  lockOverrideNote: string | null;
  lines: ChainLine[];
}

export function ledgerPayload(orgId: string, e: ChainEntry) {
  const lines = [...e.lines]
    .sort((a, b) => a.lineOrder - b.lineOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((l) => ({
      account_id: l.accountId,
      amount: l.amount,
      contact_id: l.contactId,
      currency: l.currency,
      description: l.description,
      id: l.id,
      line_order: l.lineOrder,
    }));
  return {
    v: CHAIN_FORMAT_VERSION,
    chain: "ledger",
    org_id: orgId,
    chain_seq: e.chainSeq,
    id: e.id,
    date: e.date,
    memo: e.memo,
    source_type: e.sourceType,
    source_id: e.sourceId,
    reverses_entry_id: e.reversesEntryId,
    created_by: e.createdBy,
    created_by_actor: e.createdByActor,
    posted_at: e.postedAt,
    posted_by: e.postedBy,
    lock_override_note: e.lockOverrideNote,
    lines,
  };
}

export function entryHash(orgId: string, prevHash: string, e: ChainEntry): string {
  return sha256Hex(prevHash + canonicalJson(ledgerPayload(orgId, e)));
}

export interface ChainAuditRow {
  id: string;
  seq: number;
  at: string;
  userId: string | null;
  apiTokenId: string | null;
  oauthClientId: string | null;
  actor: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  beforeJson: string | null;
  afterJson: string | null;
  ip: string | null;
}

export function auditPayload(orgId: string, r: ChainAuditRow) {
  return {
    v: CHAIN_FORMAT_VERSION,
    chain: "audit",
    org_id: orgId,
    seq: r.seq,
    id: r.id,
    at: r.at,
    user_id: r.userId,
    api_token_id: r.apiTokenId,
    oauth_client_id: r.oauthClientId,
    actor: r.actor,
    action: r.action,
    target_type: r.targetType,
    target_id: r.targetId,
    before_json: r.beforeJson,
    after_json: r.afterJson,
    ip: r.ip,
  };
}

export function auditHash(orgId: string, prevHash: string, r: ChainAuditRow): string {
  return sha256Hex(prevHash + canonicalJson(auditPayload(orgId, r)));
}

export interface ChainBreak {
  chain: "ledger" | "audit";
  seq: number;
  id: string | null;
  reason: string;
}

export interface VerifyResult {
  chain: "ledger" | "audit";
  ok: boolean;
  checked: number;
  headSeq: number;
  headHash: string;
  firstBreak: ChainBreak | null;
}

/**
 * Verify a chain given rows in ascending seq order. `startSeq`/`startPrev` let the caller verify
 * only the tail of the chain (doctor's fast check).
 */
export function verifyChain<R extends { seq: number; id: string; prevHash: string; hash: string }>(
  chain: "ledger" | "audit",
  rows: Iterable<R>,
  compute: (prevHash: string, row: R) => string,
  genesis: string,
  start: { seq: number; prevHash: string } = { seq: 1, prevHash: genesis },
): VerifyResult {
  let expectedSeq = start.seq;
  let prev = start.prevHash;
  let checked = 0;
  for (const r of rows) {
    const fail = (reason: string): VerifyResult => ({
      chain,
      ok: false,
      checked,
      headSeq: expectedSeq - 1,
      headHash: prev,
      firstBreak: { chain, seq: r.seq, id: r.id, reason },
    });
    if (r.seq !== expectedSeq) return fail(`expected seq ${expectedSeq}, found ${r.seq} (gap or insertion)`);
    if (r.prevHash !== prev) return fail("prev_hash does not match the previous link's hash");
    const h = compute(prev, r);
    if (h !== r.hash) return fail("stored hash does not match recomputed hash (record altered)");
    prev = r.hash;
    expectedSeq++;
    checked++;
  }
  return { chain, ok: true, checked, headSeq: expectedSeq - 1, headHash: prev, firstBreak: null };
}
