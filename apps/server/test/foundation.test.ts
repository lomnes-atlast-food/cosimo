import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { auditGenesis, auditHash, verifyChain } from "@cosimo/core";
import { org } from "@cosimo/db";
import { asc } from "drizzle-orm";
import * as OTPAuth from "otpauth";
import { SecretBox } from "../src/crypto.ts";
import {
  addMember,
  anon,
  createOrg,
  createTestEnv,
  DB_MODE,
  login,
  PASSWORD,
  type TestEnv,
  tokenClient,
} from "./harness.ts";

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

describe(`foundation (${DB_MODE})`, () => {
  test("health and readiness", async () => {
    const h = await env.app.request("/healthz");
    expect(h.status).toBe(200);
    const r = await env.app.request("/readyz");
    expect(r.status).toBe(200);
    expect((await r.json()).status).toBe("ready");
  });

  test("security headers", async () => {
    const res = await env.app.request("/api/v1/auth/session");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  test("anonymous session view reports setup state", async () => {
    const r = await anon(env).json("GET", "/api/v1/auth/session");
    expect(r.status).toBe(200);
    expect(r.body.user).toBeNull();
  });

  test("login rejects wrong password and accepts the right one", async () => {
    await env.ctx.users.create({ email: "pw@example.com", password: PASSWORD });
    const bad = await anon(env).json("POST", "/api/v1/auth/login", {
      email: "pw@example.com",
      password: "nope-nope-nope",
    });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("invalid_credentials");
    const c = await login(env, "pw@example.com");
    const s = await c.json("GET", "/api/v1/auth/session");
    expect(s.body.user.email).toBe("pw@example.com");
    expect(s.body.csrf_token).toBe(c.csrf);
  });

  test("CSRF is required for cookie-authenticated writes", async () => {
    const c = await login(env, "csrf@example.com");
    const noCsrf = await env.app.request("/api/v1/orgs", {
      method: "POST",
      headers: { cookie: c.cookie!, "content-type": "application/json" },
      body: JSON.stringify({ name: "X" }),
    });
    expect(noCsrf.status).toBe(403);
    expect((await noCsrf.json()).error.code).toBe("csrf_failed");
    const ok = await c.json("POST", "/api/v1/orgs", { name: "X" });
    expect(ok.status).toBe(201);
  });

  test("claim link sets the password once and signs in", async () => {
    const u = await env.ctx.users.create({
      email: "claim@example.com",
      name: "Claimer",
      isInstanceAdmin: true,
    });
    const { token } = await env.ctx.users.issueClaimLink(u.id);
    const a = anon(env);
    const peek = await a.json("GET", `/api/v1/auth/claim/${token}`);
    expect(peek.status).toBe(200);
    expect(peek.body.email).toBe("claim@example.com");
    const weak = await a.json("POST", "/api/v1/auth/claim", { token, password: "short" });
    expect(weak.status).toBe(400);
    const res = await a.req("POST", "/api/v1/auth/claim", { token, password: "a much longer password" });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("cosimo_session="))).toBe(true);
    const again = await a.json("POST", "/api/v1/auth/claim", { token, password: "a much longer password" });
    expect(again.status).toBe(400);
    await env.ctx.users.verifyLogin("claim@example.com", "a much longer password");
  });

  test("org creation makes the creator owner and writes a chained audit row", async () => {
    const c = await login(env, "owner1@example.com");
    const orgId = await createOrg(env, c, "Owner One LLC");
    const list = await c.json("GET", "/api/v1/orgs");
    expect(list.body.data).toContainEqual({ id: orgId, name: "Owner One LLC", role: "owner" });
    const got = await c.json("GET", `/api/v1/orgs/${orgId}`);
    expect(got.body.settings.legal_name).toBe("Owner One LLC");
    const audit = await c.json("GET", `/api/v1/orgs/${orgId}/audit`);
    expect(audit.body.data.map((a: { action: string }) => a.action)).toContain("org.create");

    const h = await env.ctx.orgs.mustOpen(orgId);
    const rows = await h.db.select().from(org.auditLog).orderBy(asc(org.auditLog.seq)).all();
    const res = verifyChain("audit", rows, (prev, r) => auditHash(orgId, prev, r), auditGenesis(orgId));
    expect(res.ok).toBe(true);
  });

  test("audit log cannot be updated or deleted through SQL", async () => {
    const c = await login(env, "owner2@example.com");
    const orgId = await createOrg(env, c);
    const h = await env.ctx.orgs.mustOpen(orgId);
    await expect(h.client.execute("UPDATE audit_log SET action = 'x'")).rejects.toThrow(/append-only/);
    await expect(h.client.execute("DELETE FROM audit_log")).rejects.toThrow(/append-only/);
    await expect(
      h.client.execute(
        "INSERT INTO audit_log (id, seq, at, actor, action, prev_hash, hash) VALUES ('x', 99, 'now', 'user', 'forged', 'abc', 'def')",
      ),
    ).rejects.toThrow(/audit seq must extend/);
  });

  test("users cannot see each other's orgs", async () => {
    const a = await login(env, "iso-a@example.com");
    const b = await login(env, "iso-b@example.com");
    const orgA = await createOrg(env, a, "A Books");
    expect((await b.json("GET", `/api/v1/orgs/${orgA}`)).status).toBe(404);
    expect((await b.json("GET", `/api/v1/orgs/${orgA}/audit`)).status).toBe(404);
    expect((await b.json("GET", "/api/v1/orgs")).body.data).toEqual([]);
  });

  test("member management keeps at least one owner", async () => {
    const o = await login(env, "mm-owner@example.com");
    const orgId = await createOrg(env, o);
    const last = await o.json("PATCH", `/api/v1/orgs/${orgId}/members/${o.userId}`, { role: "bookkeeper" });
    expect(last.status).toBe(422);
    expect(last.body.error.code).toBe("last_owner");
    const bk = await login(env, "mm-bk@example.com");
    await addMember(env, orgId, bk.userId, "bookkeeper");
    const denied = await bk.json("PATCH", `/api/v1/orgs/${orgId}/members/${o.userId}`, { role: "viewer" });
    expect(denied.status).toBe(403);
    const members = await bk.json("GET", `/api/v1/orgs/${orgId}/members`);
    expect(members.body.data).toHaveLength(2);
  });

  test("invitations create accounts and memberships", async () => {
    const o = await login(env, "inv-owner@example.com");
    const orgId = await createOrg(env, o, "Invite Co");
    const inv = await o.json("POST", `/api/v1/orgs/${orgId}/invitations`, {
      email: "cpa@example.com",
      role: "accountant",
    });
    expect(inv.status).toBe(201);
    const token = String(inv.body.link).split("/invite/")[1]!;
    const a = anon(env);
    const peek = await a.json("GET", `/api/v1/invitations/${token}`);
    expect(peek.body).toMatchObject({
      email: "cpa@example.com",
      role: "accountant",
      org_name: "Invite Co",
      user_exists: false,
    });
    const acc = await a.json("POST", "/api/v1/invitations/accept", { token, password: PASSWORD });
    expect(acc.status).toBe(200);
    const cpa = await login(env, "cpa@example.com");
    const list = await cpa.json("GET", "/api/v1/orgs");
    expect(list.body.data).toEqual([{ id: orgId, name: "Invite Co", role: "accountant" }]);
    // accountants are read-only
    expect((await cpa.json("PATCH", `/api/v1/orgs/${orgId}`, { dba: "Nope" })).status).toBe(403);
    // reused invitation fails
    expect(
      (await a.json("POST", "/api/v1/invitations/accept", { token, password: "x".repeat(12) })).status,
    ).toBe(404);
  });

  test("API tokens are org-scoped, role-capped, and revocable", async () => {
    const o = await login(env, "tok-owner@example.com");
    const orgId = await createOrg(env, o);
    const other = await createOrg(env, o, "Other");
    const bk = await login(env, "tok-bk@example.com");
    await addMember(env, orgId, bk.userId, "bookkeeper");
    const created = await bk.json("POST", "/api/v1/tokens", { org_id: orgId, name: "script", role: "owner" });
    expect(created.status).toBe(201);
    expect(created.body.role).toBe("bookkeeper"); // capped at the user's role
    const t = tokenClient(env, created.body.token);
    const orgs = await t.json("GET", "/api/v1/orgs");
    expect(orgs.body.data.map((x: { id: string }) => x.id)).toEqual([orgId]);
    expect((await t.json("GET", `/api/v1/orgs/${orgId}`)).status).toBe(200);
    // bearer requests need no CSRF, but cannot reach other orgs even if the user could
    expect((await t.json("GET", `/api/v1/orgs/${other}`)).status).toBe(403);
    // tokens cannot mint tokens
    expect(
      (await t.json("POST", "/api/v1/tokens", { org_id: orgId, name: "x", role: "viewer" })).status,
    ).toBe(403);
    const revoked = await bk.json("DELETE", `/api/v1/tokens/${created.body.id}`);
    expect(revoked.status).toBe(200);
    expect((await t.json("GET", "/api/v1/orgs")).status).toBe(401);
  });

  test("login is rate limited", async () => {
    env.ctx.rateLimiter.reset();
    const a = anon(env);
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (
        await a.json("POST", "/api/v1/auth/login", { email: "rl@example.com", password: "whatever-pass" })
      ).status;
    }
    expect(last).toBe(429);
    env.ctx.rateLimiter.reset();
  });

  test("TOTP two-factor login", async () => {
    const c = await login(env, "totp@example.com");
    const setup = await c.json("POST", "/api/v1/auth/totp/setup");
    const totp = new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(setup.body.secret),
      digits: 6,
      period: 30,
    });
    const bad = await c.json("POST", "/api/v1/auth/totp/enable", { code: "000000" });
    expect(bad.status).toBe(401);
    const en = await c.json("POST", "/api/v1/auth/totp/enable", { code: totp.generate() });
    expect(en.status).toBe(200);
    expect(en.body.recovery_codes).toHaveLength(10);
    const a = anon(env);
    const need = await a.json("POST", "/api/v1/auth/login", {
      email: "totp@example.com",
      password: PASSWORD,
    });
    expect(need.body.error.code).toBe("totp_required");
    const ok = await a.json("POST", "/api/v1/auth/login", {
      email: "totp@example.com",
      password: PASSWORD,
      totp_code: totp.generate(),
    });
    expect(ok.status).toBe(200);
    const rc = await a.json("POST", "/api/v1/auth/login", {
      email: "totp@example.com",
      password: PASSWORD,
      totp_code: en.body.recovery_codes[0],
    });
    expect(rc.status).toBe(200);
    const reuse = await a.json("POST", "/api/v1/auth/login", {
      email: "totp@example.com",
      password: PASSWORD,
      totp_code: en.body.recovery_codes[0],
    });
    expect(reuse.status).toBe(401);
    // the TOTP secret is encrypted at rest
    const user = await env.ctx.users.byEmail("totp@example.com");
    expect(user?.totpSecretEnc?.startsWith("enc:v1:")).toBe(true);
  });

  test("admin endpoints require instance admin; open signup warns", async () => {
    const user = await login(env, "notadmin@example.com");
    expect((await user.json("GET", "/api/v1/admin/users")).status).toBe(403);
    const admin = await login(env, "admin@example.com", { admin: true });
    const created = await admin.json("POST", "/api/v1/admin/users", {
      email: "new@example.com",
      name: "New",
    });
    expect(created.status).toBe(201);
    expect(created.body.claim_link).toContain("/claim/");
    const s = await admin.json("PATCH", "/api/v1/admin/settings", {
      signup_mode: "open",
      smtp: {
        enabled: true,
        host: "smtp.example.com",
        port: 587,
        user: "u",
        password: "hunter2",
        from: "a@b.c",
        secure: false,
      },
    });
    expect(s.status).toBe(200);
    expect(s.body.warnings[0]).toContain("Open signup");
    expect(JSON.stringify(s.body)).not.toContain("hunter2");
    expect(s.body.smtp.password_set).toBe(true);
    const signup = await anon(env).json("POST", "/api/v1/auth/signup", {
      email: "self@example.com",
      password: "self signup pw",
      name: "Self",
    });
    expect(signup.status).toBe(200);
    await admin.json("PATCH", "/api/v1/admin/settings", { signup_mode: "single_user" });
    const denied = await anon(env).json("POST", "/api/v1/auth/signup", {
      email: "self2@example.com",
      password: "self signup pw",
      name: "Self",
    });
    expect(denied.status).toBe(403);
  });

  test("errors use the consistent shape", async () => {
    const r = await anon(env).json("GET", "/api/v1/orgs");
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: { code: "unauthorized", message: "Authentication required." } });
    const c = await login(env, "val@example.com");
    const v = await c.json("POST", "/api/v1/orgs", { name: "" });
    expect(v.status).toBe(400);
    expect(v.body.error.code).toBe("validation_error");
  });

  test("OpenAPI document is served", async () => {
    const r = await env.app.request("/api/v1/openapi.json");
    expect(r.status).toBe(200);
    const doc = await r.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toContain("/api/v1/orgs/{orgId}");
  });
});

describe("SecretBox", () => {
  test("round trips and detects tampering", () => {
    const box = new SecretBox(Buffer.alloc(32, 7).toString("base64"));
    const enc = box.encrypt("plaid-secret");
    expect(enc).not.toContain("plaid-secret");
    expect(box.decrypt(enc)).toBe("plaid-secret");
    const tampered = `${enc.slice(0, -2)}${enc.endsWith("A") ? "B" : "A"}A`;
    expect(() => box.decrypt(tampered)).toThrow();
    const other = new SecretBox(Buffer.alloc(32, 8).toString("base64"));
    expect(() => other.decrypt(enc)).toThrow();
  });
});
