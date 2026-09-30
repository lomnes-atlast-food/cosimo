/**
 * A fake network for anchoring tests: OpenTimestamps calendars (POST /digest, GET /timestamp/<hex>),
 * an RFC 3161 authority that signs real tokens with the test TSA key in
 * packages/core/test-fixtures/test-tsa, and an Esplora block explorer. Calendars answer the way the
 * live ones do (checked against alice.btc.calendar.opentimestamps.org): a pending attestation to
 * their own URL, 404 until confirmed, then a path to a Bitcoin attestation.
 */
import { createHash, createPrivateKey, sign, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  children,
  derContext,
  derGeneralizedTime,
  derInteger,
  derNull,
  derOctets,
  derOid,
  derSequence,
  derSet,
  parseDer,
  TAG,
} from "@cosimo/core/der";
import type { Config } from "../src/config.ts";

export const TEST_TSA_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "packages",
  "core",
  "test-fixtures",
  "test-tsa",
);
export const CALENDARS = ["https://cal-a.test", "https://cal-b.test"];
export const TSA_URL = "https://tsa.test/tsr";
export const EXPLORER = "https://explorer.test/api";

/** Point a test config at the fakes. */
export function fakeAnchoring(c: Config, over: Partial<Config["anchoring"]> = {}) {
  c.anchoring = {
    enabled: true,
    ots_calendars: CALENDARS.join(","),
    tsa_url: TSA_URL,
    tsa_ca_file: join(TEST_TSA_DIR, "ca.pem"),
    bitcoin_api: EXPLORER,
    ...over,
  };
}

const PENDING_TAG = Buffer.from("83dfe30d2ef90c8e", "hex");
const BITCOIN_TAG = Buffer.from("0588960d73d71901", "hex");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest();

function varuint(n: number) {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}
const varbytes = (b: Uint8Array) => Buffer.concat([varuint(b.length), b]);

interface Block {
  height: number;
  hash: string;
  merkle_root: string;
  timestamp: number;
}

export class FakeAnchorNet {
  calls: { method: string; url: string }[] = [];
  /** Calendars and the TSA to fail, by URL prefix. */
  down = new Set<string>();
  explorerDown = false;
  /** genTime for the next TSA tokens. */
  genTime = () => new Date().toISOString();
  /** Pending commitment (hex) → calendar; confirmed ones get a path to a block. */
  readonly pending = new Map<string, string>();
  readonly confirmed = new Map<string, { height: number; path: Buffer }>();
  readonly blocks = new Map<number, Block>();
  #serial = 1;
  readonly #tsaKey = createPrivateKey(readFileSync(join(TEST_TSA_DIR, "tsa.key")));
  readonly #tsaCert = new X509Certificate(readFileSync(join(TEST_TSA_DIR, "tsa.pem")));
  readonly #caCert = new X509Certificate(readFileSync(join(TEST_TSA_DIR, "ca.pem")));

  /** Mine every pending commitment into one block at `height`. */
  confirmAll(height: number, time: Date) {
    const commits = [...this.pending.keys()].map((h) => Buffer.from(h, "hex"));
    if (!commits.length) return;
    const root = sha256(Buffer.concat(commits));
    commits.forEach((c, i) => {
      const before = Buffer.concat(commits.slice(0, i));
      const after = Buffer.concat(commits.slice(i + 1));
      const path = Buffer.concat([
        before.length ? Buffer.concat([Buffer.from([0xf1]), varbytes(before)]) : Buffer.alloc(0),
        after.length ? Buffer.concat([Buffer.from([0xf0]), varbytes(after)]) : Buffer.alloc(0),
        Buffer.from([0x08, 0x00]),
        BITCOIN_TAG,
        varbytes(varuint(height)),
      ]);
      this.confirmed.set(c.toString("hex"), { height, path });
      this.pending.delete(c.toString("hex"));
    });
    this.blocks.set(height, {
      height,
      hash: sha256(Buffer.from(`block ${height}`)).toString("hex"),
      merkle_root: Buffer.from(root).reverse().toString("hex"),
      timestamp: Math.floor(time.getTime() / 1000),
    });
  }

  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    this.calls.push({ method, url });
    if ([...this.down].some((d) => url.startsWith(d)))
      throw new TypeError("fetch failed: connection refused");
    const body = init?.body ? new Uint8Array(init.body as Uint8Array) : new Uint8Array();

    const cal = CALENDARS.find((c) => url.startsWith(c));
    if (cal && method === "POST" && url === `${cal}/digest`) {
      // append(8 bytes) sha256, then a pending attestation to this calendar.
      const salt = sha256(Buffer.concat([body, Buffer.from(cal)])).subarray(0, 8);
      const commitment = sha256(Buffer.concat([body, salt]));
      this.pending.set(commitment.toString("hex"), cal);
      const resp = Buffer.concat([
        Buffer.from([0xf0]),
        varbytes(salt),
        Buffer.from([0x08, 0x00]),
        PENDING_TAG,
        varbytes(varbytes(Buffer.from(cal))),
      ]);
      return new Response(resp, {
        status: 200,
        headers: { "content-type": "application/vnd.opentimestamps.v1" },
      });
    }
    if (cal && method === "GET" && url.startsWith(`${cal}/timestamp/`)) {
      const hex = url.slice(`${cal}/timestamp/`.length);
      const done = this.confirmed.get(hex);
      if (done) return new Response(new Uint8Array(done.path), { status: 200 });
      return new Response(
        this.pending.has(hex) ? "Pending confirmation in Bitcoin blockchain" : "Not found",
        { status: 404 },
      );
    }
    if (url === TSA_URL && method === "POST") {
      return new Response(new Uint8Array(this.tsaResponse(body)), {
        status: 200,
        headers: { "content-type": "application/timestamp-reply" },
      });
    }
    if (url.startsWith(EXPLORER)) {
      if (this.explorerDown) throw new TypeError("fetch failed: explorer unreachable");
      const m = /\/block-height\/(\d+)$/.exec(url);
      if (m) {
        const b = this.blocks.get(Number(m[1]));
        return b ? new Response(b.hash) : new Response("Block not found", { status: 404 });
      }
      const hash = url.split("/block/")[1];
      const b = [...this.blocks.values()].find((x) => x.hash === hash);
      return b ? Response.json(b) : new Response("Block not found", { status: 404 });
    }
    return new Response("unexpected request", { status: 500 });
  }) as typeof fetch;

  /** A granted TimeStampResp for a TimeStampReq, signed by the test TSA (ECDSA P-256, SHA-256). */
  tsaResponse(req: Uint8Array): Uint8Array {
    const f = children(parseDer(req));
    const imprint = f[1]!.der;
    const nonce = f.slice(2).find((x) => x.tag === TAG.INTEGER);
    const tst = derSequence(
      derInteger(1),
      derOid("1.2.3.4.1"),
      imprint,
      derInteger(this.#serial++),
      derGeneralizedTime(this.genTime()),
      ...(nonce ? [nonce.der] : []),
    );
    const attrs = [
      derSequence(derOid("1.2.840.113549.1.9.3"), derSet(derOid("1.2.840.113549.1.9.16.1.4"))),
      derSequence(derOid("1.2.840.113549.1.9.4"), derSet(derOctets(sha256(tst)))),
    ];
    const signature = sign("sha256", derSet(...attrs), this.#tsaKey);
    const certDer = new Uint8Array(this.#tsaCert.raw);
    const tbs = children(children(parseDer(certDer))[0]!);
    const serial = tbs[1]!.der;
    const issuer = tbs[3]!.der;
    const sha256Alg = derSequence(derOid("2.16.840.1.101.3.4.2.1"), derNull());
    const signerInfo = derSequence(
      derInteger(1),
      derSequence(issuer, serial),
      sha256Alg,
      derContext(0, ...attrs),
      derSequence(derOid("1.2.840.10045.4.3.2")),
      derOctets(new Uint8Array(signature)),
    );
    const signedData = derSequence(
      derInteger(3),
      derSet(sha256Alg),
      derSequence(derOid("1.2.840.113549.1.9.16.1.4"), derContext(0, derOctets(tst))),
      derContext(0, certDer, new Uint8Array(this.#caCert.raw)),
      derSet(signerInfo),
    );
    return derSequence(
      derSequence(derInteger(0)),
      derSequence(derOid("1.2.840.113549.1.7.2"), derContext(0, signedData)),
    );
  }
}
