/**
 * Live public timestamps (#11) against FreeTSA, one OpenTimestamps calendar, and blockstream.info.
 * Gated behind COSIMO_TEST_ANCHORS=1; CI runs only the mocked tests in anchors.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FREETSA_ROOT_PEM, otsReplay, parsePemCertificates, tsaVerify } from "@cosimo/core";
import { org } from "@cosimo/db";
import { lookupBlock } from "../src/services/anchor-verify.ts";
import { anchorNow, anchorVerifyOptions, upgradePending } from "../src/services/anchors.ts";
import { verifyOrg } from "../src/services/chain.ts";
import { type Client, createOrg, createTestEnv, login, type TestEnv } from "./harness.ts";

const enabled = process.env.COSIMO_TEST_ANCHORS === "1";
const CALENDAR = "https://alice.btc.calendar.opentimestamps.org";

describe.skipIf(!enabled)("public timestamps (live)", () => {
  let env: TestEnv;
  let owner: Client;
  let orgId: string;

  beforeAll(async () => {
    env = await createTestEnv({
      configure: (c) => {
        c.anchoring.enabled = true;
        c.anchoring.ots_calendars = CALENDAR;
      },
    });
    owner = await login(env, "live-anchor@example.com");
    orgId = await createOrg(env, owner, "Live Anchor Co");
  });
  afterAll(async () => {
    await env.close();
  });

  test("FreeTSA signs the heads and OpenTimestamps accepts them", async () => {
    const h = await env.ctx.orgs.mustOpen(orgId);
    const r = await anchorNow(env.ctx, h, orgId, "manual");
    console.log("anchorNow:", JSON.stringify(r));
    expect(r.status).toBe("anchored");
    const rows = await h.db.select().from(org.chainAnchors).all();
    expect(rows.map((x) => `${x.kind} ${x.status}`).sort()).toEqual(["ots pending", "rfc3161 complete"]);

    const tsa = rows.find((x) => x.kind === "rfc3161")!;
    const v = tsaVerify(new Uint8Array(Buffer.from(tsa.proof!, "base64")), tsa.digest, {
      roots: parsePemCertificates(FREETSA_ROOT_PEM),
    });
    console.log("FreeTSA:", v.genTime, v.signerSubject, v.signerFingerprint256);
    expect(v.trusted).toBe(true);
    expect(v.genTime).toBe(tsa.attestedAt!);

    const ots = rows.find((x) => x.kind === "ots")!;
    const replay = otsReplay(new Uint8Array(Buffer.from(ots.proof!, "base64")));
    console.log("OpenTimestamps:", JSON.stringify(replay));
    expect(replay.digest).toBe(ots.digest);
    expect(replay.attestations[0]).toMatchObject({ kind: "pending", url: CALENDAR });

    // Not in a block yet: the calendar answers 404 and the row stays pending.
    const up = await upgradePending(env.ctx, h, orgId);
    console.log("upgrade:", JSON.stringify(up));
    expect(up).toMatchObject({ checked: 1, pending: 1, errors: [] });

    const verified = await verifyOrg(h.db, orgId, {
      anchors: anchorVerifyOptions(env.ctx, { network: true }),
    });
    expect(verified.ok).toBe(true);
    expect(verified.anchors).toMatchObject({ ok: true, tsa_trust: "checked" });
  }, 60_000);

  test("the block explorer's merkle root matches the OpenTimestamps example proof", async () => {
    const fixture = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "packages",
      "core",
      "test-fixtures",
      "hello-world.txt.ots",
    );
    const att = otsReplay(new Uint8Array(readFileSync(fixture))).attestations[0]!;
    if (att.kind !== "bitcoin") throw new Error("expected a Bitcoin attestation");
    const block = await lookupBlock({ fetch, api: env.ctx.config.anchoring.bitcoin_api }, att.height);
    console.log("block:", JSON.stringify(block));
    expect(block.merkleRoot).toBe(att.merkleRoot);
  }, 60_000);
});
