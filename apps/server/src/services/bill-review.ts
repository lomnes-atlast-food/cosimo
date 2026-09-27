/**
 * Bill drafts proposed by AI assistants (SPEC §7.5, §10.2). The draft exists as a normal draft bill
 * (no ledger effect) plus a `bill_draft` review item. Approving finalizes it, which posts the
 * payable. Rejecting deletes the draft; the review item keeps a snapshot of what was proposed.
 */
import { decide } from "@cosimo/core";
import { newId, type OrgTx, org } from "@cosimo/db";
import { eq } from "drizzle-orm";
import type { ActorInfo } from "./actor.ts";
import { appendAudit } from "./audit.ts";
import { billView, deleteBillDraftTx, finalizeBillTx, mustGetBill } from "./documents.ts";
import { policyRules, settingsRow } from "./ledger.ts";
import { finishReviewTx, registerReviewHandler } from "./review.ts";

/** Hold a new draft for review unless a review policy auto-approves it. Returns the review item ID. */
export async function holdBillDraftTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  billId: string,
  rationale: string | null,
): Promise<string | null> {
  const bill = await mustGetBill(tx, billId);
  const s = await settingsRow(tx);
  const decision = decide(
    { actor: a.actor, itemType: "bill_draft", amount: bill.total, proposeOnly: a.proposeOnly },
    await policyRules(tx),
    s.reviewThreshold,
  );
  if (decision.action === "auto_approve") return null;
  const id = newId();
  const payload = JSON.stringify({ bill: await billView(tx, bill) });
  await tx.insert(org.reviewItems).values({
    id,
    itemType: "bill_draft",
    itemId: billId,
    proposedByActor: a.actor,
    proposedById: a.userId ?? a.apiTokenId ?? a.oauthClientId ?? null,
    reason: decision.reason,
    rationale,
    payloadJson: payload,
    originalPayloadJson: payload,
    amount: bill.total,
  });
  await appendAudit(tx, orgId, a, {
    action: "bill.propose",
    targetType: "bill",
    targetId: billId,
    after: { review_item_id: id, reason: decision.reason, rationale },
  });
  return id;
}

registerReviewHandler("bill_draft", {
  async approve(tx, orgId, a, item, input) {
    const bill = await tx.select().from(org.bills).where(eqId(item.itemId)).get();
    let result: unknown = null;
    // A person may already have finalized or deleted the draft from the bills page.
    if (bill && bill.status === "draft") {
      result = await finalizeBillTx(tx, orgId, a, bill.id, {
        lockOverrideNote: input.lock_override_note ?? null,
        forcePost: true,
      });
    }
    await finishReviewTx(tx, orgId, a, item, "approved", input.note ?? null);
    return result;
  },
  async reject(tx, orgId, a, item, note) {
    const bill = await tx.select().from(org.bills).where(eqId(item.itemId)).get();
    if (bill && bill.status === "draft") await deleteBillDraftTx(tx, orgId, a, bill.id);
    await finishReviewTx(tx, orgId, a, item, "rejected", note);
  },
});

function eqId(id: string) {
  return eq(org.bills.id, id);
}
