/**
 * OAuth 2.1 (SPEC §10.4) and MCP (SPEC §10.2). OAuth: dynamic registration, PKCE code flow,
 * refresh rotation, revocation, role capping, org scoping, redirect validation. MCP: writes land in
 * the review queue and don't affect reports, an MCP client cannot approve, notes and resources.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { newId, org } from "@cosimo/db";
import {
  addMember,
  anon,
  type Client,
  createOrg,
  createTestEnv,
  login,
  type TestEnv,
  tokenClient,
} from "./harness.ts";

let env: TestEnv;
let owner: Client;
let viewer: Client;
let admin: Client;
let orgId: string;
let otherOrg: string;
const REDIRECT = "https://client.example.com/callback";

const b64url = (b: Buffer) => b.toString("base64url");
function pkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

async function raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body instanceof URLSearchParams) {
    (init.headers as Record<string, string>)["content-type"] = "application/x-www-form-urlencoded";
    init.body = body.toString();
  } else if (body !== undefined) {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await env.app.request(path, init);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, body: json, text };
}

async function register(name = "Test AI", uris = [REDIRECT]) {
  const r = await raw("POST", "/oauth/register", { client_name: name, redirect_uris: uris });
  expect(r.status).toBe(201);
  return r.body.client_id as string;
}

/** Full authorization-code flow as `user`, returning tokens. */
async function authorize(user: Client, clientId: string, org = orgId, role = "bookkeeper") {
  const { verifier, challenge } = pkce();
  const q = {
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource: `${env.config.server.public_url}/mcp`,
  };
  const start = await raw("GET", `/oauth/authorize?${new URLSearchParams(q)}`);
  expect(start.status).toBe(302);
  expect(start.headers.get("location")).toStartWith("/connect?");
  const consent = await user.json("POST", "/api/v1/oauth/consent", {
    ...q,
    approve: true,
    org_id: org,
    role,
  });
  expect(consent.status).toBe(200);
  const back = new URL(consent.body.redirect_to);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get("state")).toBe("xyz");
  const code = back.searchParams.get("code")!;
  const tok = await raw(
    "POST",
    "/oauth/token",
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    }),
  );
  return { tok, code, verifier };
}

async function mcp(
  token: string | null,
  method: string,
  params: Record<string, unknown> = {},
  id: number | null = 1,
) {
  const headers: Record<string, string> = { accept: "application/json, text/event-stream" };
  if (token) headers.authorization = `Bearer ${token}`;
  return raw("POST", "/mcp", { jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }, headers);
}

async function call(token: string, name: string, args: Record<string, unknown>) {
  const r = await mcp(token, "tools/call", { name, arguments: args });
  expect(r.status).toBe(200);
  return r.body.result as { isError: boolean; structuredContent?: any; content: { text: string }[] };
}

beforeAll(async () => {
  env = await createTestEnv();
  admin = await login(env, "admin@example.com", { admin: true });
  owner = await login(env, "owner@example.com");
  viewer = await login(env, "viewer@example.com");
  orgId = await createOrg(env, owner, "Acme LLC");
  otherOrg = await createOrg(env, owner, "Other Co");
  await addMember(env, orgId, viewer.userId, "viewer");
});
afterAll(() => env.close());

describe("OAuth 2.1", () => {
  test("metadata at the well-known paths", async () => {
    const pr = await raw("GET", "/.well-known/oauth-protected-resource/mcp");
    expect(pr.body.resource).toBe(`${env.config.server.public_url}/mcp`);
    expect(pr.body.authorization_servers).toEqual([env.config.server.public_url]);
    const as = await raw("GET", "/.well-known/oauth-authorization-server");
    expect(as.body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.body.registration_endpoint).toBe(`${env.config.server.public_url}/oauth/register`);
    expect(as.body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
  });

  test("dynamic registration validates redirect URIs", async () => {
    expect(
      (await raw("POST", "/oauth/register", { redirect_uris: ["http://evil.example.com/cb"] })).status,
    ).toBe(400);
    expect(
      (await raw("POST", "/oauth/register", { redirect_uris: ["https://x.example.com/cb#frag"] })).status,
    ).toBe(400);
    expect(
      (await raw("POST", "/oauth/register", { redirect_uris: ["http://127.0.0.1:3000/cb"] })).status,
    ).toBe(201);
    expect(
      (
        await raw("POST", "/oauth/register", {
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: "client_secret_basic",
        })
      ).status,
    ).toBe(201);
    const jwt = await raw("POST", "/oauth/register", {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "private_key_jwt",
    });
    expect(jwt.status).toBe(400);
    expect(jwt.body.error).toBe("invalid_client_metadata");
    const implicit = await raw("POST", "/oauth/register", {
      redirect_uris: [REDIRECT],
      response_types: ["token"],
    });
    expect(implicit.status).toBe(400);
    expect(implicit.body.error).toBe("invalid_client_metadata");
  });

  test("code flow with PKCE, refresh rotation, and revocation", async () => {
    const clientId = await register();
    const { tok, code, verifier } = await authorize(owner, clientId);
    expect(tok.status).toBe(200);
    expect(tok.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "books" });
    expect(tok.body.access_token).toStartWith("cosimo_oat_");

    // The access token works against the org's API, as a propose-only bookkeeper.
    const api = tokenClient(env, tok.body.access_token);
    expect((await api.json("GET", `/api/v1/orgs/${orgId}/accounts`)).status).toBe(200);
    // …and only for the granted org.
    expect((await api.json("GET", `/api/v1/orgs/${otherOrg}/accounts`)).status).toBe(403);

    // Codes are single-use; replay also revokes what the code produced.
    const replay = await raw(
      "POST",
      "/oauth/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
      }),
    );
    expect(replay.body.error).toBe("invalid_grant");
    expect((await api.json("GET", `/api/v1/orgs/${orgId}/accounts`)).status).toBe(401);

    // Fresh grant; rotate the refresh token.
    const g = (await authorize(owner, clientId)).tok.body;
    const r1 = await raw(
      "POST",
      "/oauth/token",
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: g.refresh_token,
        client_id: clientId,
      }),
    );
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(g.refresh_token);
    const reuse = await raw(
      "POST",
      "/oauth/token",
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: g.refresh_token,
        client_id: clientId,
      }),
    );
    expect(reuse.body.error).toBe("invalid_grant");
    // The old access token died with the rotation; the new one works.
    expect(
      (await tokenClient(env, g.access_token).json("GET", `/api/v1/orgs/${orgId}/accounts`)).status,
    ).toBe(401);
    expect(
      (await tokenClient(env, r1.body.access_token).json("GET", `/api/v1/orgs/${orgId}/accounts`)).status,
    ).toBe(200);

    // Revocation (RFC 7009).
    expect(
      (
        await raw(
          "POST",
          "/oauth/revoke",
          new URLSearchParams({ token: r1.body.refresh_token, client_id: clientId }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await tokenClient(env, r1.body.access_token).json("GET", `/api/v1/orgs/${orgId}/accounts`)).status,
    ).toBe(401);
  });

  test("dynamic registration with claude.ai's metadata registers a confidential client and completes the code flow", async () => {
    const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
    const reg = await raw("POST", "/oauth/register", {
      client_name: "Claude",
      redirect_uris: [CLAUDE],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    });
    expect(reg.status).toBe(201);
    expect(reg.body.client_secret).toStartWith("cosimo_ocs_");
    expect(reg.body.client_secret_expires_at).toBe(0);
    expect(reg.body.token_endpoint_auth_method).toBe("client_secret_post");
    const { client_id: clientId, client_secret: secret } = reg.body as {
      client_id: string;
      client_secret: string;
    };

    const { verifier, challenge } = pkce();
    const q = {
      client_id: clientId,
      redirect_uri: CLAUDE,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz",
      resource: `${env.config.server.public_url}/mcp`,
    };
    const start = await raw("GET", `/oauth/authorize?${new URLSearchParams(q)}`);
    expect(start.status).toBe(302);
    expect(start.headers.get("location")).toStartWith("/connect?");
    const consent = await owner.json("POST", "/api/v1/oauth/consent", { ...q, approve: true, org_id: orgId });
    expect(consent.status).toBe(200);
    const back = new URL(consent.body.redirect_to);
    expect(back.origin + back.pathname).toBe(CLAUDE);
    const form = {
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      redirect_uri: CLAUDE,
      client_id: clientId,
      code_verifier: verifier,
    };

    // The secret issued at registration is enforced at the token endpoint.
    const noSecret = await raw("POST", "/oauth/token", new URLSearchParams(form));
    expect(noSecret.status).toBe(401);
    expect(noSecret.body.error).toBe("invalid_client");
    const tok = await raw("POST", "/oauth/token", new URLSearchParams({ ...form, client_secret: secret }));
    expect(tok.status).toBe(200);
    expect(tok.body.access_token).toStartWith("cosimo_oat_");

    // Either secret method works for any confidential client: refresh with Basic auth.
    const basic = Buffer.from(`${clientId}:${secret}`).toString("base64");
    const refreshed = await raw(
      "POST",
      "/oauth/token",
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.body.refresh_token }),
      { authorization: `Basic ${basic}` },
    );
    expect(refreshed.status).toBe(200);

    const list = await admin.json("GET", "/api/v1/admin/oauth-clients");
    expect(list.status).toBe(200);
    expect(list.body.data.find((x: { client_id: string }) => x.client_id === clientId)).toMatchObject({
      client_name: "Claude",
      redirect_uris: [CLAUDE],
      registered_via: "dynamic",
      confidential: true,
    });
  });

  test("PKCE and redirect mismatches are rejected", async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const base = {
      client_id: clientId,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    // Mismatched redirect: an error page, never a redirect to the unverified URI.
    const bad = await raw(
      "GET",
      `/oauth/authorize?${new URLSearchParams({ ...base, redirect_uri: "https://attacker.example/cb" })}`,
    );
    expect(bad.status).toBe(400);
    expect(bad.headers.get("location")).toBeNull();
    // Missing PKCE: error back to the (verified) redirect URI.
    const noPkce = await raw(
      "GET",
      `/oauth/authorize?${new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: REDIRECT, state: "s" })}`,
    );
    expect(noPkce.status).toBe(302);
    expect(noPkce.headers.get("location")).toContain("error=invalid_request");
    // Plain method is not allowed.
    const plain = await raw(
      "GET",
      `/oauth/authorize?${new URLSearchParams({ ...base, redirect_uri: REDIRECT, code_challenge_method: "plain" })}`,
    );
    expect(plain.headers.get("location")).toContain("error=invalid_request");
    // Wrong verifier.
    const { tok } = await authorize(owner, clientId).then(async (x) => x);
    expect(tok.status).toBe(200);
    const q = { ...base, redirect_uri: REDIRECT };
    const consent = await owner.json("POST", "/api/v1/oauth/consent", { ...q, approve: true, org_id: orgId });
    const code = new URL(consent.body.redirect_to).searchParams.get("code")!;
    const wrong = await raw(
      "POST",
      "/oauth/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: pkce().verifier,
      }),
    );
    expect(wrong.body.error).toBe("invalid_grant");
    // Denying consent returns access_denied.
    const deny = await owner.json("POST", "/api/v1/oauth/consent", { ...q, approve: false });
    expect(deny.body.redirect_to).toContain("error=access_denied");
  });

  test("the granted role is capped at the user's own role", async () => {
    const clientId = await register();
    const info = await viewer.json(
      "GET",
      `/api/v1/oauth/consent?${new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: "code", code_challenge: pkce().challenge, code_challenge_method: "S256" })}`,
    );
    expect(info.body.orgs).toEqual([
      expect.objectContaining({ id: orgId, role: "viewer", grantable_roles: ["viewer"] }),
    ]);
    const { tok } = await authorize(viewer, clientId, orgId, "owner");
    const t = tok.body.access_token;
    const r = await call(t, "list_orgs", {});
    expect(r.structuredContent.orgs[0].role).toBe("viewer");
    const w = await call(t, "append_note", { note: "Viewer should not write" });
    expect(w.isError).toBe(true);
    // Consent for an org the user doesn't belong to fails.
    const q = {
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    };
    expect(
      (await viewer.json("POST", "/api/v1/oauth/consent", { ...q, approve: true, org_id: otherOrg })).status,
    ).toBe(403);
  });

  test("connections are listed and revocable; owners see their org's clients", async () => {
    const clientId = await register("Connections AI");
    const { tok } = await authorize(viewer, clientId);
    const mine = await viewer.json("GET", "/api/v1/oauth/connections");
    const c = mine.body.data.find((x: any) => x.client_id === clientId);
    expect(c).toMatchObject({ client_name: "Connections AI", org_id: orgId, role: "viewer" });
    const orgView = await owner.json("GET", `/api/v1/orgs/${orgId}/oauth/connections`);
    expect(orgView.body.data.some((x: any) => x.id === c.id)).toBe(true);
    expect((await viewer.json("GET", `/api/v1/orgs/${orgId}/oauth/connections`)).status).toBe(403);
    // The org owner can disconnect someone else's client.
    expect((await owner.json("DELETE", `/api/v1/oauth/connections/${c.id}`)).status).toBe(200);
    expect((await mcp(tok.body.access_token, "ping")).status).toBe(401);
  });

  test("admins can turn off dynamic registration and register clients manually", async () => {
    await admin.json("PATCH", "/api/v1/admin/settings", { dynamic_client_registration: false });
    expect((await raw("POST", "/oauth/register", { redirect_uris: [REDIRECT] })).status).toBe(403);
    expect(
      (await raw("GET", "/.well-known/oauth-authorization-server")).body.registration_endpoint,
    ).toBeUndefined();
    const m = await admin.json("POST", "/api/v1/admin/oauth-clients", {
      client_name: "Manual",
      redirect_uris: [REDIRECT],
    });
    expect(m.status).toBe(201);
    expect(m.body.client_secret).toStartWith("cosimo_ocs_");
    expect(
      (
        await owner.json("POST", "/api/v1/admin/oauth-clients", {
          client_name: "x",
          redirect_uris: [REDIRECT],
        })
      ).status,
    ).toBe(403);
    await admin.json("PATCH", "/api/v1/admin/settings", { dynamic_client_registration: true });

    // A confidential client must authenticate at the token endpoint.
    const { verifier, challenge } = pkce();
    const q = {
      client_id: m.body.client_id,
      redirect_uri: REDIRECT,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
    };
    const consent = await owner.json("POST", "/api/v1/oauth/consent", { ...q, approve: true, org_id: orgId });
    const code = new URL(consent.body.redirect_to).searchParams.get("code")!;
    const form = {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: m.body.client_id,
      code_verifier: verifier,
    };
    const noSecret = await raw("POST", "/oauth/token", new URLSearchParams(form));
    expect(noSecret.status).toBe(401);
    expect(noSecret.body.error).toBe("invalid_client");
    const basic = Buffer.from(`${m.body.client_id}:${m.body.client_secret}`).toString("base64");
    const ok = await raw("POST", "/oauth/token", new URLSearchParams(form), {
      authorization: `Basic ${basic}`,
    });
    expect(ok.status).toBe(200);
    // Revoking the client kills its tokens.
    await admin.json("DELETE", `/api/v1/admin/oauth-clients/${m.body.client_id}`);
    expect((await mcp(ok.body.access_token, "ping")).status).toBe(401);
  });
});

describe("MCP", () => {
  let token: string;

  beforeAll(async () => {
    token = (await authorize(owner, await register("Claude"))).tok.body.access_token;
  });

  test("unauthenticated requests get a discoverable 401", async () => {
    const r = await mcp(null, "initialize", { protocolVersion: "2025-06-18" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(
      `resource_metadata="${env.config.server.public_url}/.well-known/oauth-protected-resource/mcp"`,
    );
    // A browser session is not enough.
    const s = await env.app.request("/mcp", {
      method: "POST",
      headers: { cookie: owner.cookie!, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(s.status).toBe(401);
    // Foreign origins are refused.
    const o = await raw(
      "POST",
      "/mcp",
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { authorization: `Bearer ${token}`, origin: "https://evil.example" },
    );
    expect(o.status).toBe(403);
  });

  test("initialize, tools, and resources", async () => {
    const init = await mcp(token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.body.result.protocolVersion).toBe("2025-06-18");
    expect(init.body.result.serverInfo.name).toBe("cosimo");
    expect((await mcp(token, "notifications/initialized", {}, null)).status).toBe(202);
    const tools = (await mcp(token, "tools/list")).body.result.tools as { name: string; inputSchema: any }[];
    const names = tools.map((t) => t.name);
    for (const n of [
      "list_orgs",
      "get_account_balances",
      "run_report",
      "list_uncategorized_transactions",
      "categorize_transaction",
      "create_rule",
      "search_transactions",
      "get_entry",
      "create_manual_entry",
      "list_invoices",
      "create_invoice_draft",
      "list_pending_reviews",
      "get_review_item",
      "append_note",
    ])
      expect(names).toContain(n);
    for (const forbidden of ["approve", "reject", "void", "reverse", "delete", "lock"])
      expect(names.some((n) => n.includes(forbidden))).toBe(false);
    const entryTool = tools.find((t) => t.name === "create_manual_entry")!;
    expect(entryTool.inputSchema.required).toContain("rationale");

    const res = (await mcp(token, "resources/list")).body.result.resources.map((r: any) => r.uri);
    expect(res).toEqual(["org://profile", "org://notes"]);
    expect((await mcp(token, "nope")).body.error.code).toBe(-32601);
  });

  test("writes land in the review queue, don't affect reports, and can't be self-approved", async () => {
    const before = await owner.json("GET", `/api/v1/orgs/${orgId}/reports/trial_balance?as_of=2026-12-31`);
    const missing = await call(token, "create_manual_entry", {
      date: "2026-03-31",
      lines: [
        { account: "1000", amount: 5000 },
        { account: "3100", amount: -5000 },
      ],
    });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain("rationale");

    const r = await call(token, "create_manual_entry", {
      date: "2026-03-31",
      memo: "Owner contribution",
      lines: [
        { account: "1000", amount: 5000 },
        { account: "3100", amount: -5000 },
      ],
      rationale: "Deposit from the owner's personal account",
    });
    expect(r.isError).toBe(false);
    expect(r.structuredContent.status).toBe("pending_review");
    const reviewId = r.structuredContent.review_item_id as string;

    const after = await owner.json("GET", `/api/v1/orgs/${orgId}/reports/trial_balance?as_of=2026-12-31`);
    expect(before.body.lines.length).toBeGreaterThan(0);
    expect(after.body.lines).toEqual(before.body.lines);

    const pending = await call(token, "list_pending_reviews", {});
    const item = pending.structuredContent.data.find((x: any) => x.id === reviewId);
    expect(item).toMatchObject({
      proposed_by_actor: "mcp",
      rationale: "Deposit from the owner's personal account",
    });

    // The same OAuth token can't approve through the REST API either.
    const self = await tokenClient(env, token).json(
      "POST",
      `/api/v1/orgs/${orgId}/review/${reviewId}/approve`,
      {},
    );
    expect(self.status).toBe(403);

    // A person approves; the entry posts.
    expect((await owner.json("POST", `/api/v1/orgs/${orgId}/review/${reviewId}/approve`, {})).status).toBe(
      200,
    );
    const got = await call(token, "get_review_item", { review_item_id: reviewId });
    expect(got.structuredContent.status).toBe("approved");
    const entry = await call(token, "get_entry", { entry_id: r.structuredContent.entry_id });
    expect(entry.structuredContent.status).toBe("posted");
  });

  test("categorize a bank transaction and propose a rule", async () => {
    const ba = (
      await owner.json("POST", `/api/v1/orgs/${orgId}/bank-accounts`, { name: "Checking", kind: "checking" })
    ).body;
    await owner.json("POST", `/api/v1/orgs/${orgId}/bank-accounts/${ba.id}/import`, {
      filename: "m.csv",
      content: "Date,Description,Amount\n2026-04-02,ADOBE CREATIVE CLOUD,-54.99\n",
    });
    // A transaction still pending at the bank is left out, and reported separately as `pending`.
    const h = await env.ctx.orgs.mustOpen(orgId);
    const pendingId = newId();
    await h.write((tx) =>
      tx.insert(org.bankTransactions).values({
        id: pendingId,
        bankAccountId: ba.id,
        date: "2026-04-03",
        amount: -1200,
        description: "PENDING CHARGE",
        normalizedDescription: "PENDING CHARGE",
        isPending: true,
        dedupeHash: `pending-${pendingId}`,
      }),
    );
    const list = await call(token, "list_uncategorized_transactions", {});
    expect(list.structuredContent.data).toHaveLength(1);
    const txn = list.structuredContent.data[0];
    expect(txn.description).toContain("ADOBE");
    expect(list.structuredContent.pending).toEqual({ count: 1, total: -1200 });
    const expense = (await call(token, "get_account_balances", {})).structuredContent.accounts.find(
      (a: any) => a.type === "expense" && a.subtype !== "uncategorized",
    );
    const cat = await call(token, "categorize_transaction", {
      transaction_id: txn.id,
      splits: [{ account: expense.code }],
      rationale: "Software subscription",
    });
    expect(cat.structuredContent.status).toBe("pending_review");
    const rule = await call(token, "create_rule", {
      name: "Adobe",
      conditions: { description_contains: "ADOBE" },
      actions: { account: expense.code },
      rationale: "Adobe is always software",
    });
    expect(rule.structuredContent.status).toBe("pending_review");
  });

  test("invoice drafts go to review; approval finalizes, rejection deletes", async () => {
    const cust = await owner.json("POST", `/api/v1/orgs/${orgId}/contacts`, {
      kind: "customer",
      name: "Globex",
    });
    const draft = async () =>
      call(token, "create_invoice_draft", {
        customer_id: cust.body.id,
        issue_date: "2026-05-01",
        lines: [{ description: "Consulting", quantity: 10, unit_price: 15000, account: "4000" }],
        rationale: "April consulting hours from the timesheet",
      });
    const a = await draft();
    expect(a.structuredContent).toMatchObject({ status: "pending_review", total: 150000 });
    const inv = await owner.json("GET", `/api/v1/orgs/${orgId}/invoices/${a.structuredContent.invoice_id}`);
    expect(inv.body.status).toBe("draft");
    await owner.json(
      "POST",
      `/api/v1/orgs/${orgId}/review/${a.structuredContent.review_item_id}/approve`,
      {},
    );
    const done = await owner.json("GET", `/api/v1/orgs/${orgId}/invoices/${a.structuredContent.invoice_id}`);
    expect(done.body.status).toBe("sent");

    const b = await draft();
    await owner.json("POST", `/api/v1/orgs/${orgId}/review/${b.structuredContent.review_item_id}/reject`, {
      note: "no",
    });
    expect(
      (await owner.json("GET", `/api/v1/orgs/${orgId}/invoices/${b.structuredContent.invoice_id}`)).status,
    ).toBe(404);
  });

  test("append_note and the profile/notes resources", async () => {
    await owner.json("PUT", `/api/v1/orgs/${orgId}/profile`, {
      description: "Design studio",
      recurring: [{ item: "Adobe", account_code: "4000" }],
    });
    const n = await call(token, "append_note", {
      note: "Payments from Acme are retainer billing, account 4000.",
    });
    expect(n.isError).toBe(false);
    const secret = await call(token, "append_note", { note: "Bank login password: hunter2hunter2" });
    expect(secret.isError).toBe(true);
    const notes = await mcp(token, "resources/read", { uri: "org://notes" });
    expect(notes.body.result.contents[0].text).toContain("retainer billing");
    expect(notes.body.result.contents[0].text).toContain("AI assistant");
    const profile = await mcp(token, "resources/read", { uri: "org://profile" });
    expect(profile.body.result.contents[0].text).toContain("Design studio");
    const list = await owner.json("GET", `/api/v1/orgs/${orgId}/notes`);
    expect(list.body.data[0]).toMatchObject({ author_actor: "mcp" });
  });

  test("API tokens also work over MCP, as the mcp actor", async () => {
    const t = await owner.json("POST", "/api/v1/tokens", {
      org_id: orgId,
      name: "script",
      role: "bookkeeper",
    });
    const r = await call(t.body.token, "create_manual_entry", {
      date: "2026-06-30",
      lines: [
        { account: "1000", amount: 100 },
        { account: "3100", amount: -100 },
      ],
      rationale: "Test",
    });
    expect(r.structuredContent.status).toBe("pending_review");
    expect((await anon(env).json("GET", `/api/v1/orgs/${orgId}/accounts`)).status).toBe(401);
  });
});
