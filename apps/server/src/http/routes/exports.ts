/** File exports for non-financial reports (SPEC §9): audit log and reconciliation reports; SMTP test. */
import { org, system } from "@cosimo/db";
import { createRoute } from "@hono/zod-openapi";
import { and, asc, gte, inArray, lte } from "drizzle-orm";
import { renderReportPdf } from "../../pdf/index.ts";
import type { Mailer } from "../../services/mailer.ts";
import { reconciliationFiles } from "../../services/reconcile.ts";
import { csvCell } from "../../services/reports.ts";
import { ApiError } from "../errors.ts";
import { requireAdmin, requireRole } from "../middleware.ts";
import {
  bearerSecurity,
  errorResponses,
  Id,
  IsoDate,
  json,
  jsonBody,
  newRouter,
  OkSchema,
  OrgParams,
  z,
} from "../openapi.ts";

const fileResponse = {
  200: {
    content: {
      "text/csv": { schema: z.string() },
      "application/pdf": { schema: z.string().openapi({ format: "binary" }) },
    },
    description: "File",
  },
  ...errorResponses,
};

function csv(rows: (string | number | null)[][]) {
  return `${rows.map((r) => r.map((v) => csvCell(v == null ? "" : String(v))).join(",")).join("\r\n")}\r\n`;
}

export function exportRoutes() {
  const r = newRouter();

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/audit/export",
      tags: ["Reports"],
      summary: "Audit log report (CSV or PDF) for a date range (accountant or higher)",
      security: bearerSecurity,
      request: {
        params: OrgParams,
        query: z.object({
          from: IsoDate.optional(),
          to: IsoDate.optional(),
          format: z.enum(["csv", "pdf"]).default("csv"),
        }),
      },
      responses: fileResponse,
    }),
    async (c) => {
      const o = requireRole(c, "accountant");
      const q = c.req.valid("query");
      const conds = [];
      if (q.from) conds.push(gte(org.auditLog.at, `${q.from}T00:00:00`));
      if (q.to) conds.push(lte(org.auditLog.at, `${q.to}T23:59:59.999Z`));
      const rows = await o.handle.db
        .select()
        .from(org.auditLog)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(asc(org.auditLog.seq))
        .limit(50_000)
        .all();
      const userIds = [...new Set(rows.map((x) => x.userId).filter((x): x is string => Boolean(x)))];
      const users = userIds.length
        ? await c
            .get("ctx")
            .system.db.select({ id: system.users.id, email: system.users.email })
            .from(system.users)
            .where(inArray(system.users.id, userIds))
            .all()
        : [];
      const email = new Map(users.map((u) => [u.id, u.email]));
      const table = rows.map((x) => [
        x.seq,
        x.at,
        x.actor,
        x.userId ? (email.get(x.userId) ?? x.userId) : "",
        x.action,
        x.targetType ?? "",
        x.targetId ?? "",
        x.hash,
      ]);
      const name = `audit-log-${q.from ?? "start"}-${q.to ?? "now"}`;
      if (q.format === "pdf") {
        const reg = await c.get("ctx").orgs.get(o.id);
        const pdf = await renderReportPdf({
          title: "Audit Log",
          orgName: reg?.name ?? "",
          subtitle: `${q.from ?? "Beginning"} to ${q.to ?? "today"}`,
          currency: "USD",
          landscape: true,
          columns: [
            { label: "#" },
            { label: "When" },
            { label: "Actor" },
            { label: "User" },
            { label: "Action" },
            { label: "Target" },
            { label: "Hash" },
          ],
          rows: table.map((t) => ({
            kind: "row" as const,
            cells: [
              String(t[0]),
              String(t[1]).slice(0, 19).replace("T", " "),
              String(t[2]),
              String(t[3]),
              String(t[4]),
              `${t[5]} ${String(t[6]).slice(-8)}`.trim(),
              String(t[7]).slice(0, 16),
            ],
          })),
          footer: [`${rows.length} rows. Full hashes are in the CSV export.`],
        });
        return c.body(pdf as unknown as ArrayBuffer, 200, {
          "content-type": "application/pdf",
          "content-disposition": `attachment; filename="${name}.pdf"`,
        });
      }
      return c.body(
        csv([["seq", "at", "actor", "user", "action", "target_type", "target_id", "hash"], ...table]),
        200,
        {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${name}.csv"`,
        },
      );
    },
  );

  r.openapi(
    createRoute({
      method: "get",
      path: "/orgs/{orgId}/reconciliations/{reconId}/export",
      tags: ["Reconciliation"],
      summary: "Reconciliation report (CSV or PDF)",
      security: bearerSecurity,
      request: {
        params: OrgParams.extend({ reconId: Id.openapi({ param: { name: "reconId", in: "path" } }) }),
        query: z.object({ format: z.enum(["csv", "pdf"]).default("pdf") }),
      },
      responses: fileResponse,
    }),
    async (c) => {
      const o = c.get("org");
      const reconId = c.req.valid("param").reconId;
      const reg = await c.get("ctx").orgs.get(o.id);
      const f = await reconciliationFiles(o.handle.db, reconId, reg?.name ?? "", new Date().toISOString());
      if (c.req.valid("query").format === "csv") {
        return c.body(f.csv, 200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${f.name}.csv"`,
        });
      }
      return c.body(f.pdf as unknown as ArrayBuffer, 200, {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${f.name}.pdf"`,
      });
    },
  );

  r.openapi(
    createRoute({
      method: "post",
      path: "/admin/settings/test-email",
      tags: ["Admin"],
      summary: "Send a test email using the saved SMTP settings (instance admin)",
      security: bearerSecurity,
      request: { body: jsonBody(z.object({ to: z.string().email() })) },
      responses: { 200: json(OkSchema), ...errorResponses },
    }),
    async (c) => {
      requireAdmin(c);
      const mailer = c.get("ctx").services.mailer as Mailer;
      try {
        await mailer.sendTest(c.req.valid("json").to);
      } catch (e) {
        throw new ApiError(502, "smtp_failed", `Sending failed: ${(e as Error).message}`.slice(0, 500));
      }
      return c.json({ ok: true as const }, 200);
    },
  );

  return r;
}
