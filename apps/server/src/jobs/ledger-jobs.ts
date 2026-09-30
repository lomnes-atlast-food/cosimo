/**
 * Chain maintenance jobs (SPEC §6.5): daily checkpoints, weekly full verification, and (with
 * anchoring on) daily public timestamps of the chain heads plus a 3-hourly check for completed
 * OpenTimestamps proofs.
 */
import { system } from "@cosimo/db";
import { and, eq } from "drizzle-orm";
import type { AppContext } from "../context.ts";
import { anchorNow, anchorVerifyOptions, upgradePending } from "../services/anchors.ts";
import { checkpointIfChanged, verifyOrg } from "../services/chain.ts";
import type { Mailer } from "../services/mailer.ts";
import { daily, everyHours, type JobDef, registerJob, weekly } from "./scheduler.ts";

let verifyWeekday = 0;

/** Anchoring jobs only run while the context that ticks has anchoring on. */
function whenAnchoring(due: JobDef["due"]): JobDef["due"] {
  return (now, last, ctx, orgId) => ctx.config.anchoring.enabled && due(now, last, ctx, orgId);
}

export function registerLedgerJobs(weekday: number, anchoring = false) {
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
      const v = await verifyOrg(h.db, orgId!, {
        anchors: ctx.config.anchoring.enabled ? anchorVerifyOptions(ctx, { network: true }) : undefined,
      });
      if (!v.ok) {
        const b = v.firstBreak;
        const a = v.anchors.problems[0];
        const msg = b
          ? `chain verification failed: ${b.chain} seq ${b.seq}: ${b.reason}`
          : a
            ? `chain verification failed: timestamp of ledger seq ${a.ledger_seq} (${a.service}): ${a.problem}`
            : "chain verification failed: checkpoint mismatch";
        await alertOwners(ctx, orgId!, msg);
        throw new Error(msg);
      }
      const bitcoin =
        v.anchors.bitcoin === "unavailable" ? "; Bitcoin not checked (explorer unreachable)" : "";
      return `ok: ledger ${v.ledger.checked} links, audit ${v.audit.checked} links, ${v.anchors.checked} timestamps${bitcoin}`;
    },
  });
  if (!anchoring) return;
  registerJob({
    name: "chain.anchor",
    scope: "org",
    // After chain.checkpoint at 00:00 UTC.
    due: whenAnchoring(daily(1)),
    async run(ctx, orgId) {
      const h = await ctx.orgs.mustOpen(orgId!);
      const r = await anchorNow(ctx, h, orgId!, "daily");
      if (r.status === "unchanged") return "no activity";
      if (r.status === "broken") {
        await alertOwners(ctx, orgId!, r.message);
        throw new Error(r.message);
      }
      // A failed service is retried on a later run once its back-off has passed.
      if (r.status === "failed" || r.status === "partial")
        throw new Error(`${r.message}: ${r.errors.join("; ")}`);
      return r.status === "waiting" ? `${r.message}: ${r.errors.join("; ")}` : r.message;
    },
  });
  registerJob({
    name: "chain.anchor.upgrade",
    scope: "org",
    due: whenAnchoring(everyHours(3)),
    async run(ctx, orgId) {
      const h = await ctx.orgs.mustOpen(orgId!);
      const r = await upgradePending(ctx, h, orgId!);
      if (!r.checked) return "nothing pending";
      const errors = r.errors.length ? `; ${r.errors.join("; ")}` : "";
      return `${r.completed} completed, ${r.pending} still pending, ${r.failed} failed${errors}`;
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
        text: `An integrity check of the books for ${org?.name ?? orgId} found a problem:\n\n${problem}\n\nThe ledger or audit log may have been changed outside Cosimo. Run \`cosimo verify\` on the server for details, and restore from a backup if the change was not expected.`,
      });
      sent++;
    } catch {
      // recorded by the job failure itself
    }
  }
  return sent;
}
