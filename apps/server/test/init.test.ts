import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createContext } from "../src/context.ts";
import { silentLogger } from "../src/logger.ts";
import { resolveAnswers } from "../src/setup/answers.ts";
import { applyInit, InitError } from "../src/setup/init.ts";
import { evalCondition, questionsDocument } from "../src/setup/questions.ts";

const dirs: string[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "cosimo-init-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const initEnv = (json = true) => ({
  json,
  today: "2026-09-25",
  homeDataDir: "/home/x/.cosimo",
  tursoOrg: null,
  tursoToken: null,
});

describe("init questions", () => {
  test("condition evaluator", () => {
    expect(evalCondition("", {})).toBe(true);
    expect(evalCondition("target == 'docker'", { target: "docker" })).toBe(true);
    expect(evalCondition("target == 'docker'", { target: "local" })).toBe(false);
    expect(evalCondition("plaid_enabled", { plaid_enabled: true })).toBe(true);
    expect(evalCondition("storage == 's3' || backups == 's3'", { storage: "local", backups: "s3" })).toBe(
      true,
    );
    expect(
      evalCondition("!plaid_enabled && target != 'fly'", { plaid_enabled: false, target: "local" }),
    ).toBe(true);
  });

  test("defaults produce a complete local answer set with only the required inputs", () => {
    const r = resolveAnswers({ admin_email: "me@example.com", org_name: "Acme" }, {}, initEnv());
    expect(r.missing).toEqual([]);
    expect(r.invalid).toEqual([]);
    expect(r.answers).toMatchObject({
      target: "local",
      database: "sqlite",
      data_dir: "/home/x/.cosimo",
      admin_auth: "claim_link",
      signup_mode: "single_user",
      coa_template: "schedule_c",
      books_start_date: "2026-01-01",
      service: true,
    });
    expect("domain" in r.answers).toBe(false);
  });

  test("missing and invalid answers are reported", () => {
    const r = resolveAnswers(
      { target: "docker", entity_type: "llc", fiscal_year_start_month: 13 },
      {},
      initEnv(),
    );
    expect(r.missing.sort()).toEqual(["admin_email", "domain", "org_name"]);
    expect(r.invalid.map((i) => i.id).sort()).toEqual(["entity_type", "fiscal_year_start_month"]);
    expect(r.answers.signup_mode).toBe("invite_only");
    expect(r.answers.data_dir).toBe("/data");
  });

  test("environment variables take precedence over the file", () => {
    const r = resolveAnswers(
      { admin_email: "file@example.com", org_name: "Acme" },
      { COSIMO_INIT_ADMIN_EMAIL: "env@example.com", COSIMO_INIT_PLAID_ENABLED: "true" },
      initEnv(),
    );
    expect(r.answers.admin_email).toBe("env@example.com");
    expect(r.missing.sort()).toEqual(["plaid_client_id", "plaid_secret"]);
  });

  test("question document shape", () => {
    const doc = questionsDocument();
    expect(doc.schema_version).toBe(1);
    for (const q of doc.questions) {
      expect(Object.keys(q)).toEqual(
        expect.arrayContaining(["id", "prompt", "help", "type", "default", "required", "secret", "ask_when"]),
      );
    }
    expect(doc.questions.filter((q) => q.secret).map((q) => q.id)).toEqual([
      "turso_api_token",
      "plaid_secret",
      "smtp_password",
      "s3_secret_key",
    ]);
  });
});

describe("applyInit (local)", () => {
  test("creates a working instance and refuses to run twice", async () => {
    const dir = tmp();
    const r = resolveAnswers(
      {
        admin_email: "me@example.com",
        admin_name: "Me",
        org_name: "Acme LLC",
        data_dir: dir,
        service: false,
      },
      {},
      initEnv(),
    );
    const result = await applyInit(r.answers, { env: {} });
    expect(result.status).toBe("ok");
    expect(result.config_path).toBe(join(dir, "config.toml"));
    expect(result.claim_link).toMatch(/^http:\/\/localhost:8787\/claim\/.+/);
    expect(result.org_id).toBeTruthy();
    expect(result.master_key_location).toBe(result.config_path);
    expect(statSync(result.config_path).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dir, "data", "system.db"))).toBe(true);
    expect(existsSync(join(dir, "data", "orgs", `${result.org_id}.db`))).toBe(true);

    const loaded = loadConfig(result.config_path, {});
    const ctx = await createContext(loaded.effective, { logger: silentLogger });
    const admin = await ctx.users.byEmail("me@example.com");
    expect(admin?.isInstanceAdmin).toBe(true);
    expect(admin?.passwordHash).toBeNull();
    expect(await ctx.orgs.membership(admin!.id, result.org_id!)).toBe("owner");
    await ctx.close();

    await expect(applyInit(r.answers, { env: {} })).rejects.toMatchObject({ exitCode: 5 });
    const re = await applyInit({ ...r.answers, signup_mode: "invite_only" }, { env: {}, reconfigure: true });
    expect(re.org_id).toBe(result.org_id);
    expect(re.claim_link).toBeNull();
  });

  test("InitError carries exit codes", () => {
    expect(new InitError(2, "missing_answers", "x").exitCode).toBe(2);
  });
});

describe("cli", () => {
  const cli = join(import.meta.dir, "..", "src", "cli", "main.ts");
  const run = (args: string[], env: Record<string, string> = {}, stdin?: string) => {
    const p = Bun.spawnSync(["bun", cli, ...args], {
      env: { ...process.env, COSIMO_INIT_SKIP_TURSO_DISCOVERY: "1", ...env },
      stdin: stdin ? new TextEncoder().encode(stdin) : undefined,
    });
    return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
  };

  test("init --questions --json", () => {
    const r = run(["init", "--questions", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).questions.length).toBeGreaterThan(20);
  });

  test("missing answers exit 2 with the missing ids; rerun exits 5", () => {
    const dir = tmp();
    const answers = join(dir, "answers.json");
    writeFileSync(answers, JSON.stringify({ data_dir: dir, service: false }));
    const miss = run(["init", "--answers", answers, "--yes", "--json"]);
    expect(miss.code).toBe(2);
    const body = JSON.parse(miss.stdout);
    expect(body.status).toBe("error");
    expect(body.missing.sort()).toEqual(["admin_email", "org_name"]);
    expect(existsSync(join(dir, "config.toml"))).toBe(false);

    const ok = run(
      ["init", "--answers", "-", "--yes", "--json"],
      {},
      JSON.stringify({
        data_dir: dir,
        service: false,
        admin_email: "cli@example.com",
        org_name: "CLI Co",
      }),
    );
    expect(ok.code).toBe(0);
    const res = JSON.parse(ok.stdout);
    expect(res.status).toBe("ok");
    expect(res.claim_link).toContain("/claim/");
    expect(ok.stdout).not.toContain('master_key"');

    const again = run(
      ["init", "--answers", "-", "--yes", "--json"],
      {},
      JSON.stringify({ data_dir: dir, admin_email: "cli@example.com", org_name: "CLI Co" }),
    );
    expect(again.code).toBe(5);

    const users = run(["user", "list", "--json", "--config", join(dir, "config.toml")]);
    expect(users.code).toBe(0);
    expect(JSON.parse(users.stdout)[0].email).toBe("cli@example.com");

    const v = run(["verify", res.org_id, "--json", "--config", join(dir, "config.toml")]);
    expect(v.code).toBe(0);
    const vb = JSON.parse(v.stdout);
    expect(vb.status).toBe("ok");
    expect(vb.results[0].audit.checked).toBeGreaterThan(0);
    expect(run(["verify", "nope", "--config", join(dir, "config.toml")]).code).toBe(1);
  });
});
