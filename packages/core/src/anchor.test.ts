/**
 * OpenTimestamps and RFC 3161 against real proofs (see test-fixtures/README.md for where each came
 * from). No network: the Bitcoin merkle roots and the FreeTSA token were checked against the live
 * services when the fixtures were captured.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  anchorPreimage,
  FREETSA_ROOT_PEM,
  otsCombine,
  otsCommitment,
  otsMerge,
  otsNew,
  otsParse,
  otsParseTimestamp,
  otsReplay,
  otsSerialize,
  ProofError,
  parsePemCertificates,
  tsaParse,
  tsaRequest,
  tsaVerify,
} from "./index.ts";

const FIX = join(import.meta.dir, "..", "test-fixtures");
const read = (f: string) => new Uint8Array(readFileSync(join(FIX, f)));
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

const ANCHOR_DIGEST = "86af26feace2fa6114b0ab6beb4e448c253766c69111655de29ed72e86e93ed1";
const TSR_NONCE = 0x1122334455667788n;

function flipAt(buf: Uint8Array, i: number) {
  const out = buf.slice();
  out[i]! ^= 0x01;
  return out;
}
function indexOf(buf: Uint8Array, needle: Uint8Array) {
  return Buffer.from(buf).indexOf(Buffer.from(needle));
}

describe("OpenTimestamps", () => {
  test("parse and serialize round-trip every fixture byte for byte", () => {
    for (const f of ["hello-world.txt.ots", "incomplete.txt.ots", "anchor-1.alice.pending.ots"]) {
      const b = read(f);
      const parsed = otsParse(b);
      expect(otsSerialize(parsed)).toEqual(b);
      expect(otsParse(otsSerialize(parsed))).toEqual(parsed);
    }
  });

  test("a complete proof replays to its Bitcoin block's merkle root", () => {
    const r = otsReplay(read("hello-world.txt.ots"));
    expect(r.digest).toBe(sha256(read("hello-world.txt")));
    // blockstream.info/api/block/<hash of height 358391>: merkle_root, in explorer byte order.
    expect(r.attestations).toEqual([
      {
        kind: "bitcoin",
        height: 358391,
        merkleRoot: "8a1b66ecb7cbd07d8139a7e7d7f2c41aab1f5009b8364aaf61d03ad245e47e00",
      },
    ]);
  });

  test("merging a calendar upgrade completes a pending proof", () => {
    const pending = read("incomplete.txt.ots");
    const before = otsReplay(pending);
    expect(before.digest).toBe(sha256(read("incomplete.txt")));
    const p = before.attestations[0]!;
    expect(p.kind).toBe("pending");
    if (p.kind !== "pending") return;
    expect(p.url).toBe("https://alice.btc.calendar.opentimestamps.org");

    const merged = otsMerge(pending, p.commitment, read("incomplete.upgrade.bin"));
    const after = otsReplay(merged);
    expect(after.digest).toBe(before.digest);
    expect(after.attestations).toContainEqual({
      kind: "bitcoin",
      height: 428648,
      merkleRoot: "078cdde9c89f2e3c58c96b1658627fd9298c63c6618954ea24ac3b5a13fe18da",
    });
    // The pending attestation stays, as with `ots upgrade`.
    expect(after.attestations.filter((a) => a.kind === "pending").length).toBe(1);
    expect(() => otsMerge(pending, "00".repeat(32), read("incomplete.upgrade.bin"))).toThrow(ProofError);
  });

  test("a proof built from a calendar response commits to the anchor digest", () => {
    const b = read("anchor-1.alice.pending.ots");
    const r = otsReplay(b);
    expect(r.digest).toBe(sha256(read("anchor-1.txt")));
    expect(r.digest).toBe(ANCHOR_DIGEST);
    expect(r.attestations).toHaveLength(1);
    expect(r.attestations[0]).toMatchObject({
      kind: "pending",
      url: "https://alice.btc.calendar.opentimestamps.org",
    });

    // Rebuild it: the first ops are append(nonce) and sha256 of the commitment the calendar got.
    const nonce = new Uint8Array(Buffer.from("00112233445566778899aabbccddeeff", "hex"));
    const file = otsParse(b);
    const first = file.timestamp.ops[0]!;
    expect(first.op).toEqual({ op: "append", arg: nonce });
    expect(first.stamp.ops[0]!.op).toEqual({ op: "sha256" });
    const calendarPart = otsSerialize({ ...file, timestamp: first.stamp.ops[0]!.stamp }).subarray(
      32 + 1 + 1 + 31,
    );
    expect(otsNew(ANCHOR_DIGEST, nonce, calendarPart)).toEqual(b);
    expect(otsCommitment(ANCHOR_DIGEST, nonce)).toEqual(
      new Uint8Array(
        createHash("sha256")
          .update(Buffer.concat([Buffer.from(ANCHOR_DIGEST, "hex"), nonce]))
          .digest(),
      ),
    );
  });

  test("proofs of one digest combine into one file, forking at the digest", () => {
    const a = read("anchor-1.alice.pending.ots");
    const combined = otsCombine([a, a]);
    const r = otsReplay(combined);
    expect(r.digest).toBe(ANCHOR_DIGEST);
    expect(r.attestations.map((x) => x.kind)).toEqual(["pending", "pending"]);
    expect(otsParse(combined).timestamp.ops).toHaveLength(2);
    expect(otsCombine([a])).toEqual(a);
    expect(() => otsCombine([a, read("hello-world.txt.ots")])).toThrow(/different digests/);
  });

  test("rejects malformed proofs", () => {
    const b = read("hello-world.txt.ots");
    expect(() => otsParse(b.subarray(0, b.length - 1))).toThrow(ProofError);
    expect(() => otsParse(new Uint8Array([...b, 0]))).toThrow(/trailing/);
    expect(() => otsParse(flipAt(b, 3))).toThrow(/not an .ots/);
    expect(() => otsParseTimestamp(new Uint8Array([0x99]))).toThrow(/unknown .ots operation/);
    // A flipped byte in an operand still parses but no longer reaches the block's merkle root.
    const tampered = otsReplay(flipAt(b, 60));
    expect(tampered.attestations[0]).toMatchObject({ kind: "bitcoin", height: 358391 });
    expect((tampered.attestations[0] as { merkleRoot: string }).merkleRoot).not.toBe(
      "8a1b66ecb7cbd07d8139a7e7d7f2c41aab1f5009b8364aaf61d03ad245e47e00",
    );
  });
});

describe("RFC 3161", () => {
  const tsr = read("anchor-1.freetsa.tsr");
  const roots = parsePemCertificates(FREETSA_ROOT_PEM);

  test("the request matches what FreeTSA answered", () => {
    expect(tsaRequest(ANCHOR_DIGEST, TSR_NONCE)).toEqual(read("anchor-1.tsq"));
    const heads = (h: string) => ({ seq: 1, hash: h });
    const pre = anchorPreimage(
      "01JABCDEFGHJKMNPQRSTVWXYZ0",
      heads("88bd7600acfefeb2df2389f7665ff37bce4fae1a7d9fac43450b70d64b56763d"),
      heads("0287e99de8d4cce788a7953f3fffbcba8de6b54de734e1cdbe8862d0fc5c47a6"),
    );
    expect(pre).toBe(new TextDecoder().decode(read("anchor-1.txt")));
    expect(sha256(pre)).toBe(ANCHOR_DIGEST);
  });

  test("parses FreeTSA's token", () => {
    const p = tsaParse(tsr);
    expect(p.status).toBe(0);
    expect(p.token!.tstInfo).toMatchObject({
      imprint: ANCHOR_DIGEST,
      genTime: "2026-09-30T12:08:38.000Z",
      nonce: TSR_NONCE,
    });
    expect(p.token!.digestAlgorithm).toBe("2.16.840.1.101.3.4.2.3"); // sha512
    expect(p.token!.signatureAlgorithm).toBe("1.2.840.10045.4.3.4"); // ecdsa-with-SHA512
    expect(p.token!.certificates.length).toBe(2);
  });

  test("verifies FreeTSA's token and its chain to the bundled root", () => {
    const v = tsaVerify(tsr, ANCHOR_DIGEST, { nonce: TSR_NONCE, roots });
    expect(v.genTime).toBe("2026-09-30T12:08:38.000Z");
    expect(v.trusted).toBe(true);
    expect(v.signerSubject).toContain("CN=www.freetsa.org");
    expect(v.certificatesPem[0]).toStartWith("-----BEGIN CERTIFICATE-----");
    expect(tsaVerify(tsr, ANCHOR_DIGEST).trusted).toBeNull();
    // Another root doesn't vouch for it.
    const other = parsePemCertificates(readFileSync(join(FIX, "test-tsa", "ca.pem"), "utf8"));
    expect(tsaVerify(tsr, ANCHOR_DIGEST, { roots: other }).trusted).toBe(false);
  });

  test("fails for another digest or nonce", () => {
    expect(() => tsaVerify(tsr, "00".repeat(32))).toThrow(/imprint doesn't match/);
    expect(() => tsaVerify(tsr, ANCHOR_DIGEST, { nonce: 1n })).toThrow(/nonce/);
  });

  test("fails on a flipped byte in the imprint, the TSTInfo, the signed attributes, or the signature", () => {
    const imprintAt = indexOf(tsr, Buffer.from(ANCHOR_DIGEST, "hex"));
    expect(imprintAt).toBeGreaterThan(0);
    const badImprint = flipAt(tsr, imprintAt + 5);
    const flippedDigest = Buffer.from(ANCHOR_DIGEST, "hex");
    flippedDigest[5]! ^= 0x01;
    // Checked against the original digest the imprint differs; against the flipped digest, the
    // signed messageDigest no longer matches the TSTInfo.
    expect(() => tsaVerify(badImprint, ANCHOR_DIGEST)).toThrow(/imprint/);
    expect(() => tsaVerify(badImprint, flippedDigest.toString("hex"))).toThrow(/messageDigest/);

    const genTimeAt = indexOf(tsr, new TextEncoder().encode("20260930120838Z"));
    expect(() => tsaVerify(flipAt(tsr, genTimeAt + 12), ANCHOR_DIGEST)).toThrow(/messageDigest/);

    // The signingTime attribute (UTCTime) comes after the TSTInfo, inside the signed attributes.
    const attrsTime = Buffer.from(tsr).indexOf(Buffer.from("260930120838Z"), genTimeAt + 20);
    expect(attrsTime).toBeGreaterThan(genTimeAt);
    expect(() => tsaVerify(flipAt(tsr, attrsTime + 11), ANCHOR_DIGEST)).toThrow(/signature doesn't verify/);

    // The signature is the last field: flip a byte of its S integer.
    expect(() => tsaVerify(flipAt(tsr, tsr.length - 3), ANCHOR_DIGEST)).toThrow(/signature doesn't verify/);
  });

  test("a refused request fails", () => {
    // TimeStampResp { status { rejection(2), "bad" } }
    const refused = new Uint8Array(Buffer.from("300c300a020102300512036261 64".replace(/ /g, ""), "hex"));
    expect(tsaParse(refused)).toMatchObject({ status: 2, statusText: "bad", token: null });
    expect(() => tsaVerify(refused, ANCHOR_DIGEST)).toThrow(/refused \(status 2: bad\)/);
  });
});

describe("parsePemCertificates", () => {
  test("splits a bundle and stays linear on repeated BEGIN lines", () => {
    expect(parsePemCertificates(`${FREETSA_ROOT_PEM}\n${FREETSA_ROOT_PEM}`)).toHaveLength(2);
    expect(parsePemCertificates(`junk\n-----BEGIN CERTIFICATE-----\n${FREETSA_ROOT_PEM}`)).toHaveLength(1);
    const start = performance.now();
    expect(parsePemCertificates("-----BEGIN CERTIFICATE-----".repeat(100_000))).toHaveLength(0);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
