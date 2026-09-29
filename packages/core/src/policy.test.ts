import { describe, expect, test } from "bun:test";
import { checkLock, reversalLines, validateLines } from "./ledger.ts";
import { decide, type PolicyRule } from "./policy.ts";

describe("review policy defaults (SPEC §7.5)", () => {
  const p = (actor: "user" | "api_token" | "mcp" | "rule" | "system" | "integration", extra = {}) =>
    decide({ actor, itemType: "journal_entry", amount: 10000, ...extra }, []);

  test("defaults by actor", () => {
    expect(p("user").action).toBe("auto_approve");
    expect(p("api_token").action).toBe("auto_approve");
    expect(p("api_token", { proposeOnly: true }).action).toBe("require_review");
    expect(p("rule", { ruleAutoPost: true }).action).toBe("auto_approve");
    expect(p("rule").action).toBe("require_review");
    expect(p("mcp").action).toBe("require_review");
    expect(p("integration")).toEqual({
      action: "auto_approve",
      reason: "Recorded from a payment provider.",
      ruleId: null,
    });
  });

  test("payment provider entries still honour the threshold and owner rules", () => {
    expect(decide({ actor: "integration", itemType: "journal_entry", amount: 250000 }, []).action).toBe(
      "require_review",
    );
    const rules: PolicyRule[] = [
      { id: "r1", actor: "integration", condition: {}, action: "require_review", priority: 10 },
    ];
    expect(decide({ actor: "integration", itemType: "journal_entry", amount: 100 }, rules).action).toBe(
      "require_review",
    );
  });

  test("threshold catches every actor", () => {
    for (const actor of ["user", "api_token", "mcp", "rule", "system", "integration"] as const) {
      expect(
        decide({ actor, itemType: "journal_entry", amount: 250000, ruleAutoPost: true }, []).action,
      ).toBe("require_review");
    }
    expect(decide({ actor: "user", itemType: "journal_entry", amount: 249999 }, []).action).toBe(
      "auto_approve",
    );
    expect(decide({ actor: "user", itemType: "journal_entry", amount: 999999 }, [], 0).action).toBe(
      "auto_approve",
    );
  });

  test("owner rules: auto-approve small MCP categorizations to known accounts", () => {
    const rules: PolicyRule[] = [
      {
        id: "r1",
        actor: "mcp",
        condition: { amount_lt: 10000, item_types: ["bank_categorization"], account_used_for_payee: true },
        action: "auto_approve",
        priority: 10,
      },
    ];
    const base = { actor: "mcp" as const, itemType: "bank_categorization" as const };
    expect(decide({ ...base, amount: 9999, accountUsedForPayee: true }, rules).action).toBe("auto_approve");
    expect(decide({ ...base, amount: 10000, accountUsedForPayee: true }, rules).action).toBe(
      "require_review",
    );
    expect(decide({ ...base, amount: 50, accountUsedForPayee: false }, rules).action).toBe("require_review");
    expect(
      decide({ ...base, itemType: "journal_entry", amount: 50, accountUsedForPayee: true }, rules).action,
    ).toBe("require_review");
  });

  test("rules cannot bypass the threshold, propose-only tokens, or import batches", () => {
    const rules: PolicyRule[] = [
      { id: "all", actor: "*", condition: {}, action: "auto_approve", priority: 1 },
    ];
    expect(decide({ actor: "mcp", itemType: "journal_entry", amount: 300000 }, rules).action).toBe(
      "require_review",
    );
    expect(
      decide({ actor: "api_token", itemType: "journal_entry", amount: 1, proposeOnly: true }, rules).action,
    ).toBe("require_review");
    expect(decide({ actor: "user", itemType: "import_batch", amount: 1 }, rules).action).toBe(
      "require_review",
    );
  });
});

describe("ledger rules", () => {
  const accounts = new Map([
    ["cash", { id: "cash", type: "asset" as const, isActive: true, currency: "USD" }],
    ["inc", { id: "inc", type: "income" as const, isActive: true, currency: "USD" }],
    ["old", { id: "old", type: "expense" as const, isActive: false, currency: "USD" }],
  ]);

  test("validateLines", () => {
    expect(
      validateLines(
        [
          { accountId: "cash", amount: 100 },
          { accountId: "inc", amount: -100 },
        ],
        accounts,
        "USD",
      ),
    ).toEqual([]);
    const codes = (ls: { accountId: string; amount: number }[]) =>
      validateLines(ls, accounts, "USD").map((e) => e.code);
    expect(
      codes([
        { accountId: "cash", amount: 100 },
        { accountId: "inc", amount: -99 },
      ]),
    ).toContain("unbalanced");
    expect(codes([{ accountId: "cash", amount: 0 }])).toContain("too_few_lines");
    expect(
      codes([
        { accountId: "cash", amount: 1.5 },
        { accountId: "inc", amount: -1.5 },
      ]),
    ).toContain("invalid_amount");
    expect(
      codes([
        { accountId: "old", amount: 1 },
        { accountId: "inc", amount: -1 },
      ]),
    ).toContain("inactive_account");
    expect(
      codes([
        { accountId: "nope", amount: 1 },
        { accountId: "inc", amount: -1 },
      ]),
    ).toContain("unknown_account");
    expect(validateLines([{ accountId: "cash", amount: 5 }], accounts, "USD", { forPosting: false })).toEqual(
      [],
    );
  });

  test("reversalLines negates every line", () => {
    const r = reversalLines([
      { accountId: "cash", amount: 100 },
      { accountId: "inc", amount: -100 },
    ]);
    expect(r.map((l) => l.amount)).toEqual([-100, 100]);
  });

  test("checkLock", () => {
    const locks = { softLockDate: "2026-03-31", hardLockDate: "2025-12-31" };
    expect(checkLock("2026-04-01", locks, { actor: "mcp", role: "viewer" }).ok).toBe(true);
    expect(checkLock("2026-03-31", locks, { actor: "user", role: "bookkeeper" }, "note").ok).toBe(false);
    expect(checkLock("2026-03-31", locks, { actor: "api_token", role: "owner" }, "note").ok).toBe(false);
    expect(checkLock("2026-03-31", locks, { actor: "user", role: "owner" }).ok).toBe(false);
    expect(checkLock("2026-03-31", locks, { actor: "user", role: "owner" }, "fix typo")).toEqual({
      ok: true,
      overridesSoftLock: true,
    });
    const hard = checkLock("2025-12-31", locks, { actor: "user", role: "owner" }, "please");
    expect(hard.ok).toBe(false);
    if (!hard.ok) expect(hard.code).toBe("hard_locked");
  });
});
