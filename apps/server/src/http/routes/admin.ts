import { SIGNUP_MODES } from "@cosimo/shared";
import { createRoute } from "@hono/zod-openapi";
import { instanceAudit } from "../../services/instance-audit.ts";
import { verifyPlaidKeys } from "../../services/plaid.ts";
import { badRequest, notFound } from "../errors.ts";
import { requireAdmin } from "../middleware.ts";
import { errorResponses, Id, json, jsonBody, newRouter, OkSchema, RoleSchema, z } from "../openapi.ts";
import { authError } from "./auth.ts";
import { createInvitation } from "./orgs.ts";

const AdminUserSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    is_instance_admin: z.boolean(),
    totp_enabled: z.boolean(),
    has_password: z.boolean(),
    created_at: z.string(),
    disabled_at: z.string().nullable(),
  })
  .openapi("AdminUser");

const SettingsSchema = z
  .object({
    signup_mode: z.enum(SIGNUP_MODES),
    dynamic_client_registration: z.boolean(),
    smtp: z.object({
      enabled: z.boolean(),
      host: z.string(),
      port: z.number().int(),
      user: z.string(),
      from: z.string(),
      secure: z.boolean(),
      password_set: z.boolean(),
    }),
    plaid: z.object({
      enabled: z.boolean(),
      env: z.enum(["sandbox", "production"]),
      client_id: z.string(),
      webhook_url: z.string(),
      redirect_uri: z.string(),
      secret_set: z.boolean(),
    }),
    warnings: z.array(z.string()),
  })
  .openapi("InstanceSettings");

export function adminRoutes() {
  const r = newRouter();

  r.openapi(
    createRoute({
      method: "get",
      path: "/admin/users",
      tags: ["Admin"],
      summary: "List users (instance admin)",
      responses: { 200: json(z.object({ data: z.array(AdminUserSchema) })), ...errorResponses },
    }),
    async (c) => {
      requireAdmin(c);
      const users = await c.get("ctx").users.list();
      return c.json(
        {
          data: users.map((u) => ({
            id: u.id,
            email: u.email,
            name: u.name,
            is_instance_admin: u.isInstanceAdmin,
            totp_enabled: u.totpEnabled,
            has_password: Boolean(u.passwordHash),
            created_at: u.createdAt,
            disabled_at: u.disabledAt,
          })),
        },
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/admin/users",
      tags: ["Admin"],
      summary: "Create a user and return a one-time claim link (instance admin)",
      request: {
        body: jsonBody(
          z.object({
            email: z.string().email(),
            name: z.string().default(""),
            is_instance_admin: z.boolean().default(false),
          }),
        ),
      },
      responses: {
        201: json(z.object({ id: z.string(), claim_link: z.string(), claim_link_expires_at: z.string() })),
        ...errorResponses,
      },
    }),
    async (c) => {
      const admin = requireAdmin(c);
      const ctx = c.get("ctx");
      const b = c.req.valid("json");
      const user = await ctx.users
        .create({ email: b.email, name: b.name, isInstanceAdmin: b.is_instance_admin })
        .catch(authError);
      const link = await ctx.users.issueClaimLink(user.id);
      await instanceAudit(ctx.system, {
        userId: admin.userId,
        action: "user.create",
        targetType: "user",
        targetId: user.id,
        ip: c.get("ip"),
      });
      return c.json(
        {
          id: user.id,
          claim_link: `${ctx.config.server.public_url}/claim/${link.token}`,
          claim_link_expires_at: link.expiresAt,
        },
        201,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "patch",
      path: "/admin/users/{userId}",
      tags: ["Admin"],
      summary: "Disable/enable a user or change instance admin (instance admin)",
      request: {
        params: z.object({ userId: Id }),
        body: jsonBody(
          z.object({ disabled: z.boolean().optional(), is_instance_admin: z.boolean().optional() }),
        ),
      },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      const admin = requireAdmin(c);
      const ctx = c.get("ctx");
      const { userId } = c.req.valid("param");
      const b = c.req.valid("json");
      const user = await ctx.users.byId(userId);
      if (!user) throw notFound("User");
      if (userId === admin.userId && (b.disabled || b.is_instance_admin === false)) {
        throw badRequest("You cannot disable or demote yourself.");
      }
      if (b.disabled !== undefined) await ctx.users.setDisabled(userId, b.disabled);
      if (b.is_instance_admin !== undefined) await ctx.users.setAdmin(userId, b.is_instance_admin);
      await instanceAudit(ctx.system, {
        userId: admin.userId,
        action: "user.update",
        targetType: "user",
        targetId: userId,
        detail: b,
        ip: c.get("ip"),
      });
      return c.json({ ok: true as const }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/admin/users/{userId}/claim-link",
      tags: ["Admin"],
      summary: "Issue a new claim / password-set link for a user (instance admin)",
      request: { params: z.object({ userId: Id }) },
      responses: {
        200: json(z.object({ claim_link: z.string(), claim_link_expires_at: z.string() })),
        ...errorResponses,
      },
    }),
    async (c) => {
      const admin = requireAdmin(c);
      const ctx = c.get("ctx");
      const { userId } = c.req.valid("param");
      if (!(await ctx.users.byId(userId))) throw notFound("User");
      const link = await ctx.users.issueClaimLink(userId);
      await instanceAudit(ctx.system, {
        userId: admin.userId,
        action: "user.claim_link",
        targetType: "user",
        targetId: userId,
        ip: c.get("ip"),
      });
      return c.json(
        {
          claim_link: `${ctx.config.server.public_url}/claim/${link.token}`,
          claim_link_expires_at: link.expiresAt,
        },
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/admin/invitations",
      tags: ["Admin"],
      summary: "Invite a new user to the instance without an org (instance admin)",
      request: {
        body: jsonBody(z.object({ email: z.string().email(), role: RoleSchema.default("viewer") })),
      },
      responses: {
        201: json(z.object({ id: z.string(), link: z.string(), emailed: z.boolean() })),
        ...errorResponses,
      },
    }),
    async (c) => {
      const admin = requireAdmin(c);
      const b = c.req.valid("json");
      const inv = await createInvitation(c.get("ctx"), {
        orgId: null,
        email: b.email,
        role: b.role,
        invitedBy: admin.userId,
      });
      return c.json({ id: inv.id, link: inv.link, emailed: inv.emailed }, 201);
    },
  );

  const settingsView = async (ctx: import("../../context.ts").AppContext) => {
    const v = await ctx.settings.publicView();
    const warnings: string[] = [];
    if (v.signup_mode === "open") {
      warnings.push("Open signup is enabled: anyone who can reach this server can create an account.");
    }
    return {
      signup_mode: v.signup_mode,
      dynamic_client_registration: v.dynamic_client_registration,
      smtp: {
        enabled: v.smtp.enabled,
        host: v.smtp.host,
        port: v.smtp.port,
        user: v.smtp.user,
        from: v.smtp.from,
        secure: v.smtp.secure,
        password_set: v.smtp.password_set,
      },
      plaid: {
        enabled: v.plaid.enabled,
        env: v.plaid.env,
        client_id: v.plaid.client_id,
        webhook_url: v.plaid.webhook_url,
        redirect_uri: v.plaid.redirect_uri,
        secret_set: v.plaid.secret_set,
      },
      warnings,
    };
  };

  r.openapi(
    createRoute({
      method: "get",
      path: "/admin/settings",
      tags: ["Admin"],
      summary: "Instance settings (instance admin). Secrets are never returned.",
      responses: { 200: json(SettingsSchema), ...errorResponses },
    }),
    async (c) => {
      requireAdmin(c);
      return c.json(await settingsView(c.get("ctx")), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "patch",
      path: "/admin/settings",
      tags: ["Admin"],
      summary: "Update instance settings (instance admin). Omit or send empty secrets to keep them.",
      request: {
        body: jsonBody(
          z.object({
            signup_mode: z.enum(SIGNUP_MODES).optional(),
            dynamic_client_registration: z.boolean().optional(),
            smtp: z
              .object({
                enabled: z.boolean(),
                host: z.string(),
                port: z.number().int(),
                user: z.string(),
                password: z.string(),
                from: z.string(),
                secure: z.boolean(),
              })
              .partial()
              .optional(),
            plaid: z
              .object({
                enabled: z.boolean(),
                env: z.enum(["sandbox", "production"]),
                // Pasted keys often carry a stray space or newline; Plaid rejects them as invalid.
                client_id: z.string().trim(),
                secret: z.string().trim(),
                webhook_url: z.union([z.literal(""), z.url({ protocol: /^https$/ })]),
                redirect_uri: z.union([z.literal(""), z.url({ protocol: /^https?$/ })]),
              })
              .partial()
              .optional(),
          }),
        ),
      },
      responses: { 200: json(SettingsSchema), ...errorResponses },
    }),
    async (c) => {
      const admin = requireAdmin(c);
      const ctx = c.get("ctx");
      const b = c.req.valid("json");
      // The form sends every field on each save: check the keys only when turning Plaid on or
      // changing the keys or environment, so saving other settings never depends on Plaid. This runs
      // before anything is written, so rejected keys leave every setting as it was.
      if (b.plaid) {
        const cur = await ctx.settings.get("plaid");
        const next = { ...cur, ...b.plaid, secret: b.plaid.secret || cur.secret };
        const changed =
          next.enabled !== cur.enabled ||
          next.env !== cur.env ||
          next.client_id !== cur.client_id ||
          next.secret !== cur.secret;
        if (changed && next.enabled && next.client_id && next.secret)
          await verifyPlaidKeys({ env: next.env, clientId: next.client_id, secret: next.secret });
      }
      if (b.signup_mode) await ctx.settings.set("signup_mode", b.signup_mode);
      if (b.dynamic_client_registration !== undefined) {
        await ctx.settings.set("dynamic_client_registration", b.dynamic_client_registration);
      }
      if (b.smtp) await ctx.settings.set("smtp", b.smtp);
      if (b.plaid) await ctx.settings.set("plaid", b.plaid);
      await instanceAudit(ctx.system, {
        userId: admin.userId,
        action: "instance_settings.update",
        detail: {
          signup_mode: b.signup_mode,
          dynamic_client_registration: b.dynamic_client_registration,
          smtp: b.smtp ? Object.keys(b.smtp) : undefined,
          plaid: b.plaid ? Object.keys(b.plaid) : undefined,
        },
        ip: c.get("ip"),
      });
      return c.json(await settingsView(ctx), 200);
    },
  );

  return r;
}
