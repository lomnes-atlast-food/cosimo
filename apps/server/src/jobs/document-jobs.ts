/** Daily receivables jobs (SPEC §8.1): recurring invoices and overdue reminders (off by default). */
import { org } from "@cosimo/db";
import { addDays, today } from "@cosimo/shared";
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { markInvoiceSentTx, mustGetInvoice, runRecurringTx } from "../services/documents.ts";
import { emailInvoice } from "../services/invoice-delivery.ts";
import { settingsRow } from "../services/ledger.ts";
import type { Mailer } from "../services/mailer.ts";
import { daily, registerJob } from "./scheduler.ts";

const SYSTEM = { actor: "system" as const, role: "owner" as const, userId: null };
export const REMINDER_EVERY_DAYS = 7;

export async function runRecurring(ctx: AppContext, orgId: string, asOf = today()) {
  const h = await ctx.orgs.mustOpen(orgId);
  const created = await h.write((tx) => runRecurringTx(tx, orgId, asOf));
  const mailer = ctx.services.mailer as Mailer | undefined;
  let emailed = 0;
  for (const c of created.filter((x) => x.autoSend)) {
    const inv = await mustGetInvoice(h.db, c.invoiceId);
    if (inv.status === "draft" || !mailer || !(await mailer.isConfigured())) continue;
    try {
      const { to } = await emailInvoice(ctx, h.db, orgId, c.invoiceId);
      await h.write((tx) => markInvoiceSentTx(tx, orgId, SYSTEM, c.invoiceId, to));
      emailed++;
    } catch (err) {
      ctx.logger.warn("recurring invoice email failed", { org_id: orgId, invoice_id: c.invoiceId, err });
    }
  }
  return { created: created.length, emailed };
}

export async function runReminders(ctx: AppContext, orgId: string, asOf = today()) {
  const h = await ctx.orgs.mustOpen(orgId);
  const s = await settingsRow(h.db);
  const mailer = ctx.services.mailer as Mailer | undefined;
  if (!s.remindersEnabled || !mailer || !(await mailer.isConfigured())) return { sent: 0 };
  const cutoff = `${addDays(asOf, -REMINDER_EVERY_DAYS)}T23:59:59.999Z`;
  const due = await h.db
    .select({ id: org.invoices.id })
    .from(org.invoices)
    .where(
      and(
        inArray(org.invoices.status, ["sent", "partial"]),
        lt(org.invoices.dueDate, asOf),
        or(isNull(org.invoices.lastReminderAt), lt(org.invoices.lastReminderAt, cutoff)),
      ),
    )
    .all();
  let sent = 0;
  for (const d of due) {
    try {
      await emailInvoice(ctx, h.db, orgId, d.id, { reminder: true });
      await h.write((tx) =>
        tx
          .update(org.invoices)
          .set({ lastReminderAt: `${asOf}T00:00:00.000Z` })
          .where(eq(org.invoices.id, d.id)),
      );
      sent++;
    } catch (err) {
      ctx.logger.warn("reminder email failed", { org_id: orgId, invoice_id: d.id, err });
    }
  }
  return { sent };
}

export function registerDocumentJobs() {
  registerJob({
    name: "invoices.recurring",
    scope: "org",
    due: daily(6),
    async run(ctx, orgId) {
      const r = await runRecurring(ctx, orgId!);
      return `${r.created} created, ${r.emailed} emailed`;
    },
  });
  registerJob({
    name: "invoices.reminders",
    scope: "org",
    due: daily(15),
    async run(ctx, orgId) {
      const r = await runReminders(ctx, orgId!);
      return `${r.sent} reminder(s) sent`;
    },
  });
}
