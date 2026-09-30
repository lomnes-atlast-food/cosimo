import { describe, expect, test } from "bun:test";
import { dueFromRule, parseTerms, termsAgree, termsFromDates } from "./terms.ts";

describe("parseTerms", () => {
  test("presets and case", () => {
    expect(parseTerms("Net 30")).toEqual({ kind: "days", days: 30 });
    expect(parseTerms("NET30")).toEqual({ kind: "days", days: 30 });
    expect(parseTerms("Due on receipt")).toEqual({ kind: "days", days: 0 });
    expect(parseTerms("Due end of month")).toEqual({ kind: "eom", months: 0 });
    expect(parseTerms("EOM")).toEqual({ kind: "eom", months: 0 });
    expect(parseTerms("Due end of next month")).toEqual({ kind: "eom", months: 1 });
    expect(parseTerms("On due date")).toBe("on_due_date");
  });
  test("discount terms mean the net days; custom text is null", () => {
    expect(parseTerms("2/10 Net 30")).toEqual({ kind: "days", days: 30 });
    expect(parseTerms("Thanks for your business")).toBeNull();
    expect(parseTerms("")).toBeNull();
    expect(parseTerms(null)).toBeNull();
  });
});

describe("dueFromRule", () => {
  test("days and end of month edges", () => {
    expect(dueFromRule("2026-01-31", { kind: "days", days: 30 })).toBe("2026-03-02");
    expect(dueFromRule("2026-01-31", { kind: "eom", months: 1 })).toBe("2026-02-28");
    expect(dueFromRule("2028-01-31", { kind: "eom", months: 1 })).toBe("2028-02-29");
    expect(dueFromRule("2026-12-15", { kind: "eom", months: 1 })).toBe("2027-01-31");
  });
});

describe("termsFromDates", () => {
  test("presets", () => {
    expect(termsFromDates("2026-01-01", "2026-01-01")).toBe("Due on receipt");
    expect(termsFromDates("2026-01-01", "2026-01-31")).toBe("Net 30");
    expect(termsFromDates("2026-01-01", "2026-01-16")).toBe("Net 15");
    expect(termsFromDates("2026-01-10", "2026-01-31")).toBe("Due end of month");
    expect(termsFromDates("2026-01-10", "2026-02-28")).toBe("Due end of next month");
    expect(termsFromDates("2026-12-10", "2027-01-31")).toBe("Due end of next month");
    expect(termsFromDates("2026-01-31", "2026-02-28")).toBe("Due end of next month");
  });
  test("otherwise on due date", () => {
    expect(termsFromDates("2026-01-01", "2026-01-06")).toBe("On due date");
  });
});

describe("termsAgree", () => {
  test("rules must match; custom and on-due-date always agree", () => {
    expect(termsAgree("2026-01-01", "Net 30", "2026-01-31")).toBe(true);
    expect(termsAgree("2026-01-01", "Net 30", "2026-01-06")).toBe(false);
    expect(termsAgree("2026-01-01", "Due end of month", "2026-01-31")).toBe(true);
    expect(termsAgree("2026-01-01", "On due date", "2026-01-06")).toBe(true);
    expect(termsAgree("2026-01-01", "Custom words", "2026-01-06")).toBe(true);
  });
});
