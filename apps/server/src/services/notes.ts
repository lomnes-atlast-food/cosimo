/**
 * Business context for AI (SPEC §10.3): one structured business profile per org and free-form,
 * attributed bookkeeping notes. Both live in `org_notes` (kind 'profile' | 'note') and are exposed
 * to MCP as `org://profile` and `org://notes`. Appending a note is the one write an MCP assistant
 * makes directly (not through the review queue); editing and deleting stay with people.
 */
import { newId, type OrgDb, type OrgTx, org } from "@cosimo/db";
import { z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import { TOKEN_PREFIX } from "../crypto.ts";
import { forbidden, notFound, unprocessable } from "../http/errors.ts";
import type { ActorInfo } from "./actor.ts";
import { appendAudit } from "./audit.ts";

type Reader = OrgDb | OrgTx;
type NoteRow = typeof org.orgNotes.$inferSelect;

export const PROFILE_MAX_BYTES = 20 * 1024;
export const NOTE_MAX_BYTES = 10 * 1024;

// ----------------------------------------------------------------------------- secret guard

const APP_TOKEN_PREFIXES = Object.values(TOKEN_PREFIX).filter((p) => p.length > 0);

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const SECRET_PATTERNS: { reason: string; re: RegExp }[] = [
  { reason: "a private key", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  {
    reason: "a Plaid token",
    re: /\b(?:access|public|link|processor)-(?:sandbox|development|production)-[0-9a-z-]{8,}/i,
  },
  { reason: "a provider API key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|\bAKIA[0-9A-Z]{16}\b/ },
  { reason: "a webhook signing secret", re: /\bwhsec_[A-Za-z0-9]{10,}/ },
  { reason: "a GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  {
    reason: "a password or API key",
    re: /\b(?:password|passwd|passcode|pwd|api[ _-]?key|secret[ _-]?key|client[ _-]?secret|access[ _-]?token|auth[ _-]?token|pin)\s*(?:is\s*)?[:=]\s*\S+/i,
  },
  {
    reason: "a bank account or card number",
    re: /\b(?:account|acct|routing|card)\s*(?:number|num|no\.?|#)\s*[:#]?\s*\d[\d -]{5,}/i,
  },
  { reason: "a bank account or card number", re: /\d{12,}/ },
];

/**
 * Return why `text` looks like it contains a secret or bank credential, or null. Deliberately
 * narrow so ordinary bookkeeping prose (amounts, dates, phone numbers, account codes) passes.
 */
export function detectSecret(text: string): string | null {
  for (const p of APP_TOKEN_PREFIXES) {
    const i = text.indexOf(p);
    if (i >= 0 && /^[A-Za-z0-9_-]{8,}/.test(text.slice(i + p.length))) return "a Cosimo access token";
  }
  for (const { reason, re } of SECRET_PATTERNS) if (re.test(text)) return reason;
  // Card numbers written in groups: 4-4-4-1..7 (Visa/MC/Discover) or 4-6-5 (Amex), passing Luhn.
  const grouped = /\b\d{4}([ -])(?:\d{4}\1\d{4}\1\d{1,7}|\d{6}\1\d{5})\b/g;
  for (const m of text.matchAll(grouped)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return "a card number";
  }
  return null;
}

function guard(text: string) {
  const reason = detectSecret(text);
  if (reason)
    throw unprocessable(
      `That text looks like it contains ${reason}. Notes and the business profile must never hold secrets or bank credentials.`,
      "looks_like_secret",
      { reason },
    );
}

function sizeGuard(text: string, max: number, what: string) {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > max)
    throw unprocessable(`${what} is too long (${bytes} bytes; the limit is ${max}).`, "too_large", {
      bytes,
      max,
    });
}

// ----------------------------------------------------------------------------- permissions

const isWriterRole = (a: ActorInfo) => a.role === "owner" || a.role === "bookkeeper";
/** People and full-access tokens; not MCP clients or propose-only tokens. */
const isDirectWriter = (a: ActorInfo) => isWriterRole(a) && a.actor !== "mcp" && !a.proposeOnly;

export function canEditNote(a: ActorInfo, n: Pick<NoteRow, "authorActor" | "authorId">): boolean {
  if (!isDirectWriter(a)) return false;
  if (a.role === "owner") return true;
  return n.authorActor !== "mcp" && n.authorId !== null && n.authorId === a.userId;
}

// ----------------------------------------------------------------------------- profile

export const RecurringItemSchema = z.object({
  item: z.string().trim().min(1).max(200),
  account_code: z.string().trim().min(1).max(20),
  notes: z.string().max(1000).optional(),
});

export const BusinessProfileSchema = z
  .object({
    description: z.string().max(10_000).optional(),
    billing: z.string().max(10_000).optional(),
    customers: z.string().max(10_000).optional(),
    vendors: z.string().max(10_000).optional(),
    recurring: z.array(RecurringItemSchema).max(200).optional(),
    other: z.string().max(10_000).optional(),
  })
  .openapi("BusinessProfile");

export type BusinessProfile = z.infer<typeof BusinessProfileSchema>;
export type RecurringItem = z.infer<typeof RecurringItemSchema>;

const TEXT_FIELDS = ["description", "billing", "customers", "vendors", "other"] as const;

/** Trim fields and drop empty ones so the stored JSON stays small and stable. */
function normalizeProfile(p: BusinessProfile): BusinessProfile {
  const out: BusinessProfile = {};
  for (const k of TEXT_FIELDS) {
    const v = p[k]?.trim();
    if (v) out[k] = v;
  }
  const rec = (p.recurring ?? [])
    .map((r) => {
      const item: RecurringItem = { item: r.item.trim(), account_code: r.account_code.trim() };
      const notes = r.notes?.trim();
      if (notes) item.notes = notes;
      return item;
    })
    .filter((r) => r.item && r.account_code);
  if (rec.length) out.recurring = rec;
  return out;
}

function profileText(p: BusinessProfile): string {
  return [
    ...TEXT_FIELDS.map((k) => p[k] ?? ""),
    ...(p.recurring ?? []).map((r) => `${r.item}\n${r.account_code}\n${r.notes ?? ""}`),
  ].join("\n");
}

export interface ProfileView {
  profile: BusinessProfile;
  updated_at: string | null;
  author_actor: string | null;
  author_id: string | null;
}

async function profileRow(db: Reader) {
  return db.select().from(org.orgNotes).where(eq(org.orgNotes.kind, "profile")).get();
}

export async function getProfile(db: Reader): Promise<ProfileView> {
  const row = await profileRow(db);
  if (!row) return { profile: {}, updated_at: null, author_actor: null, author_id: null };
  let profile: BusinessProfile = {};
  try {
    const parsed = BusinessProfileSchema.safeParse(JSON.parse(row.bodyMd));
    if (parsed.success) profile = parsed.data;
  } catch {
    // A corrupt profile reads as empty rather than breaking every caller.
  }
  return { profile, updated_at: row.updatedAt, author_actor: row.authorActor, author_id: row.authorId };
}

/** Upsert the org's business profile. Owners and bookkeepers only; never MCP or propose-only tokens. */
export async function setProfileTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  input: BusinessProfile,
): Promise<ProfileView> {
  if (!isDirectWriter(a))
    throw forbidden("Only owners and bookkeepers can change the business profile.", "forbidden");
  const parsed = BusinessProfileSchema.safeParse(input);
  if (!parsed.success)
    throw unprocessable(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const profile = normalizeProfile(parsed.data);
  const body = JSON.stringify(profile);
  sizeGuard(body, PROFILE_MAX_BYTES, "The business profile");
  guard(profileText(profile));
  const codes = [...new Set((profile.recurring ?? []).map((r) => r.account_code))];
  if (codes.length) {
    const known = new Set(
      (await tx.select({ code: org.accounts.code }).from(org.accounts).all()).map((r) => r.code),
    );
    const missing = codes.filter((c) => !known.has(c));
    if (missing.length)
      throw unprocessable(`Unknown account code: ${missing.join(", ")}.`, "unknown_account", { missing });
  }
  const existing = await profileRow(tx);
  const at = new Date().toISOString();
  const before = existing ? (await getProfile(tx)).profile : null;
  let id: string;
  if (existing) {
    id = existing.id;
    await tx
      .update(org.orgNotes)
      .set({ bodyMd: body, authorActor: a.actor, authorId: a.userId, updatedAt: at })
      .where(eq(org.orgNotes.id, id));
  } else {
    id = newId();
    await tx.insert(org.orgNotes).values({
      id,
      kind: "profile",
      bodyMd: body,
      authorActor: a.actor,
      authorId: a.userId,
      createdAt: at,
      updatedAt: at,
    });
  }
  await appendAudit(tx, orgId, a, {
    action: "profile.update",
    targetType: "org_notes",
    targetId: id,
    before,
    after: profile,
  });
  return { profile, updated_at: at, author_actor: a.actor, author_id: a.userId };
}

/** Map account code → name, for rendering the profile. */
export async function accountNamesByCode(db: Reader): Promise<Map<string, string>> {
  const rows = await db.select({ code: org.accounts.code, name: org.accounts.name }).from(org.accounts).all();
  return new Map(rows.map((r) => [r.code, r.name]));
}

/** Render the profile as a markdown document (MCP resource `org://profile`). */
export function profileMarkdown(
  profile: BusinessProfile,
  accountsByCode?: Map<string, string> | Record<string, string>,
): string {
  const nameOf = (code: string) =>
    accountsByCode instanceof Map ? accountsByCode.get(code) : accountsByCode?.[code];
  const sections: [string, string | undefined][] = [
    ["What the business does", profile.description],
    ["How it bills", profile.billing],
    ["Typical customers", profile.customers],
    ["Typical vendors", profile.vendors],
  ];
  const out = ["# Business profile", ""];
  let any = false;
  for (const [title, body] of sections) {
    if (!body?.trim()) continue;
    any = true;
    out.push(`## ${title}`, "", body.trim(), "");
  }
  if (profile.recurring?.length) {
    any = true;
    out.push("## Accounts for recurring items", "");
    for (const r of profile.recurring) {
      const name = nameOf(r.account_code);
      const acct = name ? `${r.account_code} ${name}` : r.account_code;
      out.push(`- **${r.item}** → account ${acct}${r.notes ? `: ${r.notes}` : ""}`);
    }
    out.push("");
  }
  if (profile.other?.trim()) {
    any = true;
    out.push("## Other", "", profile.other.trim(), "");
  }
  if (!any) out.push("_No business profile has been written yet._", "");
  return out.join("\n");
}

// ----------------------------------------------------------------------------- notes

export interface NoteView {
  id: string;
  body_md: string;
  author_actor: string;
  author_id: string | null;
  /** "AI assistant" for MCP notes; the person's name or email otherwise. */
  author_name: string;
  created_at: string;
  updated_at: string;
}

/** Resolve user ids to display names (name, else email). Supplied by the caller (system DB). */
export type UserNameLookup = (ids: string[]) => Promise<Map<string, string>>;

function authorName(actor: string, authorId: string | null, names: Map<string, string>): string {
  if (actor === "mcp") return "AI assistant";
  if (actor === "system") return "System";
  const person = authorId ? names.get(authorId) : undefined;
  if (actor === "api_token") return person ? `${person} (API token)` : "API token";
  return person ?? "Unknown user";
}

function noteView(n: NoteRow, names: Map<string, string>): NoteView {
  return {
    id: n.id,
    body_md: n.bodyMd,
    author_actor: n.authorActor,
    author_id: n.authorId,
    author_name: authorName(n.authorActor, n.authorId, names),
    created_at: n.createdAt,
    updated_at: n.updatedAt,
  };
}

async function namesFor(rows: NoteRow[], lookup?: UserNameLookup) {
  const ids = [...new Set(rows.map((r) => r.authorId).filter((x): x is string => Boolean(x)))];
  return lookup && ids.length ? lookup(ids) : new Map<string, string>();
}

/** All notes, newest first. */
export async function listNotes(db: Reader, lookup?: UserNameLookup): Promise<NoteView[]> {
  const rows = await db
    .select()
    .from(org.orgNotes)
    .where(eq(org.orgNotes.kind, "note"))
    .orderBy(desc(org.orgNotes.createdAt), desc(org.orgNotes.id))
    .all();
  const names = await namesFor(rows, lookup);
  return rows.map((r) => noteView(r, names));
}

async function mustGetNote(db: Reader, id: string) {
  const n = await db
    .select()
    .from(org.orgNotes)
    .where(and(eq(org.orgNotes.id, id), eq(org.orgNotes.kind, "note")))
    .get();
  if (!n) throw notFound("Note");
  return n;
}

function checkBody(body: string): string {
  const text = body.trim();
  if (!text) throw unprocessable("A note can't be empty.", "empty_note");
  sizeGuard(text, NOTE_MAX_BYTES, "The note");
  guard(text);
  return text;
}

/**
 * Append a dated, attributed note. Owners, bookkeepers, and MCP assistants (the explicit exception
 * to propose-only: an assistant can record what it learns) may append.
 */
export async function appendNoteTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  body_md: string,
  lookup?: UserNameLookup,
): Promise<NoteView> {
  if (!isWriterRole(a)) throw forbidden("Your role can't add bookkeeping notes.");
  const text = checkBody(body_md);
  const id = newId();
  const at = new Date().toISOString();
  await tx.insert(org.orgNotes).values({
    id,
    kind: "note",
    bodyMd: text,
    authorActor: a.actor,
    authorId: a.userId,
    createdAt: at,
    updatedAt: at,
  });
  await appendAudit(tx, orgId, a, {
    action: "note.append",
    targetType: "org_notes",
    targetId: id,
    after: { body_md: text },
  });
  const row = await mustGetNote(tx, id);
  return noteView(row, await namesFor([row], lookup));
}

export async function updateNoteTx(
  tx: OrgTx,
  orgId: string,
  a: ActorInfo,
  id: string,
  body_md: string,
  lookup?: UserNameLookup,
): Promise<NoteView> {
  const n = await mustGetNote(tx, id);
  if (!canEditNote(a, n)) throw forbidden("Only owners and the note's author can edit it.");
  const text = checkBody(body_md);
  const at = new Date().toISOString();
  await tx.update(org.orgNotes).set({ bodyMd: text, updatedAt: at }).where(eq(org.orgNotes.id, id));
  await appendAudit(tx, orgId, a, {
    action: "note.update",
    targetType: "org_notes",
    targetId: id,
    before: { body_md: n.bodyMd },
    after: { body_md: text },
  });
  const row = await mustGetNote(tx, id);
  return noteView(row, await namesFor([row], lookup));
}

export async function deleteNoteTx(tx: OrgTx, orgId: string, a: ActorInfo, id: string): Promise<void> {
  const n = await mustGetNote(tx, id);
  if (!canEditNote(a, n)) throw forbidden("Only owners and the note's author can delete it.");
  await tx.delete(org.orgNotes).where(eq(org.orgNotes.id, id));
  await appendAudit(tx, orgId, a, {
    action: "note.delete",
    targetType: "org_notes",
    targetId: id,
    before: {
      body_md: n.bodyMd,
      author_actor: n.authorActor,
      author_id: n.authorId,
      created_at: n.createdAt,
    },
  });
}

/** Render all notes as one markdown document (MCP resource `org://notes`). */
export function notesMarkdown(notes: NoteView[]): string {
  const out = ["# Bookkeeping notes", ""];
  if (!notes.length) out.push("_No notes yet._", "");
  for (const n of notes) {
    const edited = n.updated_at !== n.created_at ? `, edited ${n.updated_at.slice(0, 10)}` : "";
    out.push(`## ${n.created_at.slice(0, 10)} · ${n.author_name}${edited}`, "", n.body_md.trim(), "");
  }
  return out.join("\n");
}
