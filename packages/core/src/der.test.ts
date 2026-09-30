import { describe, expect, test } from "bun:test";
import {
  children,
  DerError,
  decodeGeneralizedTime,
  decodeOid,
  decodeUnsigned,
  derGeneralizedTime,
  derInteger,
  derOctets,
  derOid,
  derSequence,
  parseDer,
  TAG,
} from "./der.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

describe("DER", () => {
  test("INTEGER encodes minimally and round-trips", () => {
    expect(hex(derInteger(0))).toBe("020100");
    expect(hex(derInteger(127))).toBe("02017f");
    expect(hex(derInteger(128))).toBe("02020080");
    expect(hex(derInteger(256))).toBe("02020100");
    expect(hex(derInteger(bytes("000001")))).toBe("020101");
    for (const n of [0n, 1n, 127n, 128n, 255n, 65535n, 0x1122334455667788n, 2n ** 159n + 12345n]) {
      const t = parseDer(derInteger(n));
      expect(t.tag).toBe(TAG.INTEGER);
      expect(decodeUnsigned(t.value)).toBe(n);
    }
    expect(() => decodeUnsigned(bytes("80"))).toThrow(DerError);
  });

  test("OIDs round-trip", () => {
    expect(hex(derOid("2.16.840.1.101.3.4.2.1"))).toBe("0609608648016503040201");
    for (const oid of ["1.2.840.113549.1.7.2", "1.2.840.113549.1.9.16.1.4", "1.3.6.1.5.5.7.3.8", "2.999.3"])
      expect(decodeOid(parseDer(derOid(oid)).value)).toBe(oid);
  });

  test("GeneralizedTime round-trips, with and without fractions", () => {
    for (const iso of ["2026-09-30T12:08:38.000Z", "2026-09-30T12:08:38.120Z", "1999-12-31T23:59:59.999Z"])
      expect(decodeGeneralizedTime(parseDer(derGeneralizedTime(iso)).value)).toBe(iso);
    expect(new TextDecoder().decode(parseDer(derGeneralizedTime("2026-09-30T12:08:38.000Z")).value)).toBe(
      "20260930120838Z",
    );
    expect(() => decodeGeneralizedTime(new TextEncoder().encode("20260930120838+0100"))).toThrow(DerError);
  });

  test("long lengths and nesting", () => {
    const big = new Uint8Array(300).fill(7);
    const seq = derSequence(derOctets(big), derInteger(5), derOctets(new Uint8Array(130)));
    const kids = children(parseDer(seq));
    expect(kids.map((k) => k.tag)).toEqual([TAG.OCTET_STRING, TAG.INTEGER, TAG.OCTET_STRING]);
    expect(kids[0]!.value).toEqual(big);
    expect(hex(kids[0]!.der.subarray(0, 4))).toBe("0482012c");
    expect(kids[2]!.value.length).toBe(130);
  });

  test("rejects BER and malformed input", () => {
    expect(() => parseDer(bytes("3080020100 0000".replace(/ /g, "")))).toThrow(/indefinite/);
    expect(() => parseDer(bytes("020100ff"))).toThrow(/trailing/);
    expect(() => parseDer(bytes("0205010203"))).toThrow(/past the end/);
    expect(() => parseDer(bytes("04810301 0203".replace(/ /g, "")))).toThrow(/non-minimal/);
    expect(() => parseDer(bytes("1f0100"))).toThrow(/high tag/);
  });
});
