/**
 * Online payment polling (#55): every 15 minutes for orgs without a webhook, every 6 hours as a
 * safety net for orgs with one. Each run also syncs refunds, disputes, and payouts. Orgs without a payment provider never run it.
 */
import { pollInterval, pollPayments } from "../services/online-payments.ts";
import { registerJob } from "./scheduler.ts";

export function registerPaymentJobs() {
  registerJob({
    name: "payments.poll",
    scope: "org",
    async due(now, last, ctx, orgId) {
      const every = orgId ? await pollInterval(ctx, orgId).catch(() => null) : null;
      if (every === null) return false;
      return !last || now.getTime() - last.getTime() >= every - 30_000;
    },
    async run(ctx, orgId) {
      const r = await pollPayments(ctx, orgId!);
      const summary = `${r.reconciled} checked, ${r.recorded} recorded, ${r.events} event(s) retried, ${r.fees} fee(s) posted, ${r.refunds} refund(s) and ${r.disputes} dispute movement(s) proposed, ${r.payouts} payout(s) stored, ${r.balances} cash balance(s) read`;
      if (r.failed) throw new Error(`${r.failed} failed; ${summary}`);
      return summary;
    },
  });
}
