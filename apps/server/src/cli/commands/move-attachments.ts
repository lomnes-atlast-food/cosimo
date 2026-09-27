import { moveAttachments } from "../../services/move-attachments.ts";
import { CliError, emit, parse, progress, withContext } from "../util.ts";

const USAGE = `cosimo move-attachments [--dry-run]
  Copy every attachment under storage.dir into the S3-compatible bucket configured by the
  storage.s3_* settings, even while storage.kind is still local. Skips files already in the bucket
  with a matching size, and verifies every new copy. Local files are never deleted, and it is safe
  to run while the server is up. --dry-run lists what it would copy.

  Afterward, set storage.kind = s3 (or COSIMO_STORAGE_KIND=s3) and restart, then run this again to
  catch anything written in between.`;

export async function moveAttachmentsCommand(argv: string[]) {
  const { values } = parse(argv, { "dry-run": { type: "boolean", default: false } });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  await withContext(values, async (ctx) => {
    const dryRun = Boolean(values["dry-run"]);
    let r: Awaited<ReturnType<typeof moveAttachments>>;
    try {
      r = await moveAttachments(ctx.config, (v) => ctx.secrets.reveal(v), { dryRun, progress });
    } catch (e) {
      throw new CliError((e as Error).message, 2, "missing_argument");
    }
    emit(Boolean(values.json), r, () => {
      process.stdout.write(
        `${dryRun ? "Would copy" : "Copied"} ${r.copied}, skipped ${r.skipped}, failed ${r.failed} (${Math.round(r.bytes / 1024)} KB)\n`,
      );
      for (const e of r.errors) process.stdout.write(`  FAILED ${e.key}: ${e.message}\n`);
      if (!dryRun && r.failed === 0 && r.copied + r.skipped > 0 && ctx.config.storage.kind !== "s3")
        process.stdout.write(
          "Next: set storage.kind = s3 (or COSIMO_STORAGE_KIND=s3) and restart. Run this again afterward to catch anything written in between.\n",
        );
    });
    if (r.failed) throw new CliError(`${r.failed} file(s) failed to copy`, 1, "copy_failed");
  });
}
