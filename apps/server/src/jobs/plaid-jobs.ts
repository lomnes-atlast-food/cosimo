/** Plaid polling (SPEC §7.1): sync every connection every 6 hours, webhooks or not. */
import { syncAll } from "../services/plaid.ts";
import { everyHours, registerJob } from "./scheduler.ts";

export const PLAID_POLL_HOURS = 6;

export function registerPlaidJobs() {
  registerJob({
    name: "plaid.sync",
    scope: "org",
    due: everyHours(PLAID_POLL_HOURS),
    async run(ctx, orgId) {
      const r = await syncAll(ctx, orgId!);
      if (r.failed) throw new Error(`${r.failed} connection(s) failed to sync; ${r.synced} synced`);
      return `${r.synced} synced, ${r.skipped} waiting on reconnect`;
    },
  });
}
