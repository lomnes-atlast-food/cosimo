/** Business profile and bookkeeping notes (SPEC §10.3). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { org } from "@cosimo/db";
import { asc, like } from "drizzle-orm";
import type { ActorInfo } from "../src/services/actor.ts";
import { exportOrgBytes } from "../src/services/export.ts";
import {
  appendNoteTx,
  detectSecret,
  getProfile,
  listNotes,
  notesMarkdown,
  profileMarkdown,
} from "../src/services/notes.ts";
import {
  addMember,
  type Client,
  createOrg,
  createTestEnv,
  DB_MODE,
  login,
  type TestEnv,
  tokenClient,
} from "./harness.ts";

let env: TestEnv;
let owner: Client;
let bk: Client;
let bk2: Client;
let viewer: Client;
let orgId: string;
let accounts: { code: string; name: string; type: string }[];
const base = () => `/api/v1/orgs/${orgId}`;

beforeAll(async () => {
  env = await createTestEnv();
  owner = await login(env, "owner@example.com");
  orgId = await createOrg(env, owner, "Notes Co");
  bk = await login(env, "bk@example.com");
  bk2 = await login(env, "bk2@example.com");
  viewer = await login(env, "viewer@example.com");
  await addMember(env, orgId, bk.userId, "bookkeeper");
  await addMember(env, orgId, bk2.userId, "bookkeeper");
  await addMember(env, orgId, viewer.userId, "viewer");
  accounts = (await owner.json("GET", `${base()}/accounts`)).body.data;
});
afterAll(async () => {
  await env.close();
});

async function handle() {
  const h = await env.ctx.orgs.open(orgId);
  if (!h) throw new Error("no org");
  return h;
}

async function auditActions(prefix: string) {
  const h = await handle();
  const rows = await h.db
    .select()
    .from(org.auditLog)
    .where(like(org.auditLog.action, `${prefix}%`))
    .orderBy(asc(org.auditLog.seq))
    .all();
  return rows.map((r) => r.action);
}

describe("secret detector", () => {
  const positives = [
    "access-sandbox-8ab976e2-2b3c-4d5e-9f00-112233445566",
    "token is access-production-1a2b3c4d-aaaa-bbbb-cccc-000000000000",
    "use cosimo_pat_abcdefghijklmnop for the script",
    `-----BEGIN RSA ${"PRIVATE"} KEY-----\nMIIE...`,
    `-----BEGIN ${"PRIVATE"} KEY-----`,
    "Bank login password: hunter22",
    "passwd=letmein",
    "API key: 1234abcd5678",
    "api_key = xyz",
    "Checking account 123456789012 at Chase",
    "card 4111111111111111",
    "card 4111 1111 1111 1111 exp 12/28",
    "Amex 3782-822463-10005",
    "account number: 00123456789",
    "routing # 021000021",
    `stripe ${"sk_"}live_abcdefghijklmnopqrstuv`,
  ];
  const negatives = [
    "Payments from Acme are retainer billing, account 4010.",
    "Monthly retainer of $2,500.00 billed on the 1st.",
    "Invoice 2026-01-31 paid 2026-02-15; follow up on 2026-03-01.",
    "Call Sam at (555) 123-4567 or +1 555 123 4567.",
    "Use 6100 for software, 6200 for rent; total 12,345,678.90 last year.",
    "Card ending 4242 is the business card.",
    "Dates 2026-01-31 2026-02-28 2026-03-31 2026-04-30 closed.",
    "Password manager is 1Password; ask the owner.",
    "Grouped but not a card: 1234 5678 9012 3456",
    "Account codes 1000 1010 1200 2000 3000 4000 5000",
  ];
  for (const t of positives) test(`flags: ${t.slice(0, 40)}`, () => expect(detectSecret(t)).not.toBeNull());
  for (const t of negatives) test(`allows: ${t.slice(0, 40)}`, () => expect(detectSecret(t)).toBeNull());
});

describe(`business profile (${DB_MODE})`, () => {
  test("empty profile reads as {}", async () => {
    const r = await viewer.json("GET", `${base()}/profile`);
    expect(r.status).toBe(200);
    expect(r.body.profile).toEqual({});
    expect(r.body.updated_at).toBeNull();
    expect(r.body.markdown).toContain("No business profile");
  });

  test("round trip, markdown resolves account codes to names, audited", async () => {
    const income = accounts.find((a) => a.type === "income")!;
    const expense = accounts.find((a) => a.type === "expense")!;
    const body = {
      description: "  Software consulting for small firms.  ",
      billing: "Monthly retainers plus hourly overage.",
      customers: "Law firms",
      vendors: "AWS, GitHub",
      recurring: [
        { item: "Acme retainer", account_code: income.code, notes: "billed on the 1st" },
        { item: "AWS", account_code: expense.code },
      ],
      other: "",
    };
    const put = await bk.json("PUT", `${base()}/profile`, body);
    expect(put.status).toBe(200);
    expect(put.body.profile.description).toBe("Software consulting for small firms.");
    expect(put.body.profile.other).toBeUndefined();
    expect(put.body.author_actor).toBe("user");
    expect(put.body.author_name).toBe("bk");
    expect(put.body.markdown).toContain(`${income.code} ${income.name}`);
    expect(put.body.markdown).toContain("## What the business does");

    const get = await viewer.json("GET", `${base()}/profile`);
    expect(get.body.profile.recurring).toHaveLength(2);
    expect(get.body.profile.recurring[0]).toEqual({
      item: "Acme retainer",
      account_code: income.code,
      notes: "billed on the 1st",
    });

    const h = await handle();
    const svc = await getProfile(h.db);
    expect(svc.profile.billing).toBe("Monthly retainers plus hourly overage.");
    const md = profileMarkdown(svc.profile, { [expense.code]: expense.name });
    expect(md).toContain(`account ${expense.code} ${expense.name}`);
    expect(md).toContain(`account ${income.code}: billed on the 1st`);

    // Update keeps a single profile row.
    expect((await owner.json("PUT", `${base()}/profile`, { description: "Consulting" })).status).toBe(200);
    const rows = await h.db.select().from(org.orgNotes).all();
    expect(rows.filter((r) => r.kind === "profile")).toHaveLength(1);
    expect(await auditActions("profile.")).toEqual(["profile.update", "profile.update"]);
  });

  test("unknown account codes, secrets, and oversize profiles are rejected", async () => {
    const bad = await owner.json("PUT", `${base()}/profile`, {
      recurring: [{ item: "x", account_code: "99999" }],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("unknown_account");

    const secret = await owner.json("PUT", `${base()}/profile`, {
      other: "Plaid access-sandbox-8ab976e2-2b3c-4d5e-9f00-112233445566",
    });
    expect(secret.status).toBe(422);
    expect(secret.body.error.code).toBe("looks_like_secret");

    const big = "word ".repeat(1900); // ~9.5 KB each, ~28 KB total
    const huge = await owner.json("PUT", `${base()}/profile`, {
      description: big,
      billing: big,
      customers: big,
    });
    expect(huge.status).toBe(422);
    expect(huge.body.error.code).toBe("too_large");
  });

  test("viewers and propose-only tokens cannot change the profile", async () => {
    expect((await viewer.json("PUT", `${base()}/profile`, { description: "x" })).status).toBe(403);
    const t = await owner.json("POST", "/api/v1/tokens", {
      org_id: orgId,
      name: "assistant",
      role: "bookkeeper",
      propose_only: true,
    });
    expect(t.status).toBe(201);
    const bot = tokenClient(env, t.body.token);
    expect((await bot.json("GET", `${base()}/profile`)).status).toBe(200);
    const put = await bot.json("PUT", `${base()}/profile`, { description: "hijack" });
    expect(put.status).toBe(403);
    expect((await owner.json("GET", `${base()}/profile`)).body.profile.description).toBe("Consulting");
  });
});

describe(`bookkeeping notes (${DB_MODE})`, () => {
  let ownerNote: string;
  let bkNote: string;

  test("append and list newest first with attribution", async () => {
    const a = await owner.json("POST", `${base()}/notes`, { body_md: "First: owner note." });
    expect(a.status).toBe(201);
    expect(a.body.author_actor).toBe("user");
    expect(a.body.author_id).toBe(owner.userId);
    expect(a.body.author_name).toBe("owner");
    expect(a.body.can_edit).toBe(true);
    ownerNote = a.body.id;
    const b = await bk.json("POST", `${base()}/notes`, { body_md: "Second: bk note, account 4010." });
    expect(b.status).toBe(201);
    bkNote = b.body.id;

    // An MCP assistant can append even though it is propose-only everywhere else.
    const mcp: ActorInfo = {
      actor: "mcp",
      role: "bookkeeper",
      userId: bk.userId,
      oauthClientId: "client-1",
      proposeOnly: true,
    };
    const h = await handle();
    const m = await h.write((tx) =>
      appendNoteTx(tx, orgId, mcp, "Payments from Acme are retainer billing, account 4010."),
    );
    expect(m.author_actor).toBe("mcp");
    expect(m.author_name).toBe("AI assistant");

    const list = await viewer.json("GET", `${base()}/notes`);
    expect(list.status).toBe(200);
    expect(list.body.data.map((n: any) => n.body_md)).toEqual([
      "Payments from Acme are retainer billing, account 4010.",
      "Second: bk note, account 4010.",
      "First: owner note.",
    ]);
    expect(list.body.data.map((n: any) => n.author_name)).toEqual(["AI assistant", "bk", "owner"]);
    expect(list.body.data.every((n: any) => n.can_edit === false)).toBe(true);

    const md = notesMarkdown(await listNotes(h.db));
    expect(md).toContain("# Bookkeeping notes");
    expect(md).toMatch(/## \d{4}-\d{2}-\d{2} · AI assistant/);
    expect(md.indexOf("AI assistant")).toBeLessThan(md.indexOf("First: owner note."));
  });

  test("MCP cannot edit or delete notes", async () => {
    const h = await handle();
    const { updateNoteTx, deleteNoteTx } = await import("../src/services/notes.ts");
    const mcp: ActorInfo = { actor: "mcp", role: "owner", userId: owner.userId, proposeOnly: true };
    const e1 = await h.write((tx) => updateNoteTx(tx, orgId, mcp, ownerNote, "x")).catch((e) => e);
    expect(e1.status).toBe(403);
    const e2 = await h.write((tx) => deleteNoteTx(tx, orgId, mcp, ownerNote)).catch((e) => e);
    expect(e2.status).toBe(403);
  });

  test("owner edits any note; bookkeeper edits own but not others'", async () => {
    const byOwner = await owner.json("PATCH", `${base()}/notes/${bkNote}`, { body_md: "Edited by owner." });
    expect(byOwner.status).toBe(200);
    expect(byOwner.body.body_md).toBe("Edited by owner.");
    expect(byOwner.body.author_name).toBe("bk");

    const own = await bk.json("PATCH", `${base()}/notes/${bkNote}`, { body_md: "Edited by bk." });
    expect(own.status).toBe(200);
    expect((await bk.json("PATCH", `${base()}/notes/${ownerNote}`, { body_md: "nope" })).status).toBe(403);
    expect((await bk2.json("PATCH", `${base()}/notes/${bkNote}`, { body_md: "nope" })).status).toBe(403);
    expect((await bk2.json("DELETE", `${base()}/notes/${bkNote}`)).status).toBe(403);

    const bkList = await bk.json("GET", `${base()}/notes`);
    const flags = Object.fromEntries(bkList.body.data.map((n: any) => [n.id, n.can_edit]));
    expect(flags[bkNote]).toBe(true);
    expect(flags[ownerNote]).toBe(false);

    const tmp = await bk2.json("POST", `${base()}/notes`, { body_md: "temporary" });
    expect((await bk2.json("DELETE", `${base()}/notes/${tmp.body.id}`)).status).toBe(200);
    expect((await owner.json("DELETE", `${base()}/notes/${bkNote}`)).status).toBe(200);
    expect((await owner.json("DELETE", `${base()}/notes/${bkNote}`)).status).toBe(404);
  });

  test("viewers cannot write; propose-only tokens can append but not edit", async () => {
    expect((await viewer.json("POST", `${base()}/notes`, { body_md: "hi" })).status).toBe(403);
    expect((await viewer.json("PATCH", `${base()}/notes/${ownerNote}`, { body_md: "hi" })).status).toBe(403);
    expect((await viewer.json("DELETE", `${base()}/notes/${ownerNote}`)).status).toBe(403);

    const t = await owner.json("POST", "/api/v1/tokens", {
      org_id: orgId,
      name: "script",
      role: "owner",
      propose_only: true,
    });
    const bot = tokenClient(env, t.body.token);
    const n = await bot.json("POST", `${base()}/notes`, { body_md: "Learned: rent is account 6200." });
    expect(n.status).toBe(201);
    expect(n.body.author_actor).toBe("api_token");
    expect(n.body.author_name).toBe("owner (API token)");
    expect((await bot.json("PATCH", `${base()}/notes/${n.body.id}`, { body_md: "x" })).status).toBe(403);
  });

  test("secret guard and size limits on notes", async () => {
    const s = await bk.json("POST", `${base()}/notes`, { body_md: "Bank password: hunter22" });
    expect(s.status).toBe(422);
    expect(s.body.error.code).toBe("looks_like_secret");
    const card = await bk.json("POST", `${base()}/notes`, { body_md: "Card 4111 1111 1111 1111" });
    expect(card.body.error.code).toBe("looks_like_secret");
    const edit = await owner.json("PATCH", `${base()}/notes/${ownerNote}`, {
      body_md: "token cosimo_pat_abcdefghijklmnopqrstuvwxyz",
    });
    expect(edit.body.error.code).toBe("looks_like_secret");

    const ok = await bk.json("POST", `${base()}/notes`, { body_md: "a".repeat(10 * 1024) });
    expect(ok.status).toBe(201);
    const big = await bk.json("POST", `${base()}/notes`, { body_md: "a".repeat(10 * 1024 + 1) });
    expect(big.status).toBe(422);
    expect(big.body.error.code).toBe("too_large");
    const empty = await bk.json("POST", `${base()}/notes`, { body_md: "   " });
    expect(empty.status).toBe(422);
  });

  test("note changes are audited", async () => {
    const actions = await auditActions("note.");
    expect(actions.filter((a) => a === "note.append").length).toBeGreaterThanOrEqual(5);
    expect(actions).toContain("note.update");
    expect(actions).toContain("note.delete");
  });

  test("notes and the profile are included in the org export", async () => {
    const { manifest } = await exportOrgBytes(env.ctx, orgId);
    expect(manifest.tables.org_notes!.rows).toBeGreaterThan(1);
    expect(Object.keys(manifest.files)).toContain("tables/org_notes.jsonl");
  });
});
