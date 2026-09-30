/**
 * Operations API (SPEC §14): instance status and backups (instance admin), organization export and
 * import in the open format, and imports from QuickBooks Online, Xero, and Wave.
 */
import { org, system } from "@cosimo/db";
import { COMMIT, VERSION } from "@cosimo/shared";
import { createRoute } from "@hono/zod-openapi";
import { desc, eq } from "drizzle-orm";
import { createBackup, listBackups } from "../../services/backup.ts";
import { exportOrgBytes, importOrgArchive } from "../../services/export.ts";
import { instanceAudit } from "../../services/instance-audit.ts";
import { onlinePaymentStatus } from "../../services/online-payments.ts";
import {
  commitProductImport,
  MAX_PRODUCT_IMPORT_BYTES,
  parseProductFiles,
  previewProductImport,
} from "../../services/product-import.ts";
import { checkForUpdate, defaultCheckDeps } from "../../services/updates.ts";
import { badRequest } from "../errors.ts";
import { requireAdmin, requireOwner, requireSession } from "../middleware.ts";
import { bearerSecurity, errorResponses, json, jsonBody, newRouter, OrgParams, z } from "../openapi.ts";

const BackupSchema = z
  .object({ name: z.string(), bytes: z.number().int(), created_at: z.string() })
  .openapi("Backup");

const StatusSchema = z
  .object({
    version: z.string(),
    commit: z.string(),
    target: z.string(),
    database_mode: z.string(),
    storage: z.string(),
    orgs: z.number().int(),
    backups: z.object({
      mode: z.string(),
      time: z.string(),
      last: z
        .object({
          file: z.string(),
          at: z.string(),
          bytes: z.number().int(),
          destination: z.string(),
          reason: z.string(),
        })
        .nullable(),
    }),
    bank_connections: z.array(
      z.object({
        org_id: z.string(),
        org_name: z.string(),
        id: z.string(),
        institution: z.string().nullable(),
        status: z.string(),
        last_synced_at: z.string().nullable(),
      }),
    ),
    online_payments: z.array(
      z.object({
        org_id: z.string(),
        org_name: z.string(),
        livemode: z.boolean().nullable(),
        webhook_mode: z.enum(["registered", "manual", "polling"]).nullable(),
        last_event_at: z.string().nullable(),
        last_pay_error_at: z.string().nullable(),
        pending_reviews: z
          .number()
          .int()
          .describe("Stripe payments, fees, refunds, and disputes waiting in the review queue."),
        unmatched_payouts: z.number().int().describe("Paid Stripe payouts not yet linked to a bank deposit."),
        cash_balances: z
          .array(
            z.object({
              contact_name: z.string(),
              amount: z.number().int(),
              checked_at: z.string().nullable(),
            }),
          )
          .describe("Customers Stripe holds unapplied funds for (bank transfers), as last read."),
      }),
    ),
    recent_job_errors: z.array(
      z.object({
        job: z.string(),
        org_id: z.string().nullable(),
        started_at: z.string(),
        detail: z.string().nullable(),
      }),
    ),
  })
  .openapi("InstanceStatus");

const UpdateStatusSchema = z
  .object({
    current: z.string(),
    commit: z.string(),
    status: z.enum(["up_to_date", "available", "disabled", "dev", "unknown"]),
    latest: z.object({ version: z.string(), url: z.string(), published_at: z.string() }).nullable(),
    checked_at: z.string().nullable(),
    error: z.string().nullable(),
    instructions: z.array(z.string()),
  })
  .openapi("UpdateStatus");

const AccountPlanSchema = z.object({
  key: z.string(),
  name: z.string(),
  type: z.string(),
  subtype: z.string(),
  action: z.enum(["match", "create"]),
  account_id: z.string().nullable(),
  code: z.string(),
  matched_by: z.enum(["system", "code", "name"]).optional(),
  synthesized: z.boolean(),
});
const IssueSchema = z.object({ file: z.string(), row: z.number().int().nullable(), message: z.string() });
const ProductImportSchema = z
  .object({
    source: z.enum(["qbo", "xero", "wave"]),
    files: z.array(z.object({ name: z.string(), kind: z.string(), rows: z.number().int() })),
    date_range: z.object({ from: z.string(), to: z.string() }).nullable(),
    accounts: z.object({
      create: z.number().int(),
      match: z.number().int(),
      items: z.array(AccountPlanSchema),
    }),
    contacts: z.object({
      create: z.number().int(),
      match: z.number().int(),
      create_names: z.array(z.string()),
    }),
    entries: z.object({
      new: z.number().int(),
      already_imported: z.number().int(),
      total_debits: z.number().int(),
    }),
    errors: z.array(IssueSchema),
    warnings: z.array(IssueSchema),
    can_commit: z.boolean(),
    committed: z.boolean(),
    created: z.object({ accounts: z.number().int(), contacts: z.number().int(), entries: z.number().int() }),
    review_item_id: z.string().nullable(),
  })
  .openapi("ProductImport");

const zipResponse = {
  200: {
    content: { "application/zip": { schema: z.string().openapi({ format: "binary" }) } },
    description: "ZIP archive",
  },
  ...errorResponses,
};

export function operationsRoutes() {
  const r = newRouter();

  // ------------------------------------------------------------------ instance status and backups
  r.openapi(
    createRoute({
      method: "get",
      path: "/admin/status",
      tags: ["Admin"],
      summary:
        "Instance status: version, storage, backups, bank feeds, online payments, recent job errors (instance admin)",
      responses: { 200: json(StatusSchema), ...errorResponses },
    }),
    async (c) => {
      requireAdmin(c);
      const ctx = c.get("ctx");
      const orgs = await ctx.orgs.list();
      const connections: z.infer<typeof StatusSchema>["bank_connections"] = [];
      const payments: z.infer<typeof StatusSchema>["online_payments"] = [];
      for (const o of orgs) {
        const h = await ctx.orgs.open(o.id);
        if (!h) continue;
        const pay = await onlinePaymentStatus(ctx, h.db, o.id, o.name);
        if (pay) payments.push(pay);
        const rows = await h.db.select().from(org.bankConnections).all();
        for (const b of rows)
          connections.push({
            org_id: o.id,
            org_name: o.name,
            id: b.id,
            institution: b.institutionName,
            status: b.status,
            last_synced_at: b.lastSyncedAt,
          });
      }
      const errors = await ctx.system.db
        .select()
        .from(system.jobRuns)
        .where(eq(system.jobRuns.status, "error"))
        .orderBy(desc(system.jobRuns.startedAt))
        .limit(20)
        .all();
      return c.json(
        {
          version: VERSION,
          commit: COMMIT,
          target: ctx.config.instance.target,
          database_mode: ctx.config.database.mode,
          storage: ctx.config.storage.kind,
          orgs: orgs.length,
          backups: {
            mode: ctx.config.backups.mode,
            time: ctx.config.backups.time,
            last: await ctx.settings.get("last_backup"),
          },
          bank_connections: connections,
          online_payments: payments,
          recent_job_errors: errors.map((e) => ({
            job: e.job,
            org_id: e.orgId,
            started_at: e.startedAt,
            detail: e.detail,
          })),
        },
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/admin/update",
      tags: ["Admin"],
      summary: "Check GitHub Releases for a newer Cosimo, cached in memory for 12h (instance admin)",
      request: { query: z.object({ refresh: z.string().optional() }) },
      responses: { 200: json(UpdateStatusSchema), ...errorResponses },
    }),
    async (c) => {
      requireAdmin(c);
      const ctx = c.get("ctx");
      const refresh = c.req.valid("query").refresh === "1";
      return c.json(await checkForUpdate(ctx, defaultCheckDeps(), { refresh }), 200);
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/admin/backups",
      tags: ["Admin"],
      summary: "List backups, newest first (instance admin)",
      responses: { 200: json(z.object({ data: z.array(BackupSchema) })), ...errorResponses },
    }),
    async (c) => {
      requireAdmin(c);
      const ctx = c.get("ctx");
      const rows = await listBackups(ctx.config, { reveal: (v) => ctx.secrets.reveal(v) });
      return c.json({ data: rows.map(({ name, bytes, created_at }) => ({ name, bytes, created_at })) }, 200);
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/admin/backups",
      tags: ["Admin"],
      summary: "Create a backup now (instance admin)",
      responses: {
        201: json(
          BackupSchema.extend({
            destination: z.enum(["local", "s3"]),
            orgs: z.number().int(),
            secrets_omitted: z.boolean(),
          }),
          "Created",
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      const admin = requireAdmin(c);
      const ctx = c.get("ctx");
      const b = await createBackup(ctx, { reason: "manual" });
      await instanceAudit(ctx.system, {
        userId: admin.userId,
        action: "backup.create",
        targetType: "backup",
        targetId: b.name,
        ip: c.get("ip"),
      });
      return c.json(
        {
          name: b.name,
          bytes: b.bytes,
          created_at: b.created_at,
          destination: b.destination,
          orgs: b.orgs,
          secrets_omitted: b.secrets_omitted,
        },
        201,
      );
    },
  );

  // ------------------------------------------------------------------ open-format export / import
  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/export",
      tags: ["Organizations"],
      summary: "Download the organization in the open export format (owner)",
      description: "A ZIP of JSON Lines tables, attachments, and a manifest. See docs/export-format.md.",
      security: bearerSecurity,
      request: { params: OrgParams },
      responses: zipResponse,
    }),
    async (c) => {
      const o = requireOwner(c);
      const ctx = c.get("ctx");
      const reg = await ctx.orgs.get(o.id);
      const { bytes } = await exportOrgBytes(ctx, o.id);
      const slug = (reg?.name ?? o.id).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-|-$/g, "") || o.id;
      return c.body(bytes as unknown as ArrayBuffer, 200, {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${slug}-${new Date().toISOString().slice(0, 10)}.zip"`,
      });
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/imports/org",
      tags: ["Organizations"],
      summary: "Create an organization from an open-format export; you become its owner",
      description:
        "multipart/form-data with `file` (the export ZIP) and optional `name`. Keeps the organization ID and verifies the hash chains.",
      request: {
        body: {
          content: {
            "multipart/form-data": {
              schema: z.object({
                file: z.any().openapi({ type: "string", format: "binary" }),
                name: z.string().optional(),
              }),
            },
          },
        },
      },
      responses: {
        201: json(
          z.object({
            org_id: z.string(),
            name: z.string(),
            members_added: z.array(z.string()),
            members_skipped: z.array(z.string()),
          }),
          "Created",
        ),
        ...errorResponses,
      },
    }),
    async (c) => {
      const p = requireSession(c);
      const ctx = c.get("ctx");
      const body = await c.req.parseBody();
      const file = body.file;
      if (!(file instanceof File)) throw badRequest("Attach the export ZIP in the `file` field.");
      const r = await importOrgArchive(ctx, new Uint8Array(await file.arrayBuffer()), {
        userId: p.userId,
        name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined,
      });
      return c.json(
        {
          org_id: r.org_id,
          name: r.name,
          members_added: r.members_added,
          members_skipped: r.members_skipped,
        },
        201,
      );
    },
  );

  // ------------------------------------------------------------------ QuickBooks / Xero / Wave
  r.openapi(
    createRoute({
      method: "post",
      path: "/orgs/{orgId}/imports/product",
      tags: ["Imports"],
      summary:
        "Import accounts, contacts, and history from QuickBooks Online, Xero, or Wave CSV exports (owner)",
      description:
        "Send the CSV texts. With `dry_run` (the default) nothing is written and the report shows what would happen. Otherwise accounts and contacts are created and the entries (source type `import`) wait in the review queue as one batch (`review_item_id`); approving it posts them all. Importing the same files again adds nothing.",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        body: jsonBody(
          z.object({
            files: z
              .array(z.object({ name: z.string(), content: z.string() }))
              .min(1)
              .max(20),
            source: z.enum(["qbo", "xero", "wave"]).optional(),
            dry_run: z.boolean().default(true),
          }),
        ),
      },
      responses: { 200: json(ProductImportSchema), ...errorResponses },
    }),
    async (c) => {
      const o = requireOwner(c);
      const b = c.req.valid("json");
      const size = b.files.reduce((s, f) => s + f.content.length, 0);
      if (size > MAX_PRODUCT_IMPORT_BYTES) throw badRequest("The files are larger than 50 MB.");
      const bundle = parseProductFiles(b.files, b.source);
      if (b.dry_run) {
        const report = await previewProductImport(o.handle.db, bundle);
        return c.json(
          {
            ...report,
            committed: false,
            created: { accounts: 0, contacts: 0, entries: 0 },
            review_item_id: null,
          },
          200,
        );
      }
      return c.json(await commitProductImport(o.handle, o.id, o.actor, bundle), 200);
    },
  );

  return r;
}
