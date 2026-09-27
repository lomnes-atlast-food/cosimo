import { verifyOrg } from "../../services/chain.ts";
import { CliError, emit, parse, withContext } from "../util.ts";

const USAGE = `cosimo verify <org_id|--all> [--tail N]
  Recompute the ledger and audit hash chains and report the first broken link.
  --tail N   Only check the last N links of each chain (fast)
  Exit code 6 when any chain fails verification.`;

type VerifyRow = {
  org_id: string;
  name: string;
  ok: boolean;
  ledger: { ok: boolean; checked: number; head_seq: number; head_hash: string };
  audit: { ok: boolean; checked: number; head_seq: number; head_hash: string };
  checkpoint_mismatches: { chain: string; seq: number; expected: string; actual: string | null }[];
  first_break: { chain: string; seq: number; id: string | null; reason: string } | null;
};

export async function verifyCommand(argv: string[]) {
  const { values, positionals } = parse(argv, {
    all: { type: "boolean", default: false },
    tail: { type: "string" },
  });
  if (values.help || (!positionals[0] && !values.all)) {
    process.stdout.write(`${USAGE}\n`);
    if (!values.help) throw new CliError("An org id or --all is required", 2, "missing_argument");
    return;
  }
  const json = Boolean(values.json);
  const tail = values.tail ? Number(values.tail) : undefined;
  if (tail !== undefined && (!Number.isInteger(tail) || tail < 1)) {
    throw new CliError("--tail must be a positive integer", 2, "invalid_argument");
  }
  await withContext(values, async (ctx) => {
    const ids = values.all ? (await ctx.orgs.list()).map((o) => o.id) : [positionals[0]!];
    const results: VerifyRow[] = [];
    for (const id of ids) {
      const reg = await ctx.orgs.get(id);
      if (!reg) throw new CliError(`Unknown org ${id}`, 1, "not_found");
      const h = await ctx.orgs.mustOpen(id);
      const v = await verifyOrg(h.db, id, { tail });
      results.push({
        org_id: id,
        name: reg.name,
        ok: v.ok,
        ledger: {
          ok: v.ledger.ok,
          checked: v.ledger.checked,
          head_seq: v.ledger.headSeq,
          head_hash: v.ledger.headHash,
        },
        audit: {
          ok: v.audit.ok,
          checked: v.audit.checked,
          head_seq: v.audit.headSeq,
          head_hash: v.audit.headHash,
        },
        checkpoint_mismatches: v.checkpoints.mismatches,
        first_break: v.firstBreak,
      });
    }
    const failed = results.filter((r) => !r.ok);
    // In JSON mode a failure is reported once, through the error object (with the results).
    if (!(json && failed.length))
      emit(json, { status: failed.length ? "failed" : "ok", results }, () => {
        for (const r of results) {
          process.stdout.write(`${r.ok ? "OK  " : "FAIL"} ${r.name} (${r.org_id})\n`);
          process.stdout.write(
            `     ledger: ${r.ledger.checked} links checked, head #${r.ledger.head_seq} ${r.ledger.head_hash}\n`,
          );
          process.stdout.write(
            `     audit:  ${r.audit.checked} links checked, head #${r.audit.head_seq} ${r.audit.head_hash}\n`,
          );
          if (r.first_break) {
            process.stdout.write(
              `     first broken link: ${r.first_break.chain} #${r.first_break.seq}: ${r.first_break.reason}\n`,
            );
          }
          for (const m of r.checkpoint_mismatches) {
            process.stdout.write(
              `     checkpoint mismatch: ${m.chain} #${m.seq} expected ${m.expected}, found ${m.actual ?? "nothing"}\n`,
            );
          }
        }
      });
    if (failed.length) {
      // Output already written; exit non-zero without a second message.
      throw new CliError(`${failed.length} org(s) failed verification`, 6, "verification_failed", {
        results,
      });
    }
  });
}
