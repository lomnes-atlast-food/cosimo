/**
 * Invoice drafts proposed by AI assistants (SPEC §7.5, §10.2). The draft exists as a normal draft
 * invoice (no ledger effect) plus an `invoice_draft` review item. Approving finalizes it, which
 * posts the receivable; sending stays a separate, human step. Rejecting deletes the draft; the
 * review item keeps a snapshot of what was proposed.
 */
import { decide } from "@cosimo/core";
import { newId, type OrgTx, org } from "@cosimo/db";
import { eq } from "drizzle-orm";
import type { ActorInfo } from "./actor.ts";
import { appendAudit } from "./audit.ts";
import { deleteInvoiceDraftTx, finalizeInvoiceTx, invoiceView, mustGetInvoice } from "./documents.ts";
import { policyRules, settingsRow } from "./ledger.ts";
import { finishReviewTx, registerReviewHandler } from "./review.ts";

/** Hold a new draft for review unless a review policy auto-approves it. Returns the review item ID. */
export async function holdInvoiceDraftTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  invoiceId: string,
  rationale: string | null,
): Promise<string | null> {
  const inv = await mustGetInvoice(tx, invoiceId);
  const s = await settingsRow(tx);
  const decision = decide(
    { actor: a.actor, itemType: "invoice_draft", amount: inv.total, proposeOnly: a.proposeOnly },
    await policyRules(tx),
    s.reviewThreshold,
  );
  if (decision.action === "auto_approve") return null;
  const id = newId();
  const payload = JSON.stringify({ invoice: await invoiceView(tx, inv) });
  await tx.insert(org.reviewItems).values({
    id,
    itemType: "invoice_draft",
    itemId: invoiceId,
    proposedByActor: a.actor,
    proposedById: a.userId ?? a.apiTokenId ?? a.oauthClientId ?? null,
    reason: decision.reason,
    rationale,
    payloadJson: payload,
    originalPayloadJson: payload,
    amount: inv.total,
  });
  await appendAudit(tx, orgId, a, {
    action: "invoice.propose",
    targetType: "invoice",
    targetId: invoiceId,
    after: { review_item_id: id, reason: decision.reason, rationale },
  });
  return id;
}

registerReviewHandler("invoice_draft", {
  async approve(tx, orgId, a, item, input) {
    const inv = await tx.select().from(org.invoices).where(eqId(item.itemId)).get();
    let result: unknown = null;
    // A person may already have finalized or deleted the draft from the invoices page.
    if (inv && inv.status === "draft") {
      result = await finalizeInvoiceTx(tx, orgId, a, inv.id, {
        lockOverrideNote: input.lock_override_note ?? null,
        forcePost: true,
      });
    }
    await finishReviewTx(tx, orgId, a, item, "approved", input.note ?? null);
    return result;
  },
  async reject(tx, orgId, a, item, note) {
    const inv = await tx.select().from(org.invoices).where(eqId(item.itemId)).get();
    if (inv && inv.status === "draft") await deleteInvoiceDraftTx(tx, orgId, a, inv.id);
    await finishReviewTx(tx, orgId, a, item, "rejected", note);
  },
});

function eqId(id: string) {
  return eq(org.invoices.id, id);
}
