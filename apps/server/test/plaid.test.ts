/**
 * Plaid bank feeds (SPEC §7.1, §15.1) against a scripted fake of the Plaid API: Link exchange,
 * added / modified / removed / pending-to-posted sync, pagination restarts, reauth, webhooks with
 * real ES256 signatures, polling, org-level keys, and disconnect.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sha256Hex } from "@cosimo/core";
import { org } from "@cosimo/db";
import { eq } from "drizzle-orm";
import { registeredJobs, type Scheduler } from "../src/jobs/scheduler.ts";
import { clearWebhookKeys, handleWebhook, plaidCents, syncConnection } from "../src/services/plaid.ts";
import {
  type Jwk,
  type LinkTokenRequest,
  type PlaidAccount,
  type PlaidApi,
  type PlaidCredentials,
  PlaidError,
  type PlaidTransaction,
  type SyncPage,
  setPlaidFactory,
} from "../src/services/plaid-client.ts";
import { addMember, type Client, createOrg, createTestEnv, DB_MODE, login, type TestEnv } from "./harness.ts";

// ----------------------------------------------------------------------------- fake Plaid

type Event = { kind: "added" | "modified"; t: PlaidTransaction } | { kind: "removed"; id: string };

class FakeItem {
  events: Event[] = [];
  constructor(
    readonly itemId: string,
    readonly accessToken: string,
    readonly accounts: PlaidAccount[],
  ) {}
  add(t: Partial<PlaidTransaction> & { transaction_id: string; account_id: string; amount: number }) {
    this.events.push({
      kind: "added",
      t: { date: "2026-03-02", name: t.transaction_id.toUpperCase(), pending: false, ...t },
    });
  }
  modify(t: PlaidTransaction) {
    this.events.push({ kind: "modified", t });
  }
  remove(id: string) {
    this.events.push({ kind: "removed", id });
  }
}

class FakePlaid implements PlaidApi {
  items = new Map<string, FakeItem>();
  byPublic = new Map<string, FakeItem>();
  linkRequests: LinkTokenRequest[] = [];
  removed: string[] = [];
  creds: PlaidCredentials[] = [];
  pageSize = 2;
  failSync: PlaidError | null = null;
  mutateOnce = false;
  keys = new Map<string, Jwk>();

  newItem(accounts: PlaidAccount[]) {
    const n = this.items.size + 1;
    const item = new FakeItem(`item-${n}`, `access-sandbox-secret-${n}-${crypto.randomUUID()}`, accounts);
    this.items.set(item.accessToken, item);
    this.byPublic.set(`public-${n}`, item);
    return { item, publicToken: `public-${n}` };
  }
  private item(token: string) {
    const i = this.items.get(token);
    if (!i) throw new PlaidError("INVALID_ACCESS_TOKEN", "INVALID_INPUT", "bad token", 400);
    return i;
  }
  async linkTokenCreate(r: LinkTokenRequest) {
    this.linkRequests.push(r);
    return { link_token: `link-sandbox-${this.linkRequests.length}`, expiration: "2026-12-31T00:00:00Z" };
  }
  async exchangePublicToken(p: string) {
    const i = this.byPublic.get(p);
    if (!i) throw new PlaidError("INVALID_PUBLIC_TOKEN", "INVALID_INPUT", "bad public token", 400);
    return { access_token: i.accessToken, item_id: i.itemId };
  }
  async accountsGet(token: string) {
    return { accounts: this.item(token).accounts, institution_id: "ins_109508" };
  }
  async institutionName() {
    return "First Platypus Bank";
  }
  async transactionsSync(token: string, cursor: string | null): Promise<SyncPage> {
    const item = this.item(token);
    if (this.failSync) throw this.failSync;
    const start = cursor ? Number(cursor) : 0;
    if (this.mutateOnce && start > 0) {
      this.mutateOnce = false;
      throw new PlaidError(
        "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
        "TRANSACTIONS_ERROR",
        "mutated",
        400,
      );
    }
    const slice = item.events.slice(start, start + this.pageSize);
    const end = start + slice.length;
    return {
      added: slice.flatMap((e) => (e.kind === "added" ? [e.t] : [])),
      modified: slice.flatMap((e) => (e.kind === "modified" ? [e.t] : [])),
      removed: slice.flatMap((e) => (e.kind === "removed" ? [{ transaction_id: e.id }] : [])),
      next_cursor: String(end),
      has_more: end < item.events.length,
    };
  }
  async itemRemove(token: string) {
    this.removed.push(this.item(token).itemId);
  }
  async itemWebhookUpdate() {}
  async webhookVerificationKey(kid: string) {
    const k = this.keys.get(kid);
    if (!k) throw new PlaidError("INVALID_INPUT", "INVALID_INPUT", "unknown key", 400);
    return k;
  }
  /** Answer key checks the way Plaid does for a secret from the wrong environment. */
  rejectKeys = false;
  keyChecks: PlaidCredentials[] = [];
  async checkCredentials() {
    this.keyChecks.push(this.creds.at(-1)!);
    if (this.rejectKeys)
      throw new PlaidError("INVALID_API_KEYS", "INVALID_INPUT", "invalid client_id or secret provided", 400);
  }
  async sandboxPublicToken() {
    return "";
  }
  async sandboxResetLogin() {}
}

// ----------------------------------------------------------------------------- webhook signing

const b64url = (b: Uint8Array | string) =>
  Buffer.from(typeof b === "string" ? new TextEncoder().encode(b) : b)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

let signingKey: CryptoKey;

async function setupSigning(fake: FakePlaid) {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  signingKey = pair.privateKey;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Jwk;
  fake.keys.set("k1", { ...jwk, kid: "k1", alg: "ES256", use: "sig", expired_at: null });
}

async function sign(body: string, opts: { iat?: number; hash?: string; kid?: string } = {}) {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: opts.kid ?? "k1", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iat: opts.iat ?? Math.floor(Date.now() / 1000),
      request_body_sha256: opts.hash ?? sha256Hex(body),
    }),
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signingKey,
      new TextEncoder().encode(`${header}.${payload}`),
    ),
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

// ----------------------------------------------------------------------------- setup

let env: TestEnv;
let owner: Client;
let orgId: string;
let fake: FakePlaid;
let restore: () => void;
const base = () => `/api/v1/orgs/${orgId}`;

const ACCOUNTS: PlaidAccount[] = [
  { account_id: "acc-chk", name: "Plaid Checking", mask: "0000", type: "depository", subtype: "checking" },
  { account_id: "acc-sav", name: "Plaid Saving", mask: "1111", type: "depository", subtype: "savings" },
  { account_id: "acc-cc", name: "Plaid Credit Card", mask: "3333", type: "credit", subtype: "credit card" },
  { account_id: "acc-inv", name: "Plaid IRA", mask: "5555", type: "investment", subtype: "ira" },
];

async function txns(bankAccountId: string) {
  const r = await owner.json(
    "GET",
    `${base()}/bank-transactions?bank_account_id=${bankAccountId}&status=all`,
  );
  return r.body.data as any[];
}

async function bankAccountFor(connectionId: string, providerId: string) {
  const h = await env.ctx.orgs.mustOpen(orgId);
  return (
    await h.db.select().from(org.bankAccounts).where(eq(org.bankAccounts.connectionId, connectionId)).all()
  ).find((a) => a.providerAccountId === providerId)!;
}

beforeAll(async () => {
  env = await createTestEnv();
  fake = new FakePlaid();
  restore = setPlaidFactory((c) => {
    fake.creds.push(c);
    return fake;
  });
  await setupSigning(fake);
  owner = await login(env, "plaid-owner@example.com");
  orgId = await createOrg(env, owner, "Feeds Co");
});

afterAll(async () => {
  restore();
  await env.close();
});

// ----------------------------------------------------------------------------- tests

describe(`Plaid (${DB_MODE})`, () => {
  let connId: string;
  let item: FakeItem;
  let chk: string;

  test("sign conversion is exact", () => {
    expect(plaidCents(12.34)).toBe(-1234);
    expect(plaidCents(-4.35)).toBe(435);
    expect(plaidCents(0)).toBe(0);
    expect(plaidCents(1.1 + 2.2)).toBe(-330);
  });

  test("not configured: status says so and Link is refused", async () => {
    const s = await owner.json("GET", `${base()}/plaid`);
    expect(s.body).toMatchObject({ configured: false, env: null, webhooks: false });
    const r = await owner.json("POST", `${base()}/plaid/link-token`, {});
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("plaid_not_configured");
  });

  test("instance keys enable Link; only owners may connect", async () => {
    await env.ctx.settings.set("plaid", {
      enabled: true,
      env: "sandbox",
      client_id: "cid-instance",
      secret: "instance-secret-value",
    });
    const s = await owner.json("GET", `${base()}/plaid`);
    expect(s.body).toMatchObject({ configured: true, env: "sandbox", source: "instance", webhooks: false });
    expect(JSON.stringify(s.body)).not.toContain("instance-secret-value");

    const r = await owner.json("POST", `${base()}/plaid/link-token`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ link_token: "link-sandbox-1", update_mode: false });
    // No public HTTPS URL: no webhook registered, polling covers it.
    expect(fake.linkRequests[0]!.webhook).toBeNull();
    expect(fake.creds.at(-1)).toMatchObject({ clientId: "cid-instance", secret: "instance-secret-value" });

    const bk = await login(env, "plaid-bk@example.com");
    await addMember(env, orgId, bk.userId, "bookkeeper");
    const denied = await bk.json("POST", `${base()}/plaid/link-token`, {});
    expect(denied.status).toBe(403);
  });

  test("exchange creates bank and ledger accounts, encrypts the token, and runs the first sync", async () => {
    const n = fake.newItem(ACCOUNTS);
    item = n.item;
    item.add({
      transaction_id: "t1",
      account_id: "acc-chk",
      amount: 25.5,
      name: "COFFEE",
      merchant_name: "Blue Bottle",
    });
    item.add({ transaction_id: "t2", account_id: "acc-chk", amount: -1200, name: "CLIENT DEPOSIT" });
    item.add({
      transaction_id: "t3-pend",
      account_id: "acc-cc",
      amount: 80,
      name: "HARDWARE",
      pending: true,
    });
    item.add({ transaction_id: "t4", account_id: "acc-inv", amount: 5, name: "FEE" });

    const r = await owner.json("POST", `${base()}/plaid/exchange`, { public_token: n.publicToken });
    expect(r.status).toBe(201);
    connId = r.body.connection.id;
    expect(r.body.connection).toMatchObject({
      institution_name: "First Platypus Bank",
      status: "active",
      message: null,
    });
    expect(r.body.connection.accounts.map((a: any) => a.kind).sort()).toEqual([
      "checking",
      "credit_card",
      "savings",
    ]);
    expect(r.body.sync).toMatchObject({ added: 3, skipped: 1 });
    expect(JSON.stringify(r.body)).not.toContain(item.accessToken);

    const h = await env.ctx.orgs.mustOpen(orgId);
    const row = await h.db.select().from(org.bankConnections).where(eq(org.bankConnections.id, connId)).get();
    expect(row!.accessTokenEnc).not.toContain(item.accessToken);
    expect(env.ctx.secrets.reveal(row!.accessTokenEnc)).toBe(item.accessToken);
    expect(row!.syncCursor).toBe("4");

    const audit = await h.client.execute("select before_json, after_json from audit_log");
    expect(JSON.stringify(audit.rows)).not.toContain(item.accessToken);

    const accts = (await owner.json("GET", `${base()}/accounts`)).body.data as any[];
    const cc = await bankAccountFor(connId, "acc-cc");
    expect(accts.find((a) => a.id === cc.ledgerAccountId)).toMatchObject({
      type: "liability",
      subtype: "credit_card",
    });

    chk = (await bankAccountFor(connId, "acc-chk")).id;
    const rows = await txns(chk);
    const coffee = rows.find((t) => t.description === "COFFEE");
    expect(coffee).toMatchObject({ amount: -2550, payee: "Blue Bottle", status: "new", is_pending: false });
    expect(rows.find((t) => t.description === "CLIENT DEPOSIT").amount).toBe(120000);
  });

  test("the same bank login cannot be connected twice", async () => {
    fake.byPublic.set("public-dup", item);
    const r = await owner.json("POST", `${base()}/plaid/exchange`, { public_token: "public-dup" });
    expect(r.status).toBe(409);
  });

  test("pending transactions can't be categorized; posting replaces the pending row", async () => {
    const cc = (await bankAccountFor(connId, "acc-cc")).id;
    const pend = (await txns(cc))[0];
    expect(pend.is_pending).toBe(true);
    const acct =
      (await owner.json("GET", `${base()}/accounts`)).body.data.find((a: any) => a.code === "6000") ??
      (await owner.json("GET", `${base()}/accounts`)).body.data.find((a: any) => a.type === "expense");
    const cat = await owner.json("POST", `${base()}/bank-transactions/${pend.id}/categorize`, {
      splits: [{ account_id: acct.id, amount: 8000 }],
    });
    expect(cat.status).toBe(409);
    expect(cat.body.error.code).toBe("pending_transaction");

    item.remove("t3-pend");
    item.add({
      transaction_id: "t3",
      account_id: "acc-cc",
      amount: 82.1,
      name: "HARDWARE",
      pending_transaction_id: "t3-pend",
    });
    const s = await syncConnection(env.ctx, orgId, connId);
    expect(s).toMatchObject({ added: 1, removed: 1 });
    const rows = await txns(cc);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: -8210, is_pending: false, status: "new" });

    const ok = await owner.json("POST", `${base()}/bank-transactions/${rows[0].id}/categorize`, {
      splits: [{ account_id: acct.id, amount: 8210 }],
    });
    expect(ok.status).toBe(200);
  });

  test("modified updates unreviewed rows; changes to booked rows are kept and audited", async () => {
    item.modify({
      transaction_id: "t1",
      account_id: "acc-chk",
      amount: 26.75,
      date: "2026-03-03",
      name: "COFFEE",
      pending: false,
      merchant_name: "Blue Bottle",
    });
    let s = await syncConnection(env.ctx, orgId, connId);
    expect(s.modified).toBe(1);
    const coffee = (await txns(chk)).find((t) => t.description === "COFFEE");
    expect(coffee).toMatchObject({ amount: -2675, date: "2026-03-03" });

    // Book the deposit, then the bank edits and removes it.
    const dep = (await txns(chk)).find((t) => t.description === "CLIENT DEPOSIT");
    const income = (await owner.json("GET", `${base()}/accounts`)).body.data.find(
      (a: any) => a.code === "4000",
    );
    expect(
      (
        await owner.json("POST", `${base()}/bank-transactions/${dep.id}/categorize`, {
          splits: [{ account_id: income.id, amount: 120000 }],
        })
      ).status,
    ).toBe(200);
    item.modify({
      transaction_id: "t2",
      account_id: "acc-chk",
      amount: -1300,
      date: "2026-03-02",
      name: "CLIENT DEPOSIT",
      pending: false,
    });
    item.remove("t2");
    s = await syncConnection(env.ctx, orgId, connId);
    expect(s).toMatchObject({ modified: 0, removed: 0 });
    const kept = (await txns(chk)).find((t) => t.id === dep.id);
    expect(kept).toMatchObject({ amount: 120000, status: "categorized" });
    const h = await env.ctx.orgs.mustOpen(orgId);
    const audit = await h.client.execute({
      sql: "select action from audit_log where target_id = ? order by seq",
      args: [dep.id],
    });
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(["bank_txn.provider_modified", "bank_txn.provider_removed"]),
    );
  });

  test("syncing again is idempotent, and a replayed page creates no duplicates", async () => {
    const before = (await txns(chk)).length;
    expect(await syncConnection(env.ctx, orgId, connId)).toMatchObject({ added: 0, modified: 0, removed: 0 });
    const h = await env.ctx.orgs.mustOpen(orgId);
    await h.write((tx) =>
      tx.update(org.bankConnections).set({ syncCursor: null }).where(eq(org.bankConnections.id, connId)),
    );
    await syncConnection(env.ctx, orgId, connId);
    expect((await txns(chk)).length).toBe(before);
  });

  test("a mutation during pagination restarts from the original cursor", async () => {
    item.add({ transaction_id: "t6", account_id: "acc-chk", amount: 10, name: "LUNCH" });
    item.add({ transaction_id: "t7", account_id: "acc-chk", amount: 11, name: "DINNER" });
    item.add({ transaction_id: "t8", account_id: "acc-chk", amount: 12, name: "BREAKFAST" });
    const h = await env.ctx.orgs.mustOpen(orgId);
    const cur = (await h.db
      .select()
      .from(org.bankConnections)
      .where(eq(org.bankConnections.id, connId))
      .get())!.syncCursor;
    fake.mutateOnce = true;
    const s = await syncConnection(env.ctx, orgId, connId);
    expect(s.added).toBe(3);
    const after = (await h.db
      .select()
      .from(org.bankConnections)
      .where(eq(org.bankConnections.id, connId))
      .get())!;
    expect(Number(after.syncCursor)).toBe(Number(cur) + 3);
  });

  test("login required: needs_reauth, polling skips it, update-mode Link, then reconnected", async () => {
    fake.failSync = new PlaidError(
      "ITEM_LOGIN_REQUIRED",
      "ITEM_ERROR",
      "the login details have changed",
      400,
    );
    const r = await owner.json("POST", `${base()}/bank-connections/${connId}/sync`, {});
    expect(r.status).toBe(502);
    const c = (await owner.json("GET", `${base()}/bank-connections/${connId}`)).body;
    expect(c).toMatchObject({ status: "needs_reauth", error_code: "ITEM_LOGIN_REQUIRED" });
    expect(c.message).toContain("sign in again");

    const job = registeredJobs().find((j) => j.name === "plaid.sync")!;
    const run = await (env.ctx.services.scheduler as Scheduler).runJob(job, orgId);
    expect(run.status).toBe("ok");
    expect(run.detail).toContain("1 waiting on reconnect");

    const lt = await owner.json("POST", `${base()}/plaid/link-token`, { connection_id: connId });
    expect(lt.body.update_mode).toBe(true);
    expect(fake.linkRequests.at(-1)!.accessToken).toBe(item.accessToken);

    fake.failSync = null;
    item.add({ transaction_id: "t9", account_id: "acc-chk", amount: 9, name: "AFTER REAUTH" });
    const re = await owner.json("POST", `${base()}/bank-connections/${connId}/reconnected`, {});
    expect(re.status).toBe(200);
    expect(re.body.connection.status).toBe("active");
    expect(re.body.sync.added).toBe(1);
  });

  test("polling syncs active connections", async () => {
    item.add({ transaction_id: "t10", account_id: "acc-sav", amount: -50, name: "INTEREST" });
    const job = registeredJobs().find((j) => j.name === "plaid.sync")!;
    const run = await (env.ctx.services.scheduler as Scheduler).runJob(job, orgId);
    expect(run.status).toBe("ok");
    const sav = (await bankAccountFor(connId, "acc-sav")).id;
    expect((await txns(sav)).map((t) => t.description)).toContain("INTEREST");
  });

  test("webhooks: signature, body hash, and age are verified; sync and item errors are handled", async () => {
    clearWebhookKeys();
    const path = `/api/v1/webhooks/plaid/${orgId}`;
    const send = (body: string, sig?: string) =>
      env.app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", ...(sig ? { "plaid-verification": sig } : {}) },
        body,
      });

    const body = JSON.stringify({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: item.itemId,
    });
    expect((await send(body)).status).toBe(401);
    expect((await send(body, await sign(body, { hash: sha256Hex("something else") }))).status).toBe(401);
    expect((await send(body, await sign(body, { iat: Math.floor(Date.now() / 1000) - 600 }))).status).toBe(
      401,
    );
    expect((await send(body, await sign(body, { kid: "unknown" }))).status).toBe(401);
    const tampered = await sign(body);
    expect((await send(body.replace("SYNC", "SYNX"), tampered)).status).toBe(401);

    item.add({ transaction_id: "t11", account_id: "acc-chk", amount: 7, name: "VIA WEBHOOK" });
    const ok = await send(body, await sign(body));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ received: true, action: "sync" });
    await syncConnection(env.ctx, orgId, connId); // joins or follows the webhook's sync
    expect((await txns(chk)).map((t) => t.description)).toContain("VIA WEBHOOK");

    const errBody = JSON.stringify({
      webhook_type: "ITEM",
      webhook_code: "ERROR",
      item_id: item.itemId,
      error: { error_code: "ITEM_LOGIN_REQUIRED" },
    });
    const res = await handleWebhook(env.ctx, orgId, errBody, await sign(errBody));
    expect(res.action).toBe("status");
    expect((await owner.json("GET", `${base()}/bank-connections/${connId}`)).body.status).toBe(
      "needs_reauth",
    );

    const repaired = JSON.stringify({
      webhook_type: "ITEM",
      webhook_code: "LOGIN_REPAIRED",
      item_id: item.itemId,
    });
    const rep = await handleWebhook(env.ctx, orgId, repaired, await sign(repaired));
    await rep.done;
    expect((await owner.json("GET", `${base()}/bank-connections/${connId}`)).body.status).toBe("active");

    const unknown = JSON.stringify({
      webhook_type: "TRANSACTIONS",
      webhook_code: "SYNC_UPDATES_AVAILABLE",
      item_id: "nope",
    });
    expect((await (await send(unknown, await sign(unknown))).json()).action).toBe("ignored");
  });

  test("an HTTPS public URL registers the webhook on Link", async () => {
    await env.ctx.settings.set("plaid", { webhook_url: "https://books.example.com/" });
    await owner.json("POST", `${base()}/plaid/link-token`, {});
    expect(fake.linkRequests.at(-1)!.webhook).toBe(
      `https://books.example.com/api/v1/webhooks/plaid/${orgId}`,
    );
    expect((await owner.json("GET", `${base()}/plaid`)).body.webhooks).toBe(true);
    await env.ctx.settings.set("plaid", { webhook_url: "" });
  });

  test("linking a statement-imported account skips feed rows up to the last imported date", async () => {
    const ba = await owner.json("POST", `${base()}/bank-accounts`, {
      name: "Old checking",
      kind: "checking",
    });
    const csv = "Date,Description,Amount\n2026-03-01,RENT,-1500.00\n2026-03-05,SALE,200.00\n";
    const imp = await owner.json("POST", `${base()}/bank-accounts/${ba.body.id}/import`, {
      filename: "mar.csv",
      content: csv,
    });
    expect(imp.body.imported).toBe(2);

    const n = fake.newItem([
      { account_id: "old-chk", name: "Checking", mask: "9999", type: "depository", subtype: "checking" },
    ]);
    n.item.add({
      transaction_id: "o1",
      account_id: "old-chk",
      amount: 1500,
      date: "2026-03-01",
      name: "RENT",
    });
    n.item.add({
      transaction_id: "o2",
      account_id: "old-chk",
      amount: -200,
      date: "2026-03-05",
      name: "SALE",
    });
    n.item.add({
      transaction_id: "o3",
      account_id: "old-chk",
      amount: 40,
      date: "2026-03-06",
      name: "NEW STUFF",
    });
    const r = await owner.json("POST", `${base()}/plaid/exchange`, {
      public_token: n.publicToken,
      accounts: [{ account_id: "old-chk", action: "link", bank_account_id: ba.body.id }],
    });
    expect(r.status).toBe(201);
    expect(r.body.sync).toMatchObject({ added: 1, skipped: 2 });
    expect((await txns(ba.body.id)).map((t) => t.description).sort()).toEqual(["NEW STUFF", "RENT", "SALE"]);
  });

  test("org-level keys override instance keys and are never returned", async () => {
    const r = await owner.json("PATCH", base(), {
      plaid: { env: "production", client_id: "cid-org", secret: "org-secret-value" },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ plaid_override: true, plaid_env: "production" });
    expect(JSON.stringify(r.body)).not.toContain("org-secret-value");
    expect((await owner.json("GET", `${base()}/plaid`)).body).toMatchObject({
      source: "org",
      env: "production",
    });
    await owner.json("POST", `${base()}/plaid/link-token`, {});
    expect(fake.creds.at(-1)).toMatchObject({
      env: "production",
      clientId: "cid-org",
      secret: "org-secret-value",
    });
    const h = await env.ctx.orgs.mustOpen(orgId);
    const s = await h.db.select().from(org.orgSettings).get();
    expect(s!.plaidSecretEnc).not.toContain("org-secret-value");
    const audit = await h.client.execute("select before_json, after_json from audit_log");
    expect(JSON.stringify(audit.rows)).not.toContain("org-secret-value");
    await owner.json("PATCH", base(), { plaid: null });
    expect((await owner.json("GET", `${base()}/plaid`)).body.source).toBe("instance");
  });

  test("disconnect removes the item at Plaid and forgets the token; history stays", async () => {
    const before = (await txns(chk)).length;
    const r = await owner.json("DELETE", `${base()}/bank-connections/${connId}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "disconnected" });
    expect(fake.removed).toContain(item.itemId);
    const h = await env.ctx.orgs.mustOpen(orgId);
    const row = await h.db.select().from(org.bankConnections).where(eq(org.bankConnections.id, connId)).get();
    expect(row!.accessTokenEnc).toBe("");
    expect((await txns(chk)).length).toBe(before);
    expect((await owner.json("POST", `${base()}/bank-connections/${connId}/sync`, {})).status).toBe(409);
    // The bank login can be connected again afterwards.
    fake.byPublic.set("public-again", item);
    expect(
      (
        await owner.json("POST", `${base()}/plaid/exchange`, {
          public_token: "public-again",
          accounts: ACCOUNTS.map((a) => ({ account_id: a.account_id, action: "skip" })),
        })
      ).status,
    ).toBe(201);
  });
});

describe(`Plaid key checks on save (${DB_MODE})`, () => {
  test("org keys are checked with Plaid and a rejection names the environment; nothing is saved", async () => {
    fake.rejectKeys = true;
    const r = await owner.json("PATCH", base(), {
      plaid: { env: "sandbox", client_id: "cid-wrong", secret: "production-secret-value" },
    });
    fake.rejectKeys = false;
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("plaid_keys_rejected");
    expect(r.body.error.message).toContain("rejected these keys for Sandbox");
    expect(r.body.error.message).toContain("Production");
    expect(JSON.stringify(r.body)).not.toContain("production-secret-value");
    expect(fake.keyChecks.at(-1)).toMatchObject({ env: "sandbox", clientId: "cid-wrong" });
    expect((await owner.json("GET", base())).body.settings.plaid_override).toBe(false);
  });

  test("instance keys are trimmed, checked when they change, and rejected keys save nothing", async () => {
    const admin = await login(env, "plaid-admin@example.com", { admin: true });
    const ok = await admin.json("PATCH", "/api/v1/admin/settings", {
      plaid: { enabled: true, env: "sandbox", client_id: "  cid-pasted\n", secret: " pasted-secret \n" },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.plaid.client_id).toBe("cid-pasted");
    expect(fake.keyChecks.at(-1)).toMatchObject({ clientId: "cid-pasted", secret: "pasted-secret" });
    expect((await env.ctx.settings.get("plaid")).secret).toBe("pasted-secret");

    // Saving the form again with the same keys (as the admin page does for any change) doesn't call Plaid.
    const checks = fake.keyChecks.length;
    const same = await admin.json("PATCH", "/api/v1/admin/settings", {
      signup_mode: "single_user",
      plaid: { enabled: true, env: "sandbox", client_id: "cid-pasted" },
    });
    expect(same.status).toBe(200);
    expect(fake.keyChecks.length).toBe(checks);

    fake.rejectKeys = true;
    const bad = await admin.json("PATCH", "/api/v1/admin/settings", {
      dynamic_client_registration: false,
      plaid: { env: "production" },
    });
    fake.rejectKeys = false;
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toContain("rejected these keys for Production");
    const after = await admin.json("GET", "/api/v1/admin/settings");
    expect(after.body).toMatchObject({ dynamic_client_registration: true, plaid: { env: "sandbox" } });
  });
});
