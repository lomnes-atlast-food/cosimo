/**
 * Outgoing email through the instance's SMTP settings (SPEC §8.1, §3.4). Tests swap in a capturing
 * transport with `useTestTransport()`; nothing is ever sent unless SMTP is enabled and complete.
 */
import nodemailer, { type Transporter } from "nodemailer";
import type { AppContext } from "../context.ts";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string | null;
  attachments?: { filename: string; content: Uint8Array; contentType: string }[];
}

export interface SentMail extends MailMessage {
  from: string;
  raw: string;
}

function escapeHtml(s: string) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** Plain, readable HTML version of a text email. */
export function textToHtml(text: string) {
  const body = escapeHtml(text)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>").replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>`)
    .join("");
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2937">${body}</body></html>`;
}

export class Mailer {
  #test: SentMail[] | null = null;

  constructor(private readonly ctx: AppContext) {}

  /** Capture messages in memory instead of sending (tests). */
  useTestTransport(): SentMail[] {
    this.#test = [];
    return this.#test;
  }

  /** Connect and authenticate to the SMTP server without sending anything. */
  async verify(): Promise<void> {
    const { t } = await this.transport();
    await t.verify();
  }

  async isConfigured(): Promise<boolean> {
    if (this.#test) return true;
    const s = await this.ctx.settings.get("smtp");
    return Boolean(s.enabled && s.host && s.from);
  }

  private async transport(): Promise<{ t: Transporter; from: string }> {
    if (this.#test) {
      return {
        t: nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" }),
        from: "Cosimo <test@cosimo.local>",
      };
    }
    const s = await this.ctx.settings.get("smtp");
    if (!s.enabled || !s.host || !s.from)
      throw new Error("Email is not set up. Add SMTP settings in Admin → Settings.");
    return {
      t: nodemailer.createTransport({
        host: s.host,
        port: s.port,
        secure: s.secure || s.port === 465,
        auth: s.user ? { user: s.user, pass: s.password } : undefined,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
      }),
      from: s.from,
    };
  }

  async send(m: MailMessage): Promise<void> {
    const { t, from } = await this.transport();
    const info = await t.sendMail({
      from,
      to: m.to,
      replyTo: m.replyTo ?? undefined,
      subject: m.subject,
      text: m.text,
      html: m.html ?? textToHtml(m.text),
      attachments: m.attachments?.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.content),
        contentType: a.contentType,
      })),
    });
    if (this.#test) {
      const raw = (info as unknown as { message: Buffer }).message.toString("utf8");
      this.#test.push({ ...m, from, raw });
    }
    this.ctx.logger.info("email sent", { subject: m.subject, attachments: m.attachments?.length ?? 0 });
  }

  sendInvitation(to: string, link: string, orgName: string | null) {
    return this.send({
      to,
      subject: orgName ? `You're invited to ${orgName} on Cosimo` : "You're invited to Cosimo",
      text: `You've been invited to ${orgName ?? "a Cosimo instance"}.\n\nAccept the invitation: ${link}\n\nThe link expires in 7 days.`,
    });
  }

  sendPasswordReset(to: string, link: string) {
    return this.send({
      to,
      subject: "Reset your Cosimo password",
      text: `Someone asked to reset the password for this account.\n\nSet a new password: ${link}\n\nThe link expires in 2 hours. If this wasn't you, ignore this email.`,
    });
  }

  sendTest(to: string) {
    return this.send({ to, subject: "Cosimo test email", text: "Email from your Cosimo instance works." });
  }
}
