/** Invoice PDF assembly and email delivery (SPEC §8.1). */
import { type OrgDb, type OrgTx, org } from "@cosimo/db";
import { eq } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { conflict, unprocessable } from "../http/errors.ts";
import { fmtMoney, type InvoicePdfData, renderInvoicePdf } from "../pdf/index.ts";
import { invoiceView, mustGetInvoice } from "./documents.ts";
import { settingsRow } from "./ledger.ts";
import type { Mailer } from "./mailer.ts";
import { payLinker } from "./online-payments.ts";
import type { BlobStore } from "./storage.ts";

type Reader = OrgDb | OrgTx;

export async function invoicePdf(ctx: AppContext, db: Reader, orgId: string, invoiceId: string) {
  const inv = await mustGetInvoice(db, invoiceId);
  const v = await invoiceView(db, inv, await payLinker(ctx, db, orgId));
  const s = await settingsRow(db);
  // The online pay link, or in payment link mode the URL entered on the invoice.
  const payUrl =
    v.balance_due > 0 ? (v.pay_url ?? (s.paymentProvider === "manual_link" ? v.manual_pay_url : null)) : null;
  const reg = await ctx.orgs.get(orgId);
  const customer = await db.select().from(org.contacts).where(eq(org.contacts.id, inv.customerId)).get();
  let logo: InvoicePdfData["org"]["logo"] = null;
  if (s.logoAttachmentId) {
    const a = await db.select().from(org.attachments).where(eq(org.attachments.id, s.logoAttachmentId)).get();
    const store = ctx.services.storage as BlobStore | undefined;
    if (a && store && (a.mimeType === "image/png" || a.mimeType === "image/jpeg")) {
      const bytes = await store.get(a.storageKey).catch(() => null);
      if (bytes) logo = { bytes, mime: a.mimeType };
    }
  }
  const bytes = await renderInvoicePdf({
    org: {
      name: s.dba || reg?.name || s.legalName,
      legalName: s.legalName,
      address: s.addressJson ? (JSON.parse(s.addressJson) as Record<string, string>) : null,
      logo,
      color: s.invoiceColor,
    },
    invoice: {
      number: v.number,
      issueDate: v.issue_date,
      dueDate: v.due_date,
      terms: v.terms,
      memo: v.memo,
      status: v.status,
      currency: v.currency,
      subtotal: v.subtotal,
      total: v.total,
      amountPaid: v.amount_paid,
      balanceDue: v.balance_due,
    },
    customer: {
      name: customer?.name ?? v.customer_name,
      email: customer?.email ?? null,
      address: customer?.addressJson ? (JSON.parse(customer.addressJson) as Record<string, string>) : null,
    },
    lines: v.lines.map((l) => ({
      description: l.description,
      quantityMilli: l.quantity_milli,
      unitPrice: l.unit_price,
      amount: l.amount,
    })),
    paymentInstructions: s.paymentInstructions,
    payUrl,
  });
  return {
    bytes,
    filename: `${v.number.replace(/[^\w.-]+/g, "_")}.pdf`,
    view: v,
    settings: s,
    payUrl,
    orgName: s.dba || reg?.name || s.legalName,
  };
}

export async function emailInvoice(
  ctx: AppContext,
  db: Reader,
  orgId: string,
  invoiceId: string,
  opts: { to?: string | null; message?: string | null; reminder?: boolean } = {},
) {
  const mailer = ctx.services.mailer as Mailer;
  if (!(await mailer.isConfigured()))
    throw conflict(
      "Email is not set up. Ask your instance admin to add SMTP settings.",
      "smtp_not_configured",
    );
  const pdf = await invoicePdf(ctx, db, orgId, invoiceId);
  const v = pdf.view;
  if (v.status === "draft" || v.status === "void")
    throw conflict(`A ${v.status} invoice cannot be sent.`, "invalid_state");
  const to = opts.to || v.customer_email;
  if (!to)
    throw unprocessable("The customer has no email address. Add one or enter a recipient.", "no_recipient");
  const due = fmtMoney(v.balance_due, v.currency);
  const intro = opts.reminder
    ? `This is a friendly reminder that invoice ${v.number} for ${due} was due on ${v.due_date}.`
    : `Please find invoice ${v.number} for ${fmtMoney(v.total, v.currency)} attached, due ${v.due_date}.`;
  const text = [
    `Hello ${v.customer_name},`,
    opts.message?.trim() || intro,
    pdf.payUrl ? `Pay online: ${pdf.payUrl}` : null,
    pdf.settings.paymentInstructions ? `How to pay:\n${pdf.settings.paymentInstructions}` : null,
    `Thank you,\n${pdf.orgName}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  await mailer.send({
    to,
    subject: opts.reminder
      ? `Reminder: invoice ${v.number} from ${pdf.orgName}`
      : `Invoice ${v.number} from ${pdf.orgName}`,
    text,
    attachments: [{ filename: pdf.filename, content: pdf.bytes, contentType: "application/pdf" }],
  });
  return { to };
}
