import {
  type AnchorNowResult,
  anchorNow,
  type UpgradeResult,
  upgradePending,
} from "../../services/anchors.ts";
import { CliError, emit, parse, withContext } from "../util.ts";

const USAGE = `cosimo anchor <org_id|--all>
  Publicly timestamp the current chain heads (OpenTimestamps and RFC 3161, per the [anchoring]
  config), then ask calendars whether pending OpenTimestamps proofs are in Bitcoin yet. The server
  does this on its own every day; this is for doing it now.
  Exit code 1 when timestamping is off, and 6 when an org's chain doesn't verify (it isn't
  timestamped).`;

export async function anchorCommand(argv: string[]) {
  const { values, positionals } = parse(argv, { all: { type: "boolean", default: false } });
  if (values.help || (!positionals[0] && !values.all)) {
    process.stdout.write(`${USAGE}\n`);
    if (!values.help) throw new CliError("An org id or --all is required", 2, "missing_argument");
    return;
  }
  const json = Boolean(values.json);
  await withContext(values, async (ctx) => {
    if (!ctx.config.anchoring.enabled)
      throw new CliError("Timestamping is off (anchoring.enabled in the config)", 1, "anchoring_disabled");
    const ids = values.all ? (await ctx.orgs.list()).map((o) => o.id) : [positionals[0]!];
    const results: { org_id: string; name: string; anchor: AnchorNowResult; upgrade: UpgradeResult }[] = [];
    for (const id of ids) {
      const reg = await ctx.orgs.get(id);
      if (!reg) throw new CliError(`Unknown org ${id}`, 1, "not_found");
      const h = await ctx.orgs.mustOpen(id);
      const anchor = await anchorNow(ctx, h, id, "manual");
      const upgrade = await upgradePending(ctx, h, id);
      results.push({ org_id: id, name: reg.name, anchor, upgrade });
    }
    const broken = results.filter((r) => r.anchor.status === "broken");
    emit(json, { status: broken.length ? "failed" : "ok", results }, () => {
      for (const r of results) {
        process.stdout.write(`${r.name} (${r.org_id}): ${r.anchor.message}\n`);
        for (const e of r.anchor.errors) process.stdout.write(`     ${e}\n`);
        if (r.upgrade.checked)
          process.stdout.write(
            `     pending proofs: ${r.upgrade.completed} completed, ${r.upgrade.pending} still pending, ${r.upgrade.failed} failed\n`,
          );
        for (const e of r.upgrade.errors) process.stdout.write(`     ${e}\n`);
      }
    });
    if (broken.length)
      throw new CliError(
        `${broken.length} org(s) weren't timestamped: the books don't verify`,
        6,
        "verification_failed",
      );
  });
}
