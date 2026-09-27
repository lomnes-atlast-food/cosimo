/**
 * Live Plaid Sandbox run (SPEC §15.1, acceptance #7). Gated behind COSIMO_TEST_PLAID=1 with
 * PLAID_CLIENT_ID / PLAID_SECRET from the gitignored .env.local; CI runs only the mocked tests.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { org } from "@cosimo/db";
import { eq } from "drizzle-orm";
import { syncConnection } from "../src/services/plaid.ts";
import { HttpPlaid } from "../src/services/plaid-client.ts";
import { type Client, createOrg, createTestEnv, login, type TestEnv } from "./harness.ts";

// Bun does not read .env.local under `bun test`; load it here (values never override the shell).
const envFile = join(import.meta.dir, "../../../.env.local");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
}

const enabled = process.env.COSIMO_TEST_PLAID === "1";
const clientId = process.env.PLAID_CLIENT_ID ?? "";
const secret = process.env.PLAID_SECRET ?? "";

describe.skipIf(!enabled)("Plaid Sandbox (live)", () => {
  let env: TestEnv;
  let owner: Client;
  let orgId: string;
  const plaid = new HttpPlaid({ env: "sandbox", clientId, secret });

  beforeAll(async () => {
    if (!clientId || !secret) throw new Error("COSIMO_TEST_PLAID=1 needs PLAID_CLIENT_ID and PLAID_SECRET");
    env = await createTestEnv();
    await env.ctx.settings.set("plaid", { enabled: true, env: "sandbox", client_id: clientId, secret });
    owner = await login(env, "sandbox-owner@example.com");
    orgId = await createOrg(env, owner, "Sandbox Co");
  });

  afterAll(async () => {
    await env?.close();
  });

  test("connect a test bank, receive transactions, and need reauth after a reset login", async () => {
    const base = `/api/v1/orgs/${orgId}`;
    const lt = await owner.json("POST", `${base}/plaid/link-token`, {});
    expect(lt.status).toBe(200);
    expect(lt.body.link_token).toStartWith("link-sandbox-");

    const publicToken = await plaid.sandboxPublicToken("ins_109508");
    const ex = await owner.json("POST", `${base}/plaid/exchange`, { public_token: publicToken });
    expect(ex.status).toBe(201);
    const connId = ex.body.connection.id as string;
    expect(ex.body.connection.accounts.length).toBeGreaterThan(0);

    // Sandbox prepares transactions asynchronously; poll the sync for up to a minute.
    let total = ex.body.sync?.added ?? 0;
    for (let i = 0; i < 20 && total === 0; i++) {
      await Bun.sleep(3000);
      total += (await syncConnection(env.ctx, orgId, connId)).added;
    }
    expect(total).toBeGreaterThan(0);
    const list = await owner.json("GET", `${base}/bank-transactions?limit=500`);
    expect(list.body.data.length).toBeGreaterThan(0);

    // A second sync is idempotent.
    const again = await syncConnection(env.ctx, orgId, connId);
    expect(again.added).toBe(0);

    const h = await env.ctx.orgs.mustOpen(orgId);
    const row = await h.db.select().from(org.bankConnections).where(eq(org.bankConnections.id, connId)).get();
    await plaid.sandboxResetLogin(env.ctx.secrets.reveal(row!.accessTokenEnc)!);
    const s = await owner.json("POST", `${base}/bank-connections/${connId}/sync`, {});
    expect(s.status).toBe(502);
    const c = await owner.json("GET", `${base}/bank-connections/${connId}`);
    expect(c.body.status).toBe("needs_reauth");

    const upd = await owner.json("POST", `${base}/plaid/link-token`, { connection_id: connId });
    expect(upd.body.update_mode).toBe(true);

    expect((await owner.json("DELETE", `${base}/bank-connections/${connId}`)).status).toBe(200);
  }, 120_000);
});
