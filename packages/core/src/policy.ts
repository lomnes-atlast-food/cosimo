/**
 * Review policy engine (SPEC §7.5). Pure: given who is proposing what, decide whether the change is
 * auto-approved or must wait in the review queue.
 */
import type { Actor } from "@cosimo/shared";

export type PolicyAction = "auto_approve" | "require_review";

export interface PolicyRule {
  id: string;
  /** Actor this rule applies to, or "*" for any. */
  actor: Actor | "*";
  condition: PolicyCondition;
  action: PolicyAction;
  priority: number;
}

export interface PolicyCondition {
  /** Absolute amount (cents) strictly below this value. */
  amount_lt?: number;
  /** Absolute amount (cents) at or above this value. */
  amount_gte?: number;
  /** Item types this rule covers; omitted means all. */
  item_types?: string[];
  /** Only when the target account(s) were used for this payee before. */
  account_used_for_payee?: boolean;
  /** Only for rules configured with auto-post (rule actor). */
  rule_auto_post?: boolean;
}

export interface Proposal {
  actor: Actor;
  itemType:
    | "journal_entry"
    | "bank_categorization"
    | "rule"
    | "invoice_draft"
    | "bill_draft"
    | "import_batch";
  /** Largest absolute line amount / transaction amount in cents. */
  amount: number;
  proposeOnly?: boolean;
  ruleAutoPost?: boolean;
  accountUsedForPayee?: boolean;
}

export interface Decision {
  action: PolicyAction;
  reason: string;
  ruleId: string | null;
}

export const DEFAULT_THRESHOLD = 250_000;

function matches(c: PolicyCondition, p: Proposal): boolean {
  const amt = Math.abs(p.amount);
  if (c.amount_lt !== undefined && !(amt < c.amount_lt)) return false;
  if (c.amount_gte !== undefined && !(amt >= c.amount_gte)) return false;
  if (c.item_types && !c.item_types.includes(p.itemType)) return false;
  if (c.account_used_for_payee !== undefined && Boolean(p.accountUsedForPayee) !== c.account_used_for_payee)
    return false;
  if (c.rule_auto_post !== undefined && Boolean(p.ruleAutoPost) !== c.rule_auto_post) return false;
  return true;
}

/**
 * Decide. Order of precedence:
 *  1. Imports from other products always go to review as a batch.
 *  2. Anything at or above the org threshold requires review, whoever proposes it.
 *  3. propose_only API tokens always require review.
 *  4. Owner-configured rules, highest priority first (lower number wins).
 *  5. Built-in defaults: user and API token auto-approve; rule auto-approves only with auto-post on;
 *     MCP and anything else requires review.
 */
export function decide(p: Proposal, rules: PolicyRule[], threshold = DEFAULT_THRESHOLD): Decision {
  if (p.itemType === "import_batch") {
    return { action: "require_review", reason: "Imported history is reviewed as one batch.", ruleId: null };
  }
  if (threshold > 0 && Math.abs(p.amount) >= threshold) {
    return {
      action: "require_review",
      reason: `Amount is at or above the review threshold (${(threshold / 100).toFixed(2)}).`,
      ruleId: null,
    };
  }
  if (p.actor === "api_token" && p.proposeOnly) {
    return { action: "require_review", reason: "This API token can only propose changes.", ruleId: null };
  }
  const sorted = [...rules].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const r of sorted) {
    if (r.actor !== "*" && r.actor !== p.actor) continue;
    if (matches(r.condition, p)) {
      return {
        action: r.action,
        reason:
          r.action === "auto_approve" ? "Auto-approved by review policy." : "Review policy requires review.",
        ruleId: r.id,
      };
    }
  }
  switch (p.actor) {
    case "user":
    case "system":
      return { action: "auto_approve", reason: "Entered by a person.", ruleId: null };
    case "api_token":
      return { action: "auto_approve", reason: "API token.", ruleId: null };
    case "rule":
      return p.ruleAutoPost
        ? { action: "auto_approve", reason: "Rule with auto-post on.", ruleId: null }
        : { action: "require_review", reason: "Suggested by a rule (auto-post off).", ruleId: null };
    default:
      return { action: "require_review", reason: "Proposed by an AI assistant.", ruleId: null };
  }
}
