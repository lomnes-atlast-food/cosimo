/** Chain maintenance jobs (SPEC §6.5): daily checkpoints and weekly full verification. */
import { system } from "@cosimo/db";
import { and, eq } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { checkpointIfChanged, verifyOrg } from "../services/chain.ts";
import type { Mailer } from "../services/mailer.ts";
import { daily, registerJob, weekly } from "./scheduler.ts";

let verifyWeekday = 0;

export function registerLedgerJobs(weekday: number) {
  verifyWeekday = weekday;
  registerJob({
    name: "chain.checkpoint",
    scope: "org",
    due: daily(0),
    async run(ctx, orgId) {
      const h = await ctx.orgs.mustOpen(orgId!);
      const res = await checkpointIfChanged(h, orgId!, "daily");
      return res ? `checkpointed ledger seq ${res[0]!.seq}, audit seq ${res[1]!.seq}` : "no activity";
    },
  });
  registerJob({
    name: "chain.verify",
    scope: "org",
    due: weekly(() => verifyWeekday),
    async run(ctx, orgId) {
      const h = await ctx.orgs.mustOpen(orgId!);
      const v = await verifyOrg(h.db, orgId!);
      if (!v.ok) {
        const b = v.firstBreak;
        const msg = b
          ? `chain verification failed: ${b.chain} seq ${b.seq}: ${b.reason}`
          : "chain verification failed: checkpoint mismatch";
        await alertOwners(ctx, orgId!, msg);
        throw new Error(msg);
      }
      return `ok: ledger ${v.ledger.checked} links, audit ${v.audit.checked} links`;
    },
  });
}

/** Best effort: a mail outage must not hide the failure, which is still recorded in job_runs. */
export async function alertOwners(ctx: AppContext, orgId: string, problem: string): Promise<number> {
  const mailer = ctx.services.mailer as Mailer | undefined;
  if (!mailer || !(await mailer.isConfigured())) return 0;
  const org = await ctx.system.db
    .select()
    .from(system.organizations)
    .where(eq(system.organizations.id, orgId))
    .get();
  const owners = await ctx.system.db
    .select({ email: system.users.email })
    .from(system.memberships)
    .innerJoin(system.users, eq(system.users.id, system.memberships.userId))
    .where(and(eq(system.memberships.orgId, orgId), eq(system.memberships.role, "owner")))
    .all();
  let sent = 0;
  for (const o of owners) {
    try {
      await mailer.send({
        to: o.email,
        subject: `Cosimo: integrity check failed for ${org?.name ?? orgId}`,
        text: `The weekly integrity check of the books for ${org?.name ?? orgId} found a problem:\n\n${problem}\n\nThe ledger or audit log may have been changed outside Cosimo. Run \`cosimo verify\` on the server for details, and restore from a backup if the change was not expected.`,
      });
      sent++;
    } catch {
      // recorded by the job failure itself
    }
  }
  return sent;
}
