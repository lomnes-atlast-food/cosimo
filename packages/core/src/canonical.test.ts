import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { canonicalJson } from "./canonical.ts";

describe("canonicalJson", () => {
  test("sorts keys and strips whitespace", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: { z: 0, y: -5 } })).toBe(
      '{"a":[true,null,"x"],"b":1,"c":{"y":-5,"z":0}}',
    );
  });
  test("escapes strings like JSON.stringify", () => {
    expect(canonicalJson({ s: 'q"\\\n\u0001é😀' })).toBe('{"s":"q\\"\\\\\\n\\u0001é😀"}');
  });
  test("rejects floats, undefined, dates", () => {
    expect(() => canonicalJson({ a: 1.5 })).toThrow();
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson({ a: new Date() })).toThrow();
    expect(() => canonicalJson(Number.NaN)).toThrow();
  });
  test("-0 is 0", () => {
    expect(canonicalJson(-0)).toBe("0");
  });
  test("is insensitive to key insertion order", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.oneof(fc.integer(), fc.string(), fc.boolean())), (d) => {
        const reversed = Object.fromEntries(Object.entries(d).reverse());
        expect(canonicalJson(reversed)).toBe(canonicalJson(d));
        expect(JSON.parse(canonicalJson(d))).toEqual(d);
      }),
    );
  });
});
