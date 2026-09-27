import { existsSync, readFileSync } from "node:fs";
import * as p from "@clack/prompts";
import { today } from "@cosimo/shared";
import { defaultDataDir } from "../../config.ts";
import { resolveAnswers } from "../../setup/answers.ts";
import { HOST_ONLY_ANSWERS, makeDeployer, makePreflight } from "../../setup/deploy.ts";
import { applyInit, InitError } from "../../setup/init.ts";
import {
  type Answers,
  defaultFor,
  evalCondition,
  type InitEnv,
  questionDefs,
  questionsDocument,
} from "../../setup/questions.ts";
import { CliError, emit, parse, progress, readStdin } from "../util.ts";
import { serveCommand } from "./serve.ts";

/** True when the instance answers /readyz within a few seconds (e.g. a just-installed service). */
async function serverResponds(url: string) {
  for (let i = 0; i < 10; i++) {
    try {
      if ((await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(1000) })).ok) return true;
    } catch {}
    await Bun.sleep(500);
  }
  return false;
}

/** Best effort: open the claim link (or URL) after an interactive local setup. */
function openBrowser(url: string) {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // no browser available
  }
}

async function discoverTurso(): Promise<{ org: string | null; token: string | null }> {
  try {
    const org = Bun.spawnSync(["turso", "org", "list"], { stderr: "ignore" });
    const token = Bun.spawnSync(["turso", "auth", "token"], { stderr: "ignore" });
    const orgLine = org.stdout
      .toString()
      .split("\n")
      .find((l) => l.includes("(current)"));
    return {
      org: orgLine?.trim().split(/\s+/)[1] ?? orgLine?.trim().split(/\s+/)[0] ?? null,
      token: token.exitCode === 0 ? token.stdout.toString().trim() || null : null,
    };
  } catch {
    return { org: null, token: null };
  }
}

async function interactive(initEnv: InitEnv, preset: Answers): Promise<Answers> {
  p.intro("Cosimo setup");
  const answers: Answers = {};
  for (const q of questionDefs()) {
    if (!evalCondition(q.ask_when, answers)) continue;
    if (preset[q.id] !== undefined) {
      answers[q.id] = preset[q.id];
      continue;
    }
    const def = defaultFor(q, answers, initEnv);
    let v: unknown;
    const message = q.prompt + (q.help ? `\n  ${q.help}` : "");
    switch (q.type) {
      case "choice":
        v = await p.select({
          message,
          options: (q.choices ?? []).map((c) => ({ value: c, label: c })),
          initialValue: def as string,
        });
        break;
      case "boolean":
        v = await p.confirm({ message: q.prompt, initialValue: Boolean(def) });
        break;
      case "secret":
        v = await p.password({ message, validate: (x) => (q.required && !x ? "Required" : undefined) });
        break;
      default:
        v = await p.text({
          message,
          placeholder: def == null ? undefined : String(def),
          defaultValue: def == null ? undefined : String(def),
          validate: (x) => (q.required && !x && def == null ? "Required" : undefined),
        });
        if (q.type === "integer" && typeof v === "string") v = Number(v);
    }
    if (p.isCancel(v)) {
      p.cancel("Setup cancelled.");
      process.exit(1);
    }
    answers[q.id] = v === "" ? def : v;
  }
  if (answers.admin_auth === "prompt") {
    for (;;) {
      const a = await p.password({ message: "Choose a password (at least 10 characters)" });
      if (p.isCancel(a)) process.exit(1);
      const b = await p.password({ message: "Repeat the password" });
      if (p.isCancel(b)) process.exit(1);
      if (a !== b) p.log.error("Passwords do not match.");
      else if (String(a).length < 10) p.log.error("Too short.");
      else {
        answers.admin_password = a;
        break;
      }
    }
  }
  return answers;
}

export async function initCommand(argv: string[]) {
  const { values } = parse(argv, {
    answers: { type: "string" },
    yes: { type: "boolean", short: "y", default: false },
    questions: { type: "boolean", default: false },
    reconfigure: { type: "boolean", default: false },
    "no-deploy": { type: "boolean", default: false },
    "in-container": { type: "boolean", default: false },
  });
  const inContainer = Boolean(values["in-container"]);
  if (values.questions) {
    emit(true, questionsDocument());
    return;
  }
  const json = Boolean(values.json);
  const turso = process.env.COSIMO_INIT_SKIP_TURSO_DISCOVERY
    ? { org: null, token: null }
    : await discoverTurso();
  const initEnv: InitEnv = {
    json,
    today: today(),
    homeDataDir: defaultDataDir(),
    tursoOrg: turso.org,
    tursoToken: turso.token,
  };

  let supplied: Answers = {};
  if (typeof values.answers === "string") {
    const src = values.answers;
    const text = src === "-" ? await readStdin() : existsSync(src) ? readFileSync(src, "utf8") : null;
    if (text === null) throw new CliError(`Answers file not found: ${src}`, 2, "answers_not_found");
    try {
      supplied = JSON.parse(text);
    } catch (e) {
      throw new CliError(`Answers are not valid JSON: ${(e as Error).message}`, 2, "invalid_answers");
    }
  }
  const nonInteractive =
    inContainer || values.yes || json || !process.stdin.isTTY || typeof values.answers === "string";
  if (!nonInteractive) supplied = await interactive(initEnv, supplied);

  const resolved = resolveAnswers(supplied, process.env, initEnv);
  if (inContainer) resolved.missing = resolved.missing.filter((id) => !HOST_ONLY_ANSWERS.has(id));
  if (resolved.missing.length || resolved.invalid.length) {
    throw new CliError(
      resolved.missing.length
        ? `Missing required answers: ${resolved.missing.join(", ")}`
        : "Invalid answers",
      2,
      resolved.missing.length ? "missing_answers" : "invalid_answers",
      { missing: resolved.missing, invalid: resolved.invalid },
    );
  }
  if (!nonInteractive) {
    const ok = await p.confirm({ message: "Create the instance with these answers?", initialValue: true });
    if (p.isCancel(ok) || !ok) {
      p.cancel("Nothing was changed.");
      return;
    }
  }
  try {
    const result = await applyInit(resolved.answers, {
      configPath: values.config,
      reconfigure: values.reconfigure as boolean,
      inContainer,
      log: progress,
      preflight: makePreflight({ noDeploy: Boolean(values["no-deploy"]) }),
      deploy: makeDeployer({ noDeploy: Boolean(values["no-deploy"]), log: progress }),
    });
    const interactiveLocal = !json && !nonInteractive && result.target === "local";
    const running = interactiveLocal && (await serverResponds(result.url));
    if (running) openBrowser(result.claim_link ?? result.url);
    emit(json, result, () => {
      const lines = [
        "",
        `Cosimo is set up (${result.target}, ${result.database}).`,
        `  URL:         ${result.url}`,
        result.claim_link
          ? `  Claim link:  ${result.claim_link}  (valid until ${result.claim_link_expires_at})`
          : "",
        `  Config:      ${result.config_path}`,
        `  Master key:  ${result.master_key_location}`,
        "",
        "IMPORTANT: losing the master key makes stored bank connections unrecoverable.",
        "",
        "Next steps:",
        ...result.next_steps.map((s) => `  - ${s}`),
        ...result.warnings.map((w) => `  ! ${w}`),
        "",
      ];
      process.stdout.write(`${lines.filter((l) => l !== "").join("\n")}\n`);
    });
    // No background service answering: offer to run the server here, so the claim link works.
    if (interactiveLocal && !running) {
      const start = await p.confirm({
        message: "Start Cosimo now and open the claim link? It runs in this terminal until Ctrl+C.",
        initialValue: true,
      });
      if (!p.isCancel(start) && start)
        await serveCommand(["--config", result.config_path], { openUrl: result.claim_link ?? result.url });
      else p.note(`Start it later with: cosimo serve --config ${result.config_path}`);
    }
  } catch (e) {
    if (e instanceof InitError) throw new CliError(e.message, e.exitCode, e.code, e.details);
    throw e;
  }
}
