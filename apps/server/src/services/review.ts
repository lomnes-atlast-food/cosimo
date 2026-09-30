/**
 * Review queue (SPEC §7.5). Items hold proposed changes until a person decides. Entry-based items
 * (journal entries, bank categorizations) are built in; later modules register handlers for their
 * own item types (rules proposed by MCP, invoice drafts, import batches).
 */
import { newId, type OrgDb, type OrgTx, org } from "@cosimo/db";
import { and, asc, count, desc, eq, inArray, lt, type SQL } from "drizzle-orm";
import { conflict, forbidden, notFound, unprocessable } from "../http/errors.ts";
import type { ActorInfo } from "./actor.ts";
import { appendAudit } from "./audit.ts";
import { type EntryInput, getEntry, postEntryTx, rejectEntryTx, updateDraftTx } from "./ledger.ts";

type Reader = OrgDb | OrgTx;
export type ReviewRow = typeof org.reviewItems.$inferSelect;
export type ReviewItemType = ReviewRow["itemType"];

export const REVIEW_EXPIRY_DAYS = 30;

export interface ApproveInput {
  note?: string | null;
  lock_override_note?: string | null;
  /** Edit and approve: replace the proposal before approving. Both versions are kept. */
  edit?: Partial<Pick<EntryInput, "date" | "memo" | "lines">> | null;
}

export interface ReviewHandler {
  approve(tx: OrgTx, orgId: string, a: ActorInfo, item: ReviewRow, input: ApproveInput): Promise<unknown>;
  reject(tx: OrgTx, orgId: string, a: ActorInfo, item: ReviewRow, note: string | null): Promise<void>;
}

const handlers = new Map<ReviewItemType, ReviewHandler>();

export function registerReviewHandler(type: ReviewItemType, h: ReviewHandler) {
  handlers.set(type, h);
}

export interface ReviewView {
  id: string;
  item_type: ReviewItemType;
  item_id: string;
  proposed_by_actor: string;
  proposed_by_id: string | null;
  reason: string;
  rationale: string | null;
  payload: unknown;
  original_payload: unknown;
  edited: boolean;
  amount: number | null;
  status: ReviewRow["status"];
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}

export function reviewView(r: ReviewRow): ReviewView {
  return {
    id: r.id,
    item_type: r.itemType,
    item_id: r.itemId,
    proposed_by_actor: r.proposedByActor,
    proposed_by_id: r.proposedById,
    reason: r.reason,
    rationale: r.rationale,
    payload: r.payloadJson ? JSON.parse(r.payloadJson) : null,
    original_payload: r.originalPayloadJson ? JSON.parse(r.originalPayloadJson) : null,
    edited: Boolean(r.originalPayloadJson && r.payloadJson !== r.originalPayloadJson),
    amount: r.amount,
    status: r.status,
    decided_by: r.decidedBy,
    decided_at: r.decidedAt,
    decision_note: r.decisionNote,
    created_at: r.createdAt,
  };
}

export async function mustGetReview(db: Reader, id: string) {
  const r = await db.select().from(org.reviewItems).where(eq(org.reviewItems.id, id)).get();
  if (!r) throw notFound("Review item");
  return r;
}

export async function listReview(
  db: Reader,
  f: { status?: ReviewRow["status"][]; itemType?: ReviewItemType[]; limit?: number; cursor?: string | null },
) {
  const conds: SQL[] = [];
  if (f.status?.length) conds.push(inArray(org.reviewItems.status, f.status));
  if (f.itemType?.length) conds.push(inArray(org.reviewItems.itemType, f.itemType));
  if (f.cursor) conds.push(lt(org.reviewItems.id, f.cursor));
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
  const pendingFirst = f.status?.length === 1 && f.status[0] === "pending";
  const rows = await db
    .select()
    .from(org.reviewItems)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(
      pendingFirst ? asc(org.reviewItems.createdAt) : desc(org.reviewItems.createdAt),
      desc(org.reviewItems.id),
    )
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  return {
    data: page.map(reviewView),
    next_cursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function pendingCount(db: Reader) {
  const r = await db
    .select({ n: count() })
    .from(org.reviewItems)
    .where(eq(org.reviewItems.status, "pending"))
    .get();
  return r?.n ?? 0;
}

function assertCanDecide(a: ActorInfo) {
  if (a.actor === "mcp")
    throw forbidden("AI assistants can propose changes but cannot approve or reject them.");
  if (a.proposeOnly) throw forbidden("This token can only propose changes.");
  if (a.role !== "owner" && a.role !== "bookkeeper")
    throw forbidden("Your role is read-only in this organization.");
}

export async function finishReviewTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  item: ReviewRow,
  status: "approved" | "rejected",
  note: string | null,
  payload?: unknown,
) {
  const decidedAt = new Date().toISOString();
  await tx
    .update(org.reviewItems)
    .set({
      status,
      decidedBy: a.userId ?? a.apiTokenId ?? null,
      decidedAt,
      decisionNote: note,
      ...(payload !== undefined ? { payloadJson: JSON.stringify(payload) } : {}),
    })
    .where(eq(org.reviewItems.id, item.id));
  await appendAudit(tx, orgId, a, {
    action: status === "approved" ? "review.approve" : "review.reject",
    targetType: "review_item",
    targetId: item.id,
    after: {
      item_type: item.itemType,
      item_id: item.itemId,
      proposed_by_actor: item.proposedByActor,
      note,
      edited: payload !== undefined,
    },
  });
}

export async function approveReviewTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  id: string,
  input: ApproveInput = {},
) {
  assertCanDecide(a);
  const item = await mustGetReview(tx, id);
  if (item.status !== "pending") throw conflict(`This item is ${item.status}.`, "invalid_state");
  const h = handlers.get(item.itemType);
  if (!h) throw unprocessable(`Items of type ${item.itemType} cannot be approved yet.`, "unsupported");
  const result = await h.approve(tx, orgId, a, item, input);
  return { item: reviewView(await mustGetReview(tx, id)), result };
}

export async function rejectReviewTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  id: string,
  note: string | null,
) {
  assertCanDecide(a);
  const item = await mustGetReview(tx, id);
  if (item.status !== "pending" && item.status !== "expired")
    throw conflict(`This item is ${item.status}.`, "invalid_state");
  const h = handlers.get(item.itemType);
  if (!h) throw unprocessable(`Items of type ${item.itemType} cannot be rejected yet.`, "unsupported");
  await h.reject(tx, orgId, a, item, note);
  return reviewView(await mustGetReview(tx, id));
}

/** Items pending longer than 30 days expire and are listed for cleanup; they can no longer be approved. */
export async function expireOldTx(tx: OrgTx, orgId: string, now = new Date()) {
  const cutoff = new Date(now.getTime() - REVIEW_EXPIRY_DAYS * 86_400_000).toISOString();
  const rows = await tx
    .select({ id: org.reviewItems.id })
    .from(org.reviewItems)
    .where(and(eq(org.reviewItems.status, "pending"), lt(org.reviewItems.createdAt, cutoff)))
    .all();
  if (!rows.length) return 0;
  await tx
    .update(org.reviewItems)
    .set({ status: "expired" })
    .where(
      inArray(
        org.reviewItems.id,
        rows.map((r) => r.id),
      ),
    );
  await appendAudit(
    tx,
    orgId,
    { actor: "system", role: "owner", userId: null },
    {
      action: "review.expire",
      targetType: "review_item",
      after: { ids: rows.map((r) => r.id) },
    },
  );
  return rows.length;
}

// ----------------------------------------------------------------------------- entry-based items

async function linkedBankTxns(tx: OrgTx, entryId: string) {
  return tx.select().from(org.bankTransactions).where(eq(org.bankTransactions.matchedEntryId, entryId)).all();
}

const entryHandler: ReviewHandler = {
  async approve(tx, orgId, a, item, input) {
    const entryId = item.itemId;
    const before = await getEntry(tx, entryId);
    if (!before) throw notFound("Journal entry");
    if (before.status !== "pending_review") throw conflict(`The entry is ${before.status}.`, "invalid_state");
    let payload: unknown;
    if (input.edit && (input.edit.lines || input.edit.date || input.edit.memo !== undefined)) {
      const bankTxns = await linkedBankTxns(tx, entryId);
      const edited = await updateDraftTx(tx, orgId, a, entryId, input.edit, { allowPending: true });
      // A bank categorization must still move the bank's ledger account by the transaction amount.
      for (const t of bankTxns) {
        const bank = await tx
          .select()
          .from(org.bankAccounts)
          .where(eq(org.bankAccounts.id, t.bankAccountId))
          .get();
        const onBank = edited.lines
          .filter((l) => l.account_id === bank?.ledgerAccountId)
          .reduce((s, l) => s + l.amount, 0);
        if (onBank !== t.amount) {
          throw unprocessable(
            "The edited entry must keep the bank account line equal to the transaction amount.",
            "bank_line_changed",
          );
        }
      }
      const orig = item.payloadJson ? JSON.parse(item.payloadJson) : {};
      payload = { ...orig, entry: edited };
    }
    const posted = await postEntryTx(tx, orgId, entryId, a, input.lock_override_note ?? null);
    await tx
      .update(org.bankTransactions)
      .set({ status: "categorized", reviewItemId: null })
      .where(eq(org.bankTransactions.matchedEntryId, entryId));
    await finishReviewTx(tx, orgId, a, item, "approved", input.note ?? null, payload);
    return posted;
  },
  async reject(tx, orgId, a, item, note) {
    const e = await getEntry(tx, item.itemId);
    if (e && (e.status === "pending_review" || e.status === "draft"))
      await rejectEntryTx(tx, orgId, a, e.id, note);
    await tx
      .update(org.bankTransactions)
      .set({ status: "new", matchedEntryId: null, reviewItemId: null })
      .where(eq(org.bankTransactions.matchedEntryId, item.itemId));
    // A rejected payout transfer leaves the payout to match again.
    await tx
      .update(org.providerPayouts)
      .set({ bankTxnId: null, entryId: null })
      .where(eq(org.providerPayouts.entryId, item.itemId));
    await finishReviewTx(tx, orgId, a, item, "rejected", note);
  },
};

registerReviewHandler("journal_entry", entryHandler);
registerReviewHandler("bank_categorization", entryHandler);

// ----------------------------------------------------------------------------- review policy

export type PolicyRow = typeof org.reviewPolicy.$inferSelect;

export function policyView(p: PolicyRow) {
  return {
    id: p.id,
    name: p.name,
    actor: p.actor,
    condition: JSON.parse(p.conditionJson || "{}") as Record<string, unknown>,
    action: p.action,
    priority: p.priority,
  };
}

export async function savePolicyTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  input: {
    id?: string;
    name?: string | null;
    actor: string;
    condition: Record<string, unknown>;
    action: PolicyRow["action"];
    priority: number;
  },
) {
  const before = input.id
    ? await tx.select().from(org.reviewPolicy).where(eq(org.reviewPolicy.id, input.id)).get()
    : undefined;
  if (input.id && !before) throw notFound("Review policy");
  const row = {
    id: input.id ?? newId(),
    name: input.name ?? null,
    actor: input.actor,
    conditionJson: JSON.stringify(input.condition),
    action: input.action,
    priority: input.priority,
  };
  if (before) await tx.update(org.reviewPolicy).set(row).where(eq(org.reviewPolicy.id, row.id));
  else await tx.insert(org.reviewPolicy).values(row);
  await appendAudit(tx, orgId, a, {
    action: before ? "review_policy.update" : "review_policy.create",
    targetType: "review_policy",
    targetId: row.id,
    before: before ? policyView(before) : null,
    after: policyView(row as PolicyRow),
  });
  return policyView(row as PolicyRow);
}

export async function deletePolicyTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string) {
  const before = await tx.select().from(org.reviewPolicy).where(eq(org.reviewPolicy.id, id)).get();
  if (!before) throw notFound("Review policy");
  await tx.delete(org.reviewPolicy).where(eq(org.reviewPolicy.id, id));
  await appendAudit(tx, orgId, a, {
    action: "review_policy.delete",
    targetType: "review_policy",
    targetId: id,
    before: policyView(before),
  });
}
