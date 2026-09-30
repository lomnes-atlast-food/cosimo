/**
 * Public timestamps for chain heads (SPEC §6.5, docs/chain-format.md "Anchors"). Pure functions,
 * no I/O: the anchor preimage and digest, OpenTimestamps (.ots) proofs, and RFC 3161 timestamp
 * requests and responses (.tsq/.tsr). The server does the network calls (services/anchors.ts).
 *
 * The formats follow the reference implementations: python-opentimestamps
 * (opentimestamps/core/{timestamp,op,notary}.py) for .ots files, and RFC 3161 / RFC 5652 (CMS) for
 * timestamp tokens.
 */
import { createHash, verify as verifySignature, X509Certificate } from "node:crypto";
import {
  children,
  concatBytes,
  DerError,
  decodeGeneralizedTime,
  decodeOid,
  decodeUnsigned,
  derBool,
  derInteger,
  derNull,
  derOctets,
  derOid,
  derSequence,
  expectTag,
  parseDer,
  TAG,
  type Tlv,
} from "./der.ts";

export class ProofError extends Error {}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
// No Buffer here: the web app imports this package, and module-level constants must load in a browser.
const unhex = (s: string) => {
  if (!/^([0-9a-f]{2})*$/i.test(s)) throw new ProofError(`not hex: ${s.slice(0, 20)}`);
  return new Uint8Array((s.match(/../g) ?? []).map((h) => Number.parseInt(h, 16)));
};
const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());

// ----------------------------------------------------------------------------- preimage

export interface AnchorHead {
  seq: number;
  hash: string;
}

/**
 * The text a public timestamp commits to: UTF-8, LF line endings, trailing newline. Saved as
 * `anchor-<ledger seq>.txt`, it can be checked with `ots verify` and `openssl ts -verify`.
 */
export function anchorPreimage(orgId: string, ledger: AnchorHead, audit: AnchorHead): string {
  if (!/^[\x21-\x7e]+$/.test(orgId)) throw new ProofError("org id must be printable ASCII without spaces");
  for (const h of [ledger, audit]) {
    if (!Number.isSafeInteger(h.seq) || h.seq < 0) throw new ProofError(`bad seq ${h.seq}`);
    if (!/^[0-9a-f]{64}$/.test(h.hash)) throw new ProofError(`bad chain hash ${h.hash}`);
  }
  return `cosimo-anchor v1\norg ${orgId}\nledger ${ledger.seq} ${ledger.hash}\naudit ${audit.seq} ${audit.hash}\n`;
}

/** SHA-256 of the preimage, lower-case hex. */
export function anchorDigest(orgId: string, ledger: AnchorHead, audit: AnchorHead): string {
  return createHash("sha256")
    .update(anchorPreimage(orgId, ledger, audit), "utf8")
    .digest("hex");
}

// ----------------------------------------------------------------------------- OpenTimestamps

export type OtsOp =
  | { op: "append" | "prepend"; arg: Uint8Array }
  | { op: "sha1" | "ripemd160" | "sha256" | "keccak256" | "reverse" | "hexlify" };

export type OtsAttestation =
  | { kind: "pending"; url: string }
  | { kind: "bitcoin"; height: number }
  | { kind: "unknown"; tag: Uint8Array; payload: Uint8Array };

/** A timestamp tree: attestations on this message, and operations leading to further messages. */
export interface OtsTimestamp {
  attestations: OtsAttestation[];
  ops: { op: OtsOp; stamp: OtsTimestamp }[];
}

export interface OtsFile {
  /** The hash of the timestamped file; always sha256 for anchors. */
  hashOp: "sha256" | "sha1" | "ripemd160";
  digest: Uint8Array;
  timestamp: OtsTimestamp;
}

const OTS_MAGIC = unhex("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294");
const OTS_VERSION = 1;
const OTS_PENDING_TAG = unhex("83dfe30d2ef90c8e");
const OTS_BITCOIN_TAG = unhex("0588960d73d71901");
/** Same limits as the reference client (op.py MAX_RESULT_LENGTH, notary.py MAX_PAYLOAD_SIZE). */
const MAX_MSG = 4096;
const MAX_PAYLOAD = 8192;
const MAX_URI = 1000;
const MAX_DEPTH = 256;

const UNARY_TAGS: Record<number, OtsOp["op"]> = {
  2: "sha1",
  3: "ripemd160",
  8: "sha256",
  103: "keccak256",
  242: "reverse",
  243: "hexlify",
};
const DIGEST_LEN: Record<string, number> = { sha1: 20, ripemd160: 20, sha256: 32 };
const OP_TAG: Record<OtsOp["op"], number> = {
  append: 0xf0,
  prepend: 0xf1,
  sha1: 0x02,
  ripemd160: 0x03,
  sha256: 0x08,
  keccak256: 0x67,
  reverse: 0xf2,
  hexlify: 0xf3,
};

class Reader {
  pos = 0;
  constructor(private readonly buf: Uint8Array) {}
  byte(): number {
    if (this.pos >= this.buf.length) throw new ProofError("truncated .ots data");
    return this.buf[this.pos++]!;
  }
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new ProofError("truncated .ots data");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  varuint(): number {
    let n = 0;
    let shift = 1;
    for (;;) {
      const b = this.byte();
      n += (b & 0x7f) * shift;
      if (!Number.isSafeInteger(n)) throw new ProofError("varuint too large");
      if (!(b & 0x80)) return n;
      shift *= 128;
    }
  }
  varbytes(max: number, min = 0): Uint8Array {
    const n = this.varuint();
    if (n > max || n < min) throw new ProofError(`length ${n} out of range`);
    return this.bytes(n);
  }
  eof() {
    return this.pos === this.buf.length;
  }
}

class Writer {
  parts: number[] = [];
  byte(b: number) {
    this.parts.push(b);
  }
  bytes(b: Uint8Array) {
    for (const x of b) this.parts.push(x);
  }
  varuint(n: number) {
    do {
      let b = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) b |= 0x80;
      this.parts.push(b);
    } while (n > 0);
  }
  varbytes(b: Uint8Array) {
    this.varuint(b.length);
    this.bytes(b);
  }
  done() {
    return new Uint8Array(this.parts);
  }
}

function readAttestation(r: Reader): OtsAttestation {
  const tag = r.bytes(8);
  const payload = r.varbytes(MAX_PAYLOAD);
  const p = new Reader(payload);
  if (equalBytes(tag, OTS_PENDING_TAG)) {
    const url = new TextDecoder("utf-8", { fatal: true }).decode(p.varbytes(MAX_URI));
    if (!p.eof()) throw new ProofError("trailing bytes in pending attestation");
    return { kind: "pending", url };
  }
  if (equalBytes(tag, OTS_BITCOIN_TAG)) {
    const height = p.varuint();
    if (!p.eof()) throw new ProofError("trailing bytes in bitcoin attestation");
    return { kind: "bitcoin", height };
  }
  return { kind: "unknown", tag: new Uint8Array(tag), payload: new Uint8Array(payload) };
}

function writeAttestation(w: Writer, a: OtsAttestation) {
  const p = new Writer();
  if (a.kind === "pending") {
    w.bytes(OTS_PENDING_TAG);
    p.varbytes(new TextEncoder().encode(a.url));
  } else if (a.kind === "bitcoin") {
    w.bytes(OTS_BITCOIN_TAG);
    p.varuint(a.height);
  } else {
    w.bytes(a.tag);
    p.bytes(a.payload);
  }
  w.varbytes(p.done());
}

function readTimestamp(r: Reader, depth = 0): OtsTimestamp {
  if (depth > MAX_DEPTH) throw new ProofError(".ots timestamp nests too deeply");
  const ts: OtsTimestamp = { attestations: [], ops: [] };
  const item = (tag: number) => {
    if (tag === 0x00) {
      ts.attestations.push(readAttestation(r));
      return;
    }
    let op: OtsOp;
    if (tag === 0xf0 || tag === 0xf1) {
      op = { op: tag === 0xf0 ? "append" : "prepend", arg: new Uint8Array(r.varbytes(MAX_MSG, 1)) };
    } else if (UNARY_TAGS[tag]) {
      op = { op: UNARY_TAGS[tag] } as OtsOp;
    } else {
      throw new ProofError(`unknown .ots operation 0x${tag.toString(16)}`);
    }
    ts.ops.push({ op, stamp: readTimestamp(r, depth + 1) });
  };
  let tag = r.byte();
  while (tag === 0xff) {
    item(r.byte());
    tag = r.byte();
  }
  item(tag);
  return ts;
}

function writeTimestamp(w: Writer, ts: OtsTimestamp) {
  const items: (() => void)[] = [
    ...ts.attestations.map((a) => () => {
      w.byte(0x00);
      writeAttestation(w, a);
    }),
    ...ts.ops.map((o) => () => {
      w.byte(OP_TAG[o.op.op]);
      if ("arg" in o.op) w.varbytes(o.op.arg);
      writeTimestamp(w, o.stamp);
    }),
  ];
  if (!items.length) throw new ProofError("an empty .ots timestamp can't be serialized");
  items.forEach((write, i) => {
    if (i < items.length - 1) w.byte(0xff);
    write();
  });
}

/** Parse a detached `.ots` file. */
export function otsParse(bytes: Uint8Array): OtsFile {
  const r = new Reader(bytes);
  if (!equalBytes(r.bytes(OTS_MAGIC.length), OTS_MAGIC)) throw new ProofError("not an .ots file");
  const version = r.varuint();
  if (version !== OTS_VERSION) throw new ProofError(`unsupported .ots version ${version}`);
  const hashOp = UNARY_TAGS[r.byte()];
  if (hashOp !== "sha256" && hashOp !== "sha1" && hashOp !== "ripemd160")
    throw new ProofError("unsupported .ots file hash");
  const digest = new Uint8Array(r.bytes(DIGEST_LEN[hashOp]!));
  const timestamp = readTimestamp(r);
  if (!r.eof()) throw new ProofError("trailing bytes after .ots timestamp");
  return { hashOp, digest, timestamp };
}

export function otsSerialize(file: OtsFile): Uint8Array {
  const w = new Writer();
  w.bytes(OTS_MAGIC);
  w.varuint(OTS_VERSION);
  w.byte(OP_TAG[file.hashOp]);
  w.bytes(file.digest);
  writeTimestamp(w, file.timestamp);
  return w.done();
}

/** Parse a bare timestamp, as a calendar returns it (no file header). */
export function otsParseTimestamp(bytes: Uint8Array): OtsTimestamp {
  const r = new Reader(bytes);
  const ts = readTimestamp(r);
  if (!r.eof()) throw new ProofError("trailing bytes after calendar timestamp");
  return ts;
}

function applyOp(op: OtsOp, msg: Uint8Array): Uint8Array {
  if (msg.length > MAX_MSG) throw new ProofError("message too long");
  switch (op.op) {
    case "append":
      return concatBytes(msg, op.arg);
    case "prepend":
      return concatBytes(op.arg, msg);
    case "sha256":
    case "sha1":
    case "ripemd160":
      return new Uint8Array(createHash(op.op).update(msg).digest());
    case "reverse":
      return msg.slice().reverse();
    case "hexlify":
      return new TextEncoder().encode(hex(msg));
    default:
      throw new ProofError(`the ${op.op} operation isn't supported`);
  }
}

function walk(ts: OtsTimestamp, msg: Uint8Array, visit: (ts: OtsTimestamp, msg: Uint8Array) => void) {
  visit(ts, msg);
  for (const o of ts.ops) walk(o.stamp, applyOp(o.op, msg), visit);
}

export type OtsReplayAttestation =
  | { kind: "pending"; url: string; commitment: string }
  /** `merkleRoot` is in the byte order block explorers print (reversed from the header bytes). */
  | { kind: "bitcoin"; height: number; merkleRoot: string }
  | { kind: "unknown"; tag: string };

export interface OtsReplay {
  /** The file digest the proof starts from, hex. */
  digest: string;
  attestations: OtsReplayAttestation[];
}

/**
 * Recompute every message in the proof and list its attestations. A Bitcoin attestation holds when
 * its message equals the block header's merkle root (notary.py `verify_against_blockheader`); the
 * header stores it little-endian, so explorers show it reversed, which `merkleRoot` matches.
 */
export function otsReplay(proof: Uint8Array): OtsReplay {
  const file = otsParse(proof);
  const attestations: OtsReplayAttestation[] = [];
  walk(file.timestamp, file.digest, (ts, msg) => {
    for (const a of ts.attestations) {
      if (a.kind === "pending") attestations.push({ kind: "pending", url: a.url, commitment: hex(msg) });
      else if (a.kind === "bitcoin") {
        if (msg.length !== 32) throw new ProofError("bitcoin attestation on a message that isn't 32 bytes");
        attestations.push({ kind: "bitcoin", height: a.height, merkleRoot: hex(msg.slice().reverse()) });
      } else attestations.push({ kind: "unknown", tag: hex(a.tag) });
    }
  });
  return { digest: hex(file.digest), attestations };
}

/** The message submitted to a calendar: SHA-256(digest || nonce), as the reference client does. */
export function otsCommitment(digestHex: string, nonce: Uint8Array): Uint8Array {
  return sha256(concatBytes(unhex(digestHex), nonce));
}

/**
 * Build a `.ots` file for `digest` from a calendar's `POST /digest` response to
 * `otsCommitment(digest, nonce)`: append(nonce), sha256, then the calendar's timestamp.
 */
export function otsNew(digestHex: string, nonce: Uint8Array, calendarResponse: Uint8Array): Uint8Array {
  const digest = unhex(digestHex);
  if (digest.length !== 32) throw new ProofError("digest must be 32 bytes");
  const file: OtsFile = {
    hashOp: "sha256",
    digest,
    timestamp: {
      attestations: [],
      ops: [
        {
          op: { op: "append", arg: nonce },
          stamp: {
            attestations: [],
            ops: [{ op: { op: "sha256" }, stamp: otsParseTimestamp(calendarResponse) }],
          },
        },
      ],
    },
  };
  const bytes = otsSerialize(file);
  otsReplay(bytes); // every op must apply
  return bytes;
}

/**
 * Splice a calendar's `GET /timestamp/<commitment>` response into the proof at the message equal to
 * `commitmentHex` (the pending attestation's message). The pending attestation stays, as with
 * `ots upgrade`.
 */
export function otsMerge(proof: Uint8Array, commitmentHex: string, upgrade: Uint8Array): Uint8Array {
  const file = otsParse(proof);
  const target = unhex(commitmentHex);
  const extra = otsParseTimestamp(upgrade);
  let merged = false;
  walk(file.timestamp, file.digest, (ts, msg) => {
    if (merged || !equalBytes(msg, target) || !ts.attestations.some((a) => a.kind === "pending")) return;
    ts.attestations.push(...extra.attestations);
    ts.ops.push(...extra.ops);
    merged = true;
  });
  if (!merged) throw new ProofError("the proof has no pending attestation at that commitment");
  const bytes = otsSerialize(file);
  otsReplay(bytes);
  return bytes;
}

/**
 * Combine proofs of the same digest (one per calendar) into one `.ots` file, forking at the digest
 * the way `ots stamp` does when it submits to several calendars.
 */
export function otsCombine(proofs: Uint8Array[]): Uint8Array {
  if (!proofs.length) throw new ProofError("nothing to combine");
  const files = proofs.map(otsParse);
  const first = files[0]!;
  for (const f of files.slice(1))
    if (f.hashOp !== first.hashOp || !equalBytes(f.digest, first.digest))
      throw new ProofError("the proofs are for different digests");
  const bytes = otsSerialize({
    ...first,
    timestamp: {
      attestations: files.flatMap((f) => f.timestamp.attestations),
      ops: files.flatMap((f) => f.timestamp.ops),
    },
  });
  otsReplay(bytes);
  return bytes;
}

// ----------------------------------------------------------------------------- RFC 3161

export const OID = {
  sha1: "1.3.14.3.2.26",
  sha224: "2.16.840.1.101.3.4.2.4",
  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha512: "2.16.840.1.101.3.4.2.3",
  signedData: "1.2.840.113549.1.7.2",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingCertificate: "1.2.840.113549.1.9.16.2.12",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  timeStamping: "1.3.6.1.5.5.7.3.8",
  subjectKeyIdentifier: "2.5.29.14",
} as const;

const HASH_BY_OID: Record<string, string> = {
  [OID.sha1]: "sha1",
  [OID.sha224]: "sha224",
  [OID.sha256]: "sha256",
  [OID.sha384]: "sha384",
  [OID.sha512]: "sha512",
};

/** Signature algorithms: the hash they fix, or null when the digest algorithm decides. */
const SIG_BY_OID: Record<string, { key: "rsa" | "ec" | "ed25519"; hash: string | null }> = {
  "1.2.840.113549.1.1.1": { key: "rsa", hash: null }, // rsaEncryption
  "1.2.840.113549.1.1.5": { key: "rsa", hash: "sha1" },
  "1.2.840.113549.1.1.14": { key: "rsa", hash: "sha224" },
  "1.2.840.113549.1.1.11": { key: "rsa", hash: "sha256" },
  "1.2.840.113549.1.1.12": { key: "rsa", hash: "sha384" },
  "1.2.840.113549.1.1.13": { key: "rsa", hash: "sha512" },
  "1.2.840.10045.2.1": { key: "ec", hash: null }, // id-ecPublicKey
  "1.2.840.10045.4.1": { key: "ec", hash: "sha1" },
  "1.2.840.10045.4.3.1": { key: "ec", hash: "sha224" },
  "1.2.840.10045.4.3.2": { key: "ec", hash: "sha256" },
  "1.2.840.10045.4.3.3": { key: "ec", hash: "sha384" },
  "1.2.840.10045.4.3.4": { key: "ec", hash: "sha512" },
  "1.3.101.112": { key: "ed25519", hash: null },
};

function algorithmOid(t: Tlv | undefined, what: string): string {
  const seq = expectTag(t, TAG.SEQUENCE, what);
  return decodeOid(expectTag(children(seq)[0], TAG.OID, `${what} OID`).value);
}

/** A DER TimeStampReq for a SHA-256 digest: v1, the imprint, a nonce, and certReq TRUE. */
export function tsaRequest(digestHex: string, nonce: bigint): Uint8Array {
  const digest = unhex(digestHex);
  if (digest.length !== 32) throw new ProofError("digest must be 32 bytes");
  return derSequence(
    derInteger(1),
    derSequence(derSequence(derOid(OID.sha256), derNull()), derOctets(digest)),
    derInteger(nonce),
    derBool(true),
  );
}

export interface TstInfo {
  policy: string;
  imprintAlgorithm: string;
  imprint: string;
  serial: string;
  genTime: string;
  nonce: bigint | null;
}

export interface TsaToken {
  /** DER of the eContent (TSTInfo), which the messageDigest attribute hashes. */
  tstInfoDer: Uint8Array;
  tstInfo: TstInfo;
  certificates: Uint8Array[];
  signer: { issuerDer: Uint8Array; serial: Uint8Array } | { keyId: Uint8Array };
  digestAlgorithm: string;
  signatureAlgorithm: string;
  /** The signedAttrs as received (tagged [0]); the signature covers them re-tagged as a SET. */
  signedAttrsDer: Uint8Array;
  signedAttrs: { oid: string; values: Tlv[] }[];
  signature: Uint8Array;
}

export interface TsaResponse {
  /** PKIStatus: 0 granted, 1 granted with modifications, 2+ refused. */
  status: number;
  statusText: string | null;
  token: TsaToken | null;
}

function parseTstInfo(der: Uint8Array): TstInfo {
  const f = children(expectTag(parseDer(der), TAG.SEQUENCE, "TSTInfo"));
  if (decodeUnsigned(expectTag(f[0], TAG.INTEGER, "TSTInfo version").value) !== 1n)
    throw new ProofError("unsupported TSTInfo version");
  const policy = decodeOid(expectTag(f[1], TAG.OID, "TSTInfo policy").value);
  const mi = children(expectTag(f[2], TAG.SEQUENCE, "messageImprint"));
  const imprintAlgorithm = algorithmOid(mi[0], "messageImprint algorithm");
  const imprint = hex(expectTag(mi[1], TAG.OCTET_STRING, "hashedMessage").value);
  const serial = hex(expectTag(f[3], TAG.INTEGER, "TSTInfo serialNumber").value);
  const genTime = decodeGeneralizedTime(expectTag(f[4], TAG.GENERALIZED_TIME, "genTime").value);
  let nonce: bigint | null = null;
  for (const x of f.slice(5)) if (x.tag === TAG.INTEGER) nonce = decodeUnsigned(x.value);
  return { policy, imprintAlgorithm, imprint, serial, genTime, nonce };
}

/** Parse a DER TimeStampResp (a `.tsr` file). Structure only: see `tsaVerify` for the checks. */
export function tsaParse(resp: Uint8Array): TsaResponse {
  try {
    const top = children(expectTag(parseDer(resp), TAG.SEQUENCE, "TimeStampResp"));
    const si = children(expectTag(top[0], TAG.SEQUENCE, "PKIStatusInfo"));
    const status = Number(decodeUnsigned(expectTag(si[0], TAG.INTEGER, "PKIStatus").value));
    let statusText: string | null = null;
    if (si[1]?.tag === TAG.SEQUENCE)
      statusText = children(si[1])
        .map((s) => new TextDecoder().decode(s.value))
        .join("; ");
    if (!top[1]) return { status, statusText, token: null };

    const ci = children(expectTag(top[1], TAG.SEQUENCE, "ContentInfo"));
    if (decodeOid(expectTag(ci[0], TAG.OID, "contentType").value) !== OID.signedData)
      throw new ProofError("the token isn't CMS SignedData");
    const sd = children(
      expectTag(children(expectTag(ci[1], 0xa0, "content"))[0], TAG.SEQUENCE, "SignedData"),
    );
    const eci = children(expectTag(sd[2], TAG.SEQUENCE, "encapContentInfo"));
    if (decodeOid(expectTag(eci[0], TAG.OID, "eContentType").value) !== OID.tstInfo)
      throw new ProofError("the token's content isn't a TSTInfo");
    const tstInfoDer = expectTag(
      children(expectTag(eci[1], 0xa0, "eContent"))[0],
      TAG.OCTET_STRING,
      "eContent",
    ).value;

    let i = 3;
    const certificates: Uint8Array[] = [];
    if (sd[i]?.tag === 0xa0) {
      for (const c of children(sd[i]!)) if (c.tag === TAG.SEQUENCE) certificates.push(c.der);
      i++;
    }
    if (sd[i]?.tag === 0xa1) i++; // crls
    const signerInfos = children(expectTag(sd[i], TAG.SET, "signerInfos"));
    if (signerInfos.length !== 1) throw new ProofError(`expected one signer, found ${signerInfos.length}`);
    const s = children(expectTag(signerInfos[0], TAG.SEQUENCE, "SignerInfo"));
    let signer: TsaToken["signer"];
    if (s[1]?.tag === TAG.SEQUENCE) {
      const ias = children(s[1]);
      signer = {
        issuerDer: expectTag(ias[0], TAG.SEQUENCE, "issuer").der,
        serial: expectTag(ias[1], TAG.INTEGER, "serialNumber").value,
      };
    } else if (s[1]?.tag === 0x80) {
      signer = { keyId: s[1].value };
    } else throw new ProofError("unsupported signer identifier");
    const digestAlgorithm = algorithmOid(s[2], "digestAlgorithm");
    const attrs = expectTag(s[3], 0xa0, "signedAttrs");
    const signedAttrs = children(attrs).map((a) => {
      const [oid, values] = children(expectTag(a, TAG.SEQUENCE, "Attribute"));
      return {
        oid: decodeOid(expectTag(oid, TAG.OID, "attribute type").value),
        values: children(expectTag(values, TAG.SET, "attribute values")),
      };
    });
    const signatureAlgorithm = algorithmOid(s[4], "signatureAlgorithm");
    const signature = expectTag(s[5], TAG.OCTET_STRING, "signature").value;
    return {
      status,
      statusText,
      token: {
        tstInfoDer,
        tstInfo: parseTstInfo(tstInfoDer),
        certificates,
        signer,
        digestAlgorithm,
        signatureAlgorithm,
        signedAttrsDer: attrs.der,
        signedAttrs,
        signature,
      },
    };
  } catch (e) {
    if (e instanceof DerError) throw new ProofError(`malformed timestamp response: ${e.message}`);
    throw e;
  }
}

/** issuer Name DER, serial INTEGER content, and subjectKeyIdentifier of a certificate. */
function certIds(der: Uint8Array) {
  const tbs = children(expectTag(children(parseDer(der))[0], TAG.SEQUENCE, "tbsCertificate"));
  const f = tbs[0]?.tag === 0xa0 ? tbs.slice(1) : tbs;
  const serial = expectTag(f[0], TAG.INTEGER, "certificate serial").value;
  const issuerDer = expectTag(f[2], TAG.SEQUENCE, "certificate issuer").der;
  let keyId: Uint8Array | null = null;
  const ext = tbs.find((t) => t.tag === 0xa3);
  if (ext) {
    for (const e of children(children(ext)[0]!)) {
      const parts = children(e);
      if (decodeOid(parts[0]!.value) !== OID.subjectKeyIdentifier) continue;
      keyId = parseDer(parts[parts.length - 1]!.value).value;
    }
  }
  return { serial, issuerDer, keyId };
}

export interface TsaVerified {
  genTime: string;
  serial: string;
  policy: string;
  signerSubject: string;
  signerFingerprint256: string;
  /**
   * Whether the signer chains to one of `roots`; null when no roots were given. The signature
   * alone only proves the embedded certificate's key signed the token, so a verifier needs this
   * (or `openssl ts -verify -CAfile`) before trusting the time.
   */
  trusted: boolean | null;
  /** PEM of the signer certificate, then any other certificates in the token. */
  certificatesPem: string[];
}

/** Split a PEM bundle into certificates. */
export function parsePemCertificates(pem: string): X509Certificate[] {
  // A linear scan rather than a lazy regex, which backtracks polynomially on repeated BEGIN lines.
  const begin = "-----BEGIN CERTIFICATE-----";
  const end = "-----END CERTIFICATE-----";
  const out: X509Certificate[] = [];
  for (let i = pem.indexOf(begin); i !== -1; ) {
    const j = pem.indexOf(end, i + begin.length);
    if (j === -1) break;
    out.push(new X509Certificate(pem.slice(pem.lastIndexOf(begin, j), j + end.length)));
    i = pem.indexOf(begin, j + end.length);
  }
  return out;
}

const validAt = (c: X509Certificate, at: Date) =>
  at.getTime() >= Date.parse(c.validFrom) && at.getTime() <= Date.parse(c.validTo);

function chainsToRoot(signer: X509Certificate, pool: X509Certificate[], roots: X509Certificate[], at: Date) {
  let cur = signer;
  for (let depth = 0; depth < 6; depth++) {
    if (roots.some((r) => r.fingerprint256 === cur.fingerprint256)) return true;
    if (roots.some((r) => cur.checkIssued(r) && cur.verify(r.publicKey))) return true;
    const next = pool.find(
      (c) =>
        c.fingerprint256 !== cur.fingerprint256 &&
        c.ca &&
        validAt(c, at) &&
        cur.checkIssued(c) &&
        cur.verify(c.publicKey),
    );
    if (!next) return false;
    cur = next;
  }
  return false;
}

/**
 * Check a TimeStampResp against the digest it should cover. In order: the response granted a
 * token; the imprint equals `digest` (and the nonce, when given); the signed `messageDigest`
 * attribute equals the hash of the TSTInfo; the signature over the signed attributes (re-encoded
 * as a SET) verifies with the signer certificate's key; and that certificate is for timestamping
 * and valid at genTime. With `roots`, also reports whether the signer chains to one of them.
 * Throws ProofError on any failure.
 */
export function tsaVerify(
  resp: Uint8Array,
  digestHex: string,
  opts: { nonce?: bigint; roots?: X509Certificate[] } = {},
): TsaVerified {
  const parsed = tsaParse(resp);
  if (parsed.status > 1 || !parsed.token)
    throw new ProofError(
      `the timestamp authority refused (status ${parsed.status}${parsed.statusText ? `: ${parsed.statusText}` : ""})`,
    );
  const t = parsed.token;

  // 1. The token covers our digest.
  if (t.tstInfo.imprintAlgorithm !== OID.sha256) throw new ProofError("the token's imprint isn't SHA-256");
  if (t.tstInfo.imprint !== digestHex.toLowerCase())
    throw new ProofError("the token's imprint doesn't match the digest");
  if (opts.nonce !== undefined && t.tstInfo.nonce !== opts.nonce)
    throw new ProofError("the token's nonce doesn't match the request");

  // 2. The signed attributes commit to the TSTInfo.
  const hashName = HASH_BY_OID[t.digestAlgorithm];
  if (!hashName) throw new ProofError(`unsupported digest algorithm ${t.digestAlgorithm}`);
  const attr = (oid: string) => t.signedAttrs.find((a) => a.oid === oid)?.values[0];
  const ct = attr(OID.contentType);
  if (!ct || decodeOid(ct.value) !== OID.tstInfo)
    throw new ProofError("the signed contentType isn't TSTInfo");
  const md = attr(OID.messageDigest);
  if (!md || md.tag !== TAG.OCTET_STRING) throw new ProofError("the token has no messageDigest attribute");
  const tstHash = new Uint8Array(createHash(hashName).update(t.tstInfoDer).digest());
  if (!equalBytes(md.value, tstHash))
    throw new ProofError("the signed messageDigest doesn't match the TSTInfo");

  // 3. The signer's certificate, found by the signer identifier.
  const signerDer = t.certificates.find((der) => {
    const ids = certIds(der);
    return "keyId" in t.signer
      ? ids.keyId !== null && equalBytes(ids.keyId, t.signer.keyId)
      : equalBytes(ids.issuerDer, t.signer.issuerDer) && equalBytes(ids.serial, t.signer.serial);
  });
  if (!signerDer) throw new ProofError("the token doesn't include the signer's certificate");
  const signer = new X509Certificate(signerDer);
  const essV1 = attr(OID.signingCertificate);
  const essV2 = attr(OID.signingCertificateV2);
  if (essV1 || essV2) {
    const certId = children(children(children((essV2 ?? essV1)!)[0]!)[0]!);
    const alg =
      essV2 && certId[0]?.tag === TAG.SEQUENCE ? HASH_BY_OID[algorithmOid(certId[0], "ESS hash")] : null;
    const certHash = certId.find((x) => x.tag === TAG.OCTET_STRING)?.value;
    const expected = createHash(alg ?? (essV2 ? "sha256" : "sha1"))
      .update(signerDer)
      .digest();
    if (!certHash || !equalBytes(certHash, new Uint8Array(expected)))
      throw new ProofError("the signing-certificate attribute doesn't match the signer's certificate");
  }

  // 4. The signature over the signed attributes, re-tagged as SET OF (RFC 5652 §5.4).
  const sig = SIG_BY_OID[t.signatureAlgorithm];
  if (!sig) throw new ProofError(`unsupported signature algorithm ${t.signatureAlgorithm}`);
  const keyType = signer.publicKey.asymmetricKeyType;
  if ((sig.key === "rsa" && keyType !== "rsa") || (sig.key !== "rsa" && keyType !== sig.key))
    throw new ProofError("the signature algorithm doesn't match the signer's key");
  const signed = t.signedAttrsDer.slice();
  signed[0] = TAG.SET;
  const ok = verifySignature(
    sig.key === "ed25519" ? null : (sig.hash ?? hashName),
    signed,
    signer.publicKey,
    t.signature,
  );
  if (!ok) throw new ProofError("the timestamp signature doesn't verify");

  // 5. The certificate is a timestamping certificate, valid when the token was issued.
  if (!signer.keyUsage?.includes(OID.timeStamping))
    throw new ProofError("the signer's certificate isn't for timestamping");
  const genTime = new Date(t.tstInfo.genTime);
  if (!validAt(signer, genTime))
    throw new ProofError("the signer's certificate wasn't valid at the token's time");

  const others = t.certificates.filter((d) => d !== signerDer).map((d) => new X509Certificate(d));
  return {
    genTime: t.tstInfo.genTime,
    serial: t.tstInfo.serial,
    policy: t.tstInfo.policy,
    signerSubject: signer.subject.replace(/\n/g, ", "),
    signerFingerprint256: signer.fingerprint256,
    trusted: opts.roots ? chainsToRoot(signer, others, opts.roots, genTime) : null,
    certificatesPem: [signer, ...others].map((c) => c.toString()),
  };
}
