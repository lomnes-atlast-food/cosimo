/**
 * Minimal DER reader and writer for RFC 3161 timestamp requests and responses (see anchor.ts).
 * Only what those structures need: single-byte tags, definite lengths, INTEGER, OID, OCTET STRING,
 * BOOLEAN, NULL and GeneralizedTime. BER-only encodings (indefinite lengths, high tag numbers) are
 * rejected rather than guessed at.
 */

export class DerError extends Error {}

export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x30,
  SET: 0x31,
} as const;

/** One tag-length-value, with offsets into the buffer it was read from. */
export interface Tlv {
  tag: number;
  constructed: boolean;
  /** 0 universal, 1 application, 2 context-specific, 3 private. */
  cls: number;
  /** Tag number without class and constructed bits. */
  num: number;
  /** The whole encoding, header included. */
  der: Uint8Array;
  /** The content octets. */
  value: Uint8Array;
}

/** Read the TLV at `offset`. */
export function readTlv(buf: Uint8Array, offset = 0): Tlv {
  if (offset + 2 > buf.length) throw new DerError("truncated DER header");
  const tag = buf[offset]!;
  if ((tag & 0x1f) === 0x1f) throw new DerError("high tag numbers are not supported");
  let len = buf[offset + 1]!;
  let p = offset + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0) throw new DerError("indefinite length is not DER");
    if (n > 4) throw new DerError("length too long");
    if (p + n > buf.length) throw new DerError("truncated DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p + i]!;
    if (len < 0x80 || buf[p] === 0) throw new DerError("non-minimal DER length");
    p += n;
  }
  if (p + len > buf.length) throw new DerError("DER value runs past the end of the input");
  return {
    tag,
    constructed: (tag & 0x20) !== 0,
    cls: tag >> 6,
    num: tag & 0x1f,
    der: buf.subarray(offset, p + len),
    value: buf.subarray(p, p + len),
  };
}

/** Parse a buffer holding exactly one TLV. */
export function parseDer(buf: Uint8Array): Tlv {
  const t = readTlv(buf, 0);
  if (t.der.length !== buf.length) throw new DerError("trailing bytes after DER value");
  return t;
}

/** The TLVs inside a constructed value. */
export function children(t: Tlv): Tlv[] {
  if (!t.constructed) throw new DerError(`tag 0x${t.tag.toString(16)} is not constructed`);
  const out: Tlv[] = [];
  let p = 0;
  while (p < t.value.length) {
    const c = readTlv(t.value, p);
    out.push(c);
    p += c.der.length;
  }
  return out;
}

export function expectTag(t: Tlv | undefined, tag: number, what: string): Tlv {
  if (!t) throw new DerError(`missing ${what}`);
  if (t.tag !== tag)
    throw new DerError(`${what}: expected tag 0x${tag.toString(16)}, got 0x${t.tag.toString(16)}`);
  return t;
}

export function decodeOid(value: Uint8Array): string {
  if (!value.length) throw new DerError("empty OID");
  const parts: number[] = [];
  let n = 0;
  for (let i = 0; i < value.length; i++) {
    const b = value[i]!;
    n = n * 128 + (b & 0x7f);
    if (!(b & 0x80)) {
      parts.push(n);
      n = 0;
    } else if (i === value.length - 1) {
      throw new DerError("truncated OID");
    }
  }
  const first = parts.shift()!;
  const a = first < 80 ? Math.floor(first / 40) : 2;
  return [a, first - a * 40, ...parts].join(".");
}

/** A non-negative INTEGER as a bigint (negative values are rejected: nothing here uses them). */
export function decodeUnsigned(value: Uint8Array): bigint {
  if (!value.length) throw new DerError("empty INTEGER");
  if (value[0]! & 0x80) throw new DerError("negative INTEGER");
  let n = 0n;
  for (const b of value) n = n * 256n + BigInt(b);
  return n;
}

/** GeneralizedTime (`YYYYMMDDHHMMSS[.f*]Z`) as an ISO 8601 string with milliseconds. */
export function decodeGeneralizedTime(value: Uint8Array): string {
  const s = new TextDecoder().decode(value);
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?Z$/.exec(s);
  if (!m) throw new DerError(`unsupported GeneralizedTime ${JSON.stringify(s)}`);
  const ms = (m[7] ?? "").padEnd(3, "0").slice(0, 3);
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${ms}Z`;
  if (Number.isNaN(Date.parse(iso))) throw new DerError(`invalid GeneralizedTime ${s}`);
  return iso;
}

// ----------------------------------------------------------------------------- writer

function lengthBytes(len: number): number[] {
  if (len < 0x80) return [len];
  const out: number[] = [];
  for (let n = len; n > 0; n = Math.floor(n / 256)) out.unshift(n & 0xff);
  return [0x80 | out.length, ...out];
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

export function tlv(tag: number, ...content: Uint8Array[]): Uint8Array {
  const body = concatBytes(...content);
  return concatBytes(new Uint8Array([tag, ...lengthBytes(body.length)]), body);
}

export const derSequence = (...items: Uint8Array[]) => tlv(TAG.SEQUENCE, ...items);
export const derSet = (...items: Uint8Array[]) => tlv(TAG.SET, ...items);
export const derOctets = (b: Uint8Array) => tlv(TAG.OCTET_STRING, b);
export const derNull = () => tlv(TAG.NULL);
export const derBool = (v: boolean) => tlv(TAG.BOOLEAN, new Uint8Array([v ? 0xff : 0]));
/** Context-specific tag `[n]`, constructed (explicit tagging, or an implicit SET/SEQUENCE). */
export const derContext = (n: number, ...items: Uint8Array[]) => tlv(0xa0 | n, ...items);

/** A non-negative INTEGER from a bigint, number, or big-endian magnitude bytes. */
export function derInteger(v: bigint | number | Uint8Array): Uint8Array {
  let bytes: number[];
  if (v instanceof Uint8Array) {
    bytes = [...v];
  } else {
    let n = BigInt(v);
    if (n < 0n) throw new DerError("negative INTEGER");
    bytes = [];
    do {
      bytes.unshift(Number(n & 0xffn));
      n >>= 8n;
    } while (n > 0n);
  }
  while (bytes.length > 1 && bytes[0] === 0 && !(bytes[1]! & 0x80)) bytes.shift();
  if (!bytes.length) bytes = [0];
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return tlv(TAG.INTEGER, new Uint8Array(bytes));
}

export function derOid(oid: string): Uint8Array {
  const parts = oid.split(".").map(Number);
  if (parts.length < 2 || parts.some((p) => !Number.isInteger(p) || p < 0))
    throw new DerError(`bad OID ${oid}`);
  const out: number[] = [];
  const enc = (n: number) => {
    const b = [n & 0x7f];
    for (n = Math.floor(n / 128); n > 0; n = Math.floor(n / 128)) b.unshift(0x80 | (n & 0x7f));
    out.push(...b);
  };
  enc(parts[0]! * 40 + parts[1]!);
  for (const p of parts.slice(2)) enc(p);
  return tlv(TAG.OID, new Uint8Array(out));
}

/** GeneralizedTime from an ISO timestamp, to whole seconds or with milliseconds when non-zero. */
export function derGeneralizedTime(iso: string): Uint8Array {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new DerError(`bad time ${iso}`);
  const s = d.toISOString(); // 2026-09-30T12:01:25.000Z
  const ms = s.slice(20, 23);
  const text = `${s.slice(0, 4)}${s.slice(5, 7)}${s.slice(8, 10)}${s.slice(11, 13)}${s.slice(14, 16)}${s.slice(17, 19)}${ms === "000" ? "" : `.${ms.replace(/0+$/, "")}`}Z`;
  return tlv(TAG.GENERALIZED_TIME, new TextEncoder().encode(text));
}
