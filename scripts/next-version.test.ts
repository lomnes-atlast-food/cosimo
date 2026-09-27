import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const NEXT_VERSION_SH = join(import.meta.dir, "next-version.sh");

interface ParsedOutput {
  version: string;
  tag: string;
  sha: string;
  publish: string;
  prerelease: string;
}

function parseOutput(stdout: string): ParsedOutput {
  const lines = stdout.trim().split("\n");
  const result: Record<string, string> = {};
  for (const line of lines) {
    if (!line) continue;
    const [key, ...valueParts] = line.split("=");
    if (key) {
      result[key] = valueParts.join("=");
    }
  }
  return {
    version: result.version ?? "",
    tag: result.tag ?? "",
    sha: result.sha ?? "",
    publish: result.publish ?? "",
    prerelease: result.prerelease ?? "",
  };
}

function runDryRun(env: Record<string, string>): ParsedOutput {
  // Don't inherit stray FAKE_* vars from process.env
  const processEnv = { ...process.env };
  for (const key of Object.keys(processEnv)) {
    if (key.startsWith("FAKE_")) {
      delete processEnv[key];
    }
  }
  const finalEnv = { ...processEnv, ...env };

  const proc = Bun.spawnSync(["bash", NEXT_VERSION_SH, "--dry-run"], {
    env: finalEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.exitCode !== 0) {
    throw new Error(`Script failed with exit code ${proc.exitCode}: ${proc.stderr.toString()}`);
  }

  return parseOutput(proc.stdout.toString());
}

describe.skipIf(process.platform === "win32")("scripts/next-version.sh", () => {
  test("Regression for #36: unlabeled PR blocks skip", () => {
    const output = runDryRun({
      FAKE_TAGS: "v0.1.1",
      FAKE_HEAD: "head123",
      FAKE_COMMITS: "c1\nc2\nc3",
      FAKE_LABELS_c1: "release:skip",
      FAKE_LABELS_c2: "release:skip",
      // c3 has no label (unlabeled)
      FAKE_CHANGED_FILES: "apps/server/src/x.ts",
    });

    expect(output.version).toBe("0.1.2");
    expect(output.publish).toBe("true");
  });

  test("Commit with no PR plus skip PR publishes patch", () => {
    const output = runDryRun({
      FAKE_TAGS: "v0.1.1",
      FAKE_HEAD: "head123",
      FAKE_COMMITS: "c1\nc2",
      FAKE_LABELS_c1: "release:skip",
      // c2 has no FAKE_LABELS_* (no PR)
      FAKE_CHANGED_FILES: "apps/server/src/x.ts",
    });

    expect(output.version).toBe("0.1.2");
    expect(output.publish).toBe("true");
  });

  test("Every commit labeled skip gives publish=false", () => {
    const output = runDryRun({
      FAKE_TAGS: "v0.1.1",
      FAKE_HEAD: "head123",
      FAKE_COMMITS: "c1\nc2",
      FAKE_LABELS_c1: "release:skip",
      FAKE_LABELS_c2: "release:skip",
      FAKE_CHANGED_FILES: "apps/server/src/x.ts",
    });

    expect(output.version).toBe("");
    expect(output.publish).toBe("false");
  });

  test("Skip PR plus release:minor PR gives minor bump", () => {
    const output = runDryRun({
      FAKE_TAGS: "v0.1.1",
      FAKE_HEAD: "head123",
      FAKE_COMMITS: "c1\nc2",
      FAKE_LABELS_c1: "release:skip",
      FAKE_LABELS_c2: "release:minor",
      FAKE_CHANGED_FILES: "apps/server/src/x.ts",
    });

    expect(output.version).toBe("0.2.0");
    expect(output.publish).toBe("true");
  });

  test("release:major wins over release:minor", () => {
    const output = runDryRun({
      FAKE_TAGS: "v0.1.1",
      FAKE_HEAD: "head123",
      FAKE_COMMITS: "c1\nc2",
      FAKE_LABELS_c1: "release:minor",
      FAKE_LABELS_c2: "release:major",
      FAKE_CHANGED_FILES: "apps/server/src/x.ts",
    });

    expect(output.version).toBe("1.0.0");
    expect(output.publish).toBe("true");
  });

  test("Only unlabeled commits give patch", () => {
    const output = runDryRun({
      FAKE_TAGS: "v0.1.1",
      FAKE_HEAD: "head123",
      FAKE_COMMITS: "c1\nc2",
      // No labels for any commit
      FAKE_CHANGED_FILES: "apps/server/src/x.ts",
    });

    expect(output.version).toBe("0.1.2");
    expect(output.publish).toBe("true");
  });

  test("Docs-only changed files give publish=false", () => {
    const output = runDryRun({
      FAKE_TAGS: "v0.1.1",
      FAKE_HEAD: "head123",
      FAKE_COMMITS: "c1",
      FAKE_LABELS_c1: "release:minor",
      FAKE_CHANGED_FILES: "README.md\ndocs/guide.md",
    });

    expect(output.version).toBe("");
    expect(output.publish).toBe("false");
  });

  test("No tags gives 0.3.0", () => {
    const output = runDryRun({
      FAKE_HEAD: "head123",
      FAKE_COMMITS: "c1",
      FAKE_LABELS_c1: "release:minor",
      FAKE_CHANGED_FILES: "apps/server/src/x.ts",
    });

    expect(output.version).toBe("0.3.0");
    expect(output.publish).toBe("true");
  });

  test("FAKE_HEAD_TAGGED=1 gives publish=false", () => {
    const output = runDryRun({
      FAKE_TAGS: "v0.1.1",
      FAKE_HEAD: "head123",
      FAKE_HEAD_TAGGED: "1",
      FAKE_COMMITS: "c1",
      FAKE_LABELS_c1: "release:minor",
      FAKE_CHANGED_FILES: "apps/server/src/x.ts",
    });

    expect(output.version).toBe("");
    expect(output.publish).toBe("false");
  });

  test.skipIf(!Bun.which("shellcheck"))("passes shellcheck", () => {
    const proc = Bun.spawnSync(["shellcheck", NEXT_VERSION_SH]);
    expect(proc.stdout.toString()).toBe("");
    expect(proc.exitCode).toBe(0);
  });
});
