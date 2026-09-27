/** Business profile and bookkeeping notes (SPEC §10.3). */
import { system } from "@cosimo/db";
import { createRoute } from "@hono/zod-openapi";
import { inArray } from "drizzle-orm";
import type { Context } from "hono";
import {
  accountNamesByCode,
  appendNoteTx,
  BusinessProfileSchema,
  canEditNote,
  deleteNoteTx,
  getProfile,
  listNotes,
  type NoteView,
  profileMarkdown,
  setProfileTx,
  type UserNameLookup,
  updateNoteTx,
} from "../../services/notes.ts";
import { requireRole, requireWriter } from "../middleware.ts";
import {
  bearerSecurity,
  errorResponses,
  Id,
  json,
  jsonBody,
  newRouter,
  OkSchema,
  OrgParams,
  Timestamp,
  z,
} from "../openapi.ts";
import type { AppEnv, OrgScope } from "../types.ts";

const ProfileResponse = z
  .object({
    profile: BusinessProfileSchema,
    updated_at: Timestamp.nullable(),
    author_actor: z.string().nullable(),
    author_name: z.string().nullable(),
    markdown: z.string(),
  })
  .openapi("BusinessProfileView");

const NoteSchema = z
  .object({
    id: z.string(),
    body_md: z.string(),
    author_actor: z.string(),
    author_id: z.string().nullable(),
    author_name: z.string(),
    created_at: Timestamp,
    updated_at: Timestamp,
    can_edit: z.boolean(),
  })
  .openapi("BookkeepingNote");

// Generous transport cap; the service enforces the real 10 KB limit with a clear 422.
const NoteBody = z.object({ body_md: z.string().min(1).max(100_000) });
const NoteParams = OrgParams.extend({ noteId: Id.openapi({ param: { name: "noteId", in: "path" } }) });

function userLookup(c: Context<AppEnv>): UserNameLookup {
  return async (ids) => {
    const rows = await c
      .get("ctx")
      .system.db.select({ id: system.users.id, email: system.users.email, name: system.users.name })
      .from(system.users)
      .where(inArray(system.users.id, ids))
      .all();
    return new Map(rows.map((u) => [u.id, u.name || u.email]));
  };
}

const withCanEdit = (o: OrgScope, n: NoteView) => ({
  ...n,
  can_edit: canEditNote(o.actor, { authorActor: n.author_actor, authorId: n.author_id }),
});

async function profileResponse(c: Context<AppEnv>, o: OrgScope) {
  const p = await getProfile(o.handle.db);
  let author_name: string | null = null;
  if (p.author_actor === "mcp") author_name = "AI assistant";
  else if (p.author_id) author_name = (await userLookup(c)([p.author_id])).get(p.author_id) ?? null;
  return {
    profile: p.profile,
    updated_at: p.updated_at,
    author_actor: p.author_actor,
    author_name,
    markdown: profileMarkdown(p.profile, await accountNamesByCode(o.handle.db)),
  };
}

export function notesRoutes() {
  const r = newRouter();

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/profile",
      tags: ["Business context"],
      summary: "The organization's business profile (read by AI assistants before categorizing)",
      security: bearerSecurity,
      request: { params: OrgParams },
      responses: { 200: json(ProfileResponse), ...errorResponses },
    }),
    async (c) => {
      const o = requireRole(c, "viewer");
      return c.json(await profileResponse(c, o), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "put",
      path: "/orgs/{orgId}/profile",
      tags: ["Business context"],
      summary: "Replace the business profile (owner or bookkeeper; not AI assistants or propose-only tokens)",
      security: bearerSecurity,
      request: { params: OrgParams, body: jsonBody(BusinessProfileSchema) },
      responses: { 200: json(ProfileResponse), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const body = c.req.valid("json");
      await o.handle.write((tx) => setProfileTx(tx, o.id, o.actor, body));
      return c.json(await profileResponse(c, o), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/notes",
      tags: ["Business context"],
      summary: "Bookkeeping notes, newest first",
      security: bearerSecurity,
      request: { params: OrgParams },
      responses: { 200: json(z.object({ data: z.array(NoteSchema) })), ...errorResponses },
    }),
    async (c) => {
      const o = requireRole(c, "viewer");
      const notes = await listNotes(o.handle.db, userLookup(c));
      return c.json({ data: notes.map((n) => withCanEdit(o, n)) }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/notes",
      tags: ["Business context"],
      summary: "Add a bookkeeping note (owner or bookkeeper)",
      security: bearerSecurity,
      request: { params: OrgParams, body: jsonBody(NoteBody) },
      responses: { 201: json(NoteSchema, "Created"), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const { body_md } = c.req.valid("json");
      const n = await o.handle.write((tx) => appendNoteTx(tx, o.id, o.actor, body_md, userLookup(c)));
      return c.json(withCanEdit(o, n), 201);
    },
  );

  r.openapi(
    createRoute({
      method: "patch",
      path: "/orgs/{orgId}/notes/{noteId}",
      tags: ["Business context"],
      summary: "Edit a note (owners: any note; others: their own)",
      security: bearerSecurity,
      request: { params: NoteParams, body: jsonBody(NoteBody) },
      responses: { 200: json(NoteSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const { noteId } = c.req.valid("param");
      const { body_md } = c.req.valid("json");
      const n = await o.handle.write((tx) => updateNoteTx(tx, o.id, o.actor, noteId, body_md, userLookup(c)));
      return c.json(withCanEdit(o, n), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "delete",
      path: "/orgs/{orgId}/notes/{noteId}",
      tags: ["Business context"],
      summary: "Delete a note (owners: any note; others: their own)",
      security: bearerSecurity,
      request: { params: NoteParams },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireWriter(c);
      const { noteId } = c.req.valid("param");
      await o.handle.write((tx) => deleteNoteTx(tx, o.id, o.actor, noteId));
      return c.json({ ok: true as const }, 200);
    },
  );

  return r;
}
