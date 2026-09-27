import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { allocateCents, centsToDecimal, formatCents, parseCents } from "./money.ts";

describe("parseCents", () => {
  test.each([
    ["0", 0],
    ["12", 1200],
    ["12.3", 1230],
    ["12.34", 1234],
    ["-12.34", -1234],
    ["(12.34)", -1234],
    ["$1,234.56", 123456],
    ["-$5", -500],
    [".5", 50],
    ["1.50 CR", 150],
    ["1.50 DR", -150],
    ["12.340", 1234],
  ])("%s -> %d", (s, n) => {
    expect(parseCents(s)).toBe(n as never);
  });
  test("rejects garbage and extra precision", () => {
    expect(() => parseCents("abc")).toThrow();
    expect(() => parseCents("1.234")).toThrow();
    expect(() => parseCents("(1.00")).toThrow();
    expect(parseCents("1.235", { allowExtraDecimals: true })).toBe(124 as never);
  });
  test("round trips with centsToDecimal", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e12, max: 1e12 }), (n) => {
        expect(parseCents(centsToDecimal(n))).toBe(n as never);
      }),
    );
  });
});

describe("formatCents", () => {
  test("formats", () => {
    expect(formatCents(123456, "USD", { locale: "en-US" })).toBe("$1,234.56");
    expect(formatCents(-5, "USD", { locale: "en-US", parens: true })).toBe("($0.05)");
    expect(formatCents(-5, "USD", { locale: "en-US" })).toBe("-$0.05");
    expect(formatCents(900719925474099, "USD", { locale: "en-US" })).toBe("$9,007,199,254,740.99");
  });
});

describe("allocateCents", () => {
  test("sums exactly", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1e9, max: 1e9 }),
        fc.array(fc.integer({ min: 1, max: 1e7 }), { minLength: 1, maxLength: 20 }),
        (total, weights) => {
          const out = allocateCents(total, weights);
          expect(out.reduce((a, b) => a + b, 0)).toBe(total);
          expect(out.every(Number.isSafeInteger)).toBe(true);
        },
      ),
    );
  });
  test("proportional", () => {
    expect(allocateCents(100, [1, 1, 1])).toEqual([34, 33, 33] as never);
    expect(allocateCents(-100, [1, 3])).toEqual([-25, -75] as never);
  });
});
