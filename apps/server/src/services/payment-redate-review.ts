/**
 * Payment date changes proposed by AI assistants (SPEC §8, §10.2), for a payment recorded on a
 * different date than the bank shows. One `payment_redate` review item; nothing changes while it
 * waits. Applying it reverses the payment's entry on its original date (so that period nets to
 * zero), posts the same lines on the new date, and moves the payment, its applications, and any
 * matched bank transaction over to the new entry. Rejecting changes nothing.
 */
import { decide } from "@cosimo/core";
import { newId, type OrgTx, org } from "@cosimo/db";
import type { SourceType } from "@cosimo/shared";
import { and, eq, inArray } from "drizzle-orm";
import { conflict, unprocessable } from "../http/errors.ts";
import type { ActorInfo } from "./actor.ts";
import { appendAudit } from "./audit.ts";
import { type DocType, mustGetPayment, paymentView, recomputeDocTx } from "./documents.ts";
import {
  assertReversible,
  getEntry,
  policyRules,
  reverseEntryTx,
  settingsRow,
  submitEntryTx,
} from "./ledger.ts";
import { finishReviewTx, registerReviewHandler } from "./review.ts";

/** The payment's posted entry, or a conflict explaining why its date can't change. */
async function redatableEntry(tx: OrgTx, paymentId: string, toDate: string) {
  const p = await mustGetPayment(tx, paymentId);
  if (p.voidedAt) throw conflict("This payment is void.", "invalid_state");
  const e = p.entryId ? await getEntry(tx, p.entryId) : null;
  if (e?.status !== "posted")
    throw conflict("This payment's entry is not posted yet, so its date can't change.", "invalid_state");
  if (e.reversed_by_entry_id)
    throw conflict("This payment's entry has already been reversed.", "already_reversed");
  await assertReversible(tx, e.id, null);
  if (await inCompletedReconciliation(tx, e.id))
    throw conflict(
      "This payment is part of a completed bank reconciliation. A person must undo the reconciliation before its date can change.",
      "reconciled",
    );
  if (p.date === toDate) throw unprocessable(`The payment is already dated ${toDate}.`, "same_date");
  return { p, e };
}

/** Whether any line of this entry was cleared in a completed reconciliation. */
async function inCompletedReconciliation(tx: OrgTx, entryId: string) {
  const lineIds = (
    await tx
      .select({ id: org.journalLines.id })
      .from(org.journalLines)
      .where(eq(org.journalLines.entryId, entryId))
      .all()
  ).map((l) => l.id);
  if (!lineIds.length) return false;
  const hit = await tx
    .select({ id: org.reconciliations.id })
    .from(org.reconciliationItems)
    .innerJoin(org.reconciliations, eq(org.reconciliations.id, org.reconciliationItems.reconciliationId))
    .where(
      and(
        inArray(org.reconciliationItems.journalLineId, lineIds),
        eq(org.reconciliations.status, "completed"),
      ),
    )
    .get();
  return Boolean(hit);
}

async function assertNoPendingRedate(tx: OrgTx, paymentId: string) {
  const pending = await tx
    .select({ id: org.reviewItems.id })
    .from(org.reviewItems)
    .where(
      and(
        eq(org.reviewItems.itemType, "payment_redate"),
        eq(org.reviewItems.itemId, paymentId),
        eq(org.reviewItems.status, "pending"),
      ),
    )
    .get();
  if (pending)
    throw conflict(
      `A date change for this payment is already waiting for review (${pending.id}).`,
      "already_pending",
    );
}

/**
 * Propose moving a payment to a new date. Returns the review item ID, or, when a review policy
 * auto-approves it, the applied change.
 */
export async function proposePaymentRedateTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  paymentId: string,
  toDate: string,
  rationale: string | null,
) {
  const { p } = await redatableEntry(tx, paymentId, toDate);
  await assertNoPendingRedate(tx, paymentId);
  const s = await settingsRow(tx);
  const decision = decide(
    { actor: a.actor, itemType: "payment_redate", amount: p.amount, proposeOnly: a.proposeOnly },
    await policyRules(tx),
    s.reviewThreshold,
  );
  if (decision.action === "auto_approve") {
    const applied = await applyPaymentRedateTx(tx, orgId, a, paymentId, toDate, {});
    return { reviewItemId: null, ...applied };
  }
  const id = newId();
  const payload = JSON.stringify({ payment: await paymentView(tx, p), from_date: p.date, to_date: toDate });
  await tx.insert(org.reviewItems).values({
    id,
    itemType: "payment_redate",
    itemId: paymentId,
    proposedByActor: a.actor,
    proposedById: a.userId ?? a.apiTokenId ?? a.oauthClientId ?? null,
    reason: decision.reason,
    rationale,
    payloadJson: payload,
    originalPayloadJson: payload,
    amount: p.amount,
  });
  await appendAudit(tx, orgId, a, {
    action: "payment.propose_redate",
    targetType: "payment",
    targetId: paymentId,
    after: { review_item_id: id, reason: decision.reason, rationale, from_date: p.date, to_date: toDate },
  });
  return { reviewItemId: id, reversal: null, entry: null };
}

/**
 * Move a posted payment to `toDate`: reverse its entry on the original date, post the same lines on
 * the new date, and repoint the payment, its applications, and matched bank transactions.
 */
export async function applyPaymentRedateTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  paymentId: string,
  toDate: string,
  opts: { lockOverrideNote?: string | null },
) {
  const { p, e: old } = await redatableEntry(tx, paymentId, toDate);
  const fromDate = p.date;
  const lockOverrideNote = opts.lockOverrideNote ?? null;
  const reversal = await reverseEntryTx(
    tx,
    orgId,
    a,
    old.id,
    {
      allowDocument: true,
      date: old.date,
      memo: `Redate ${old.memo ?? "payment"} to ${toDate}`,
      lockOverrideNote,
    },
    { forcePost: true },
  );
  // The posted-entry hook only fills payments.entry_id when it is empty, so the payment is
  // repointed explicitly below.
  const next = await submitEntryTx(
    tx,
    orgId,
    a,
    {
      date: toDate,
      memo: old.memo,
      lines: old.lines.map((l) => ({
        accountId: l.account_id,
        amount: l.amount,
        description: l.description,
        contactId: l.contact_id,
      })),
      sourceType: old.source_type as SourceType,
      sourceId: p.id,
      lockOverrideNote,
    },
    { forcePost: true },
  );
  await tx
    .update(org.payments)
    .set({ date: toDate, entryId: next.entry.id })
    .where(eq(org.payments.id, p.id));
  // Applications made with the payment move with it; one made later keeps its own date unless the
  // payment now comes after it.
  const apps = await tx
    .select()
    .from(org.paymentApplications)
    .where(eq(org.paymentApplications.paymentId, p.id))
    .all();
  for (const x of apps) {
    const moves = !x.appliedDate || x.appliedDate === fromDate || x.appliedDate < toDate;
    if (!moves) continue;
    await tx
      .update(org.paymentApplications)
      .set({ appliedDate: toDate })
      .where(
        and(
          eq(org.paymentApplications.paymentId, p.id),
          eq(org.paymentApplications.documentType, x.documentType),
          eq(org.paymentApplications.documentId, x.documentId),
        ),
      );
  }
  // A bank transaction matched to the payment stays matched, now to the new entry.
  await tx
    .update(org.bankTransactions)
    .set({ matchedEntryId: next.entry.id })
    .where(eq(org.bankTransactions.matchedEntryId, old.id));
  const type: DocType = p.direction === "received" ? "invoice" : "bill";
  for (const x of apps) await recomputeDocTx(tx, type, x.documentId);
  await appendAudit(tx, orgId, a, {
    action: "payment.redate",
    targetType: "payment",
    targetId: p.id,
    before: { date: fromDate, entry_id: old.id },
    after: { date: toDate, entry_id: next.entry.id, reversal_entry_id: reversal.entry.id },
  });
  return { reversal, entry: next.entry };
}

registerReviewHandler("payment_redate", {
  async approve(tx, orgId, a, item, input) {
    const { to_date } = JSON.parse(item.payloadJson ?? "{}") as { to_date: string };
    const result = await applyPaymentRedateTx(tx, orgId, a, item.itemId, to_date, {
      lockOverrideNote: input.lock_override_note ?? null,
    });
    await finishReviewTx(tx, orgId, a, item, "approved", input.note ?? null);
    return result;
  },
  async reject(tx, orgId, a, item, note) {
    // Nothing changed while the proposal waited.
    await finishReviewTx(tx, orgId, a, item, "rejected", note);
  },
});
