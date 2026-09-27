import { describe, expect, test } from "bun:test";
import { firstMatchingRule, ruleMatches, safeRegex, validateRule } from "./rules.ts";

const t = { bankAccountId: "b1", amount: -2310, description: "UBER TRIP HELP.UBER.COM", payee: null };

describe("bank rules", () => {
  test("conditions", () => {
    expect(ruleMatches({ description_contains: "uber" }, t)).toBe(true);
    expect(ruleMatches({ description_contains: "lyft" }, t)).toBe(false);
    expect(ruleMatches({ description_regex: "^uber\\s+trip" }, t)).toBe(true);
    expect(ruleMatches({ direction: "in" }, t)).toBe(false);
    expect(ruleMatches({ direction: "out", amount_min: 2000, amount_max: 3000 }, t)).toBe(true);
    expect(ruleMatches({ amount_eq: 2310 }, t)).toBe(true);
    expect(ruleMatches({ bank_account_id: "b2" }, t)).toBe(false);
  });

  test("priority order and inactive rules", () => {
    const rules = [
      {
        id: "b",
        name: "b",
        priority: 10,
        isActive: true,
        conditions: { description_contains: "uber" },
        actions: {},
      },
      {
        id: "a",
        name: "a",
        priority: 5,
        isActive: false,
        conditions: { description_contains: "uber" },
        actions: {},
      },
      {
        id: "c",
        name: "c",
        priority: 10,
        isActive: true,
        conditions: { description_contains: "trip" },
        actions: {},
      },
    ];
    expect(firstMatchingRule(rules, t)?.id).toBe("b");
  });

  test("unsafe or invalid regexes never match and fail validation", () => {
    expect(safeRegex("(a+)+$")).toBeNull();
    expect(safeRegex("[")).toBeNull();
    expect(ruleMatches({ description_regex: "(a+)+$" }, t)).toBe(false);
    expect(validateRule({ description_regex: "(" }, { account_id: "x" })).toContain("regular expression");
    expect(validateRule({}, { account_id: "x" })).toContain("condition");
    expect(validateRule({ direction: "out" }, {})).toContain("action");
    expect(validateRule({ direction: "out" }, { account_id: "x", transfer_account_id: "y" })).toContain(
      "either",
    );
    expect(validateRule({ direction: "out" }, { account_id: "x", auto_post: true })).toBeNull();
  });
});
