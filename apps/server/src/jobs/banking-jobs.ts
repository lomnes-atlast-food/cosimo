/** Review queue housekeeping (SPEC §7.5): expire items pending more than 30 days. */
import { expireOldTx } from "../services/review.ts";
import { daily, registerJob } from "./scheduler.ts";

export function registerBankingJobs() {
  registerJob({
    name: "review.expire",
    scope: "org",
    due: daily(1),
    async run(ctx, orgId) {
      const h = await ctx.orgs.mustOpen(orgId!);
      const n = await h.write((tx) => expireOldTx(tx, orgId!));
      return `${n} item(s) expired`;
    },
  });
}
