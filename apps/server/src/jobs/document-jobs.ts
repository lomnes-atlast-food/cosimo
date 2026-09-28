/** Daily receivables jobs (SPEC §8.1): recurring templates and overdue reminders (off by default). */
import { org } from "@cosimo/db";
import { addDays, today } from "@cosimo/shared";
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { emailInvoice } from "../services/invoice-delivery.ts";
import { settingsRow } from "../services/ledger.ts";
import type { Mailer } from "../services/mailer.ts";
import { drainOutbox, dueTemplates, runTemplate } from "../services/recurring.ts";
import { daily, registerJob } from "./scheduler.ts";

export const REMINDER_EVERY_DAYS = 7;

/**
 * Run every due recurring template (invoices, bills, entries), each occurrence in its own
 * transaction, then email what auto-send templates are waiting to send. A failing template records
 * its error and the others still run.
 */
export async function runRecurringTemplates(ctx: AppContext, orgId: string, asOf = today()) {
  const h = await ctx.orgs.mustOpen(orgId);
  let created = 0;
  let failed = 0;
  for (const t of await dueTemplates(h.db, asOf)) {
    const r = await runTemplate(h, orgId, t.id, asOf);
    created += r.created;
    if (r.error) failed++;
  }
  const mail = await drainOutbox(ctx, h, orgId, asOf);
  return { created, failed, emailed: mail.sent };
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
    name: "recurring.templates",
    scope: "org",
    due: daily(6),
    async run(ctx, orgId) {
      const r = await runRecurringTemplates(ctx, orgId!);
      return `${r.created} created, ${r.failed} failed, ${r.emailed} emailed`;
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
