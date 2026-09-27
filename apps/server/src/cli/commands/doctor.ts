import { runDoctor } from "../../services/doctor.ts";
import { emit, parse } from "../util.ts";

const MARK = { pass: "✓", warn: "!", fail: "✗" } as const;

/** `cosimo doctor [--json] [--full]`: exit 1 when any check fails. */
export async function doctorCommand(argv: string[]) {
  const { values } = parse(argv, { full: { type: "boolean", default: false } });
  const r = await runDoctor({ configPath: values.config, chainTail: values.full ? 0 : 200 });
  emit(Boolean(values.json), r, () => {
    const w = Math.max(...r.checks.map((c) => c.name.length));
    const lines = r.checks.map((c) => {
      const head = `${MARK[c.status]} ${c.name.padEnd(w)}  ${c.message}`;
      return c.remediation ? `${head}\n  ${" ".repeat(w)}  → ${c.remediation}` : head;
    });
    process.stdout.write(
      `Cosimo ${r.version}  (${r.config_path})\n\n${lines.join("\n")}\n\n${r.status === "pass" ? "All checks passed." : r.status === "warn" ? "Passed with warnings." : "Some checks failed."}\n`,
    );
  });
  if (r.status === "fail") process.exitCode = 1;
}
