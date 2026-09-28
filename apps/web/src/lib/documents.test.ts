import { describe, expect, test } from "bun:test";
import { parseQty, qtyText } from "./documents";

describe("parseQty", () => {
  test("accepts a leading or trailing decimal point, and surrounding whitespace", () => {
    expect(parseQty(".25")).toBe(250);
    expect(parseQty("0.25")).toBe(250);
    expect(parseQty("0.2500")).toBe(250);
    expect(parseQty("1.")).toBe(1000);
    expect(parseQty(" .5 ")).toBe(500);
  });

  test("rejects zero, negatives, and malformed input", () => {
    expect(parseQty("0")).toBeNull();
    expect(parseQty("-1")).toBeNull();
    expect(parseQty(".")).toBeNull();
    expect(parseQty("")).toBeNull();
    expect(parseQty("0.0001")).toBeNull();
    expect(parseQty("1,000")).toBeNull();
  });

  test("qtyText round-trips a parsed quantity", () => {
    for (const s of [".25", "0.25", "0.2500", "1.", " .5 "]) {
      const milli = parseQty(s);
      expect(milli).not.toBeNull();
      expect(parseQty(qtyText(milli!))).toBe(milli);
    }
  });
});
