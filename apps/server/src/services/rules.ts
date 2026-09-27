/** Bank rules CRUD (SPEC §7.3). Rules proposed by an AI assistant wait in the review queue. */
import { decide } from "@cosimo/core";
import { type RuleActions, type RuleConditions, validateRule } from "@cosimo/core/rules";
import { newId, type OrgDb, type OrgTx, org } from "@cosimo/db";
import { asc, eq } from "drizzle-orm";
import { notFound, unprocessable } from "../http/errors.ts";
import type { ActorInfo } from "./actor.ts";
import { appendAudit } from "./audit.ts";
import { type RuleRow, ruleDef } from "./banking.ts";
import { accountMap, policyRules, settingsRow } from "./ledger.ts";
import { registerReviewHandler } from "./review.ts";

type Reader = OrgDb | OrgTx;

export interface RuleInput {
  name: string;
  priority?: number;
  is_active?: boolean;
  conditions: RuleConditions;
  actions: RuleActions;
  rationale?: string | null;
}

export function ruleView(r: RuleRow) {
  const d = ruleDef(r);
  return {
    id: r.id,
    name: r.name,
    priority: r.priority,
    is_active: r.isActive,
    conditions: d.conditions,
    actions: d.actions,
    times_applied: r.timesApplied,
    created_by_actor: r.createdByActor,
    created_at: r.createdAt,
  };
}

export async function listRules(db: Reader) {
  return (await db.select().from(org.rules).orderBy(asc(org.rules.priority), asc(org.rules.id)).all()).map(
    ruleView,
  );
}

async function mustGetRule(db: Reader, id: string) {
  const r = await db.select().from(org.rules).where(eq(org.rules.id, id)).get();
  if (!r) throw notFound("Rule");
  return r;
}

async function validate(tx: Reader, input: Pick<RuleInput, "conditions" | "actions">) {
  const msg = validateRule(input.conditions, input.actions);
  if (msg) throw unprocessable(msg, "invalid_rule");
  const accts = await accountMap(tx);
  for (const id of [input.actions.account_id, input.actions.transfer_account_id]) {
    if (id && !accts.get(id)?.isActive)
      throw unprocessable("The rule's account is missing or inactive.", "invalid_account");
  }
}

export async function createRuleTx(tx: OrgTx, orgId: string, a: ActorInfo, input: RuleInput) {
  await validate(tx, input);
  const s = await settingsRow(tx);
  const decision = decide(
    { actor: a.actor, itemType: "rule", amount: 0, proposeOnly: a.proposeOnly },
    await policyRules(tx),
    s.reviewThreshold,
  );
  const held = decision.action === "require_review";
  const id = newId();
  await tx.insert(org.rules).values({
    id,
    name: input.name,
    priority: input.priority ?? 100,
    conditionsJson: JSON.stringify(input.conditions),
    actionsJson: JSON.stringify(input.actions),
    isActive: held ? false : (input.is_active ?? true),
    createdByActor: a.actor,
  });
  const row = await mustGetRule(tx, id);
  await appendAudit(tx, orgId, a, {
    action: held ? "rule.propose" : "rule.create",
    targetType: "rule",
    targetId: id,
    after: ruleView(row),
  });
  let reviewItemId: string | null = null;
  if (held) {
    reviewItemId = newId();
    const payload = JSON.stringify({ rule: ruleView(row), activate: input.is_active ?? true });
    await tx.insert(org.reviewItems).values({
      id: reviewItemId,
      itemType: "rule",
      itemId: id,
      proposedByActor: a.actor,
      proposedById: a.userId ?? a.apiTokenId ?? a.oauthClientId ?? null,
      reason: decision.reason,
      rationale: input.rationale ?? null,
      payloadJson: payload,
      originalPayloadJson: payload,
    });
  }
  return { rule: ruleView(row), review_item_id: reviewItemId };
}

export async function updateRuleTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  id: string,
  input: Partial<RuleInput>,
) {
  const before = await mustGetRule(tx, id);
  const cur = ruleDef(before);
  const next = { conditions: input.conditions ?? cur.conditions, actions: input.actions ?? cur.actions };
  await validate(tx, next);
  await tx
    .update(org.rules)
    .set({
      name: input.name ?? before.name,
      priority: input.priority ?? before.priority,
      isActive: input.is_active ?? before.isActive,
      conditionsJson: JSON.stringify(next.conditions),
      actionsJson: JSON.stringify(next.actions),
    })
    .where(eq(org.rules.id, id));
  const after = await mustGetRule(tx, id);
  await appendAudit(tx, orgId, a, {
    action: "rule.update",
    targetType: "rule",
    targetId: id,
    before: ruleView(before),
    after: ruleView(after),
  });
  return ruleView(after);
}

export async function deleteRuleTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string) {
  const before = await mustGetRule(tx, id);
  await tx.update(org.bankTransactions).set({ ruleId: null }).where(eq(org.bankTransactions.ruleId, id));
  await tx.delete(org.rules).where(eq(org.rules.id, id));
  await appendAudit(tx, orgId, a, {
    action: "rule.delete",
    targetType: "rule",
    targetId: id,
    before: ruleView(before),
  });
}

registerReviewHandler("rule", {
  async approve(tx, orgId, a, item, input) {
    const r = await mustGetRule(tx, item.itemId);
    const payload = item.payloadJson ? (JSON.parse(item.payloadJson) as { activate?: boolean }) : {};
    await tx
      .update(org.rules)
      .set({ isActive: payload.activate ?? true })
      .where(eq(org.rules.id, r.id));
    await tx
      .update(org.reviewItems)
      .set({
        status: "approved",
        decidedBy: a.userId,
        decidedAt: new Date().toISOString(),
        decisionNote: input.note ?? null,
      })
      .where(eq(org.reviewItems.id, item.id));
    await appendAudit(tx, orgId, a, {
      action: "review.approve",
      targetType: "review_item",
      targetId: item.id,
      after: {
        item_type: "rule",
        item_id: r.id,
        proposed_by_actor: item.proposedByActor,
        note: input.note ?? null,
      },
    });
    return ruleView(await mustGetRule(tx, r.id));
  },
  async reject(tx, orgId, a, item, note) {
    const r = await tx.select().from(org.rules).where(eq(org.rules.id, item.itemId)).get();
    if (r && !r.isActive) await tx.delete(org.rules).where(eq(org.rules.id, r.id));
    await tx
      .update(org.reviewItems)
      .set({
        status: "rejected",
        decidedBy: a.userId,
        decidedAt: new Date().toISOString(),
        decisionNote: note,
      })
      .where(eq(org.reviewItems.id, item.id));
    await appendAudit(tx, orgId, a, {
      action: "review.reject",
      targetType: "review_item",
      targetId: item.id,
      after: { item_type: "rule", item_id: item.itemId, proposed_by_actor: item.proposedByActor, note },
    });
  },
});
