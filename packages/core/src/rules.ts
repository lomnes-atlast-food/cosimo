/**
 * Bank rules (SPEC §7.3): conditions over a bank transaction, applied in priority order.
 */

export interface RuleConditions {
  description_contains?: string | null;
  description_regex?: string | null;
  amount_eq?: number | null;
  /** Absolute amount bounds, inclusive (cents). */
  amount_min?: number | null;
  amount_max?: number | null;
  direction?: "in" | "out" | null;
  bank_account_id?: string | null;
}

export interface RuleActions {
  account_id?: string | null;
  contact_id?: string | null;
  memo?: string | null;
  /** Mark as a transfer to this ledger account (another of the org's own accounts). */
  transfer_account_id?: string | null;
  auto_post?: boolean;
}

export interface RuleDef {
  id: string;
  name: string;
  priority: number;
  isActive: boolean;
  conditions: RuleConditions;
  actions: RuleActions;
}

export interface RuleTxn {
  bankAccountId: string;
  amount: number;
  description: string;
  payee?: string | null;
}

const MAX_REGEX = 200;

/** Compile a user-supplied regex safely; invalid or oversized patterns never match. */
export function safeRegex(src: string): RegExp | null {
  if (!src || src.length > MAX_REGEX) return null;
  // Reject nested quantifiers, the common catastrophic-backtracking shape.
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(src)) return null;
  try {
    return new RegExp(src, "i");
  } catch {
    return null;
  }
}

export function validateRule(c: RuleConditions, a: RuleActions): string | null {
  const hasCondition =
    Boolean(c.description_contains?.trim()) ||
    Boolean(c.description_regex?.trim()) ||
    c.amount_eq != null ||
    c.amount_min != null ||
    c.amount_max != null ||
    Boolean(c.direction) ||
    Boolean(c.bank_account_id);
  if (!hasCondition) return "A rule needs at least one condition.";
  if (c.description_regex && !safeRegex(c.description_regex))
    return "The pattern is not a valid (or safe) regular expression.";
  if (c.amount_min != null && c.amount_max != null && c.amount_min > c.amount_max)
    return "Minimum amount is above the maximum.";
  if (!a.account_id && !a.transfer_account_id && !a.contact_id && !a.memo)
    return "A rule needs at least one action.";
  if (a.account_id && a.transfer_account_id)
    return "Choose either a category account or a transfer account, not both.";
  if (a.auto_post && !a.account_id && !a.transfer_account_id)
    return "Auto-post needs an account or a transfer target.";
  return null;
}

export function ruleMatches(c: RuleConditions, t: RuleTxn): boolean {
  if (c.bank_account_id && c.bank_account_id !== t.bankAccountId) return false;
  if (c.direction === "in" && t.amount <= 0) return false;
  if (c.direction === "out" && t.amount >= 0) return false;
  const abs = Math.abs(t.amount);
  if (c.amount_eq != null && abs !== Math.abs(c.amount_eq)) return false;
  if (c.amount_min != null && abs < c.amount_min) return false;
  if (c.amount_max != null && abs > c.amount_max) return false;
  const text = `${t.description} ${t.payee ?? ""}`.toLowerCase();
  if (c.description_contains?.trim() && !text.includes(c.description_contains.trim().toLowerCase()))
    return false;
  if (c.description_regex?.trim()) {
    const re = safeRegex(c.description_regex.trim());
    if (!re?.test(text)) return false;
  }
  return true;
}

/** First active rule (lowest priority number, then oldest id) whose conditions match. */
export function firstMatchingRule<R extends RuleDef>(rules: R[], t: RuleTxn): R | null {
  const sorted = rules
    .filter((r) => r.isActive)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  return sorted.find((r) => ruleMatches(r.conditions, t)) ?? null;
}
