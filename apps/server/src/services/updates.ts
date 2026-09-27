/**
 * The admin update indicator (issue #12): asks GitHub Releases for the latest version and caches
 * the answer in memory per `AppContext`, so an admin viewing a page doesn't hit the API on every
 * request. There is no scheduler job and no DB table for this: the cache lives only as long as the
 * process, which is fine for a check nothing else depends on (see DECISIONS.md).
 */
import { COMMIT, DEV_VERSION, VERSION } from "@cosimo/shared";
import type { AppContext } from "../context.ts";
import {
  compareVersions,
  fetchLatestRelease,
  type LatestRelease,
  UpgradeError,
  upgradeInstructions,
} from "./upgrade.ts";

const OK_TTL_MS = 12 * 3_600_000;
const ERROR_TTL_MS = 3_600_000;

export interface UpdateStatus {
  current: string;
  commit: string;
  status: "up_to_date" | "available" | "disabled" | "dev" | "unknown";
  latest: LatestRelease | null;
  checked_at: string | null;
  error: string | null;
  instructions: string[];
}

export interface CheckDeps {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  now: () => number;
  /** The running version. Overridable (default: the real build VERSION) so tests can exercise the
   * network path without a real build; DEV_VERSION always short-circuits to `dev`. */
  current: string;
}

export function defaultCheckDeps(env: Record<string, string | undefined> = process.env): CheckDeps {
  return { fetch, env, now: () => Date.now(), current: VERSION };
}

type CacheEntry =
  | { kind: "ready"; at: number; ttl: number; value: UpdateStatus }
  | { kind: "pending"; promise: Promise<UpdateStatus> };

const cache = new WeakMap<AppContext, CacheEntry>();

function noCheck(status: "disabled" | "dev", current: string): UpdateStatus {
  return { current, commit: COMMIT, status, latest: null, checked_at: null, error: null, instructions: [] };
}

export async function checkForUpdate(
  ctx: AppContext,
  deps: CheckDeps,
  opts: { refresh?: boolean } = {},
): Promise<UpdateStatus> {
  if (deps.current === DEV_VERSION) return noCheck("dev", deps.current);
  if (!ctx.config.updates.check) return noCheck("disabled", deps.current);

  if (!opts.refresh) {
    const entry = cache.get(ctx);
    if (entry?.kind === "ready" && deps.now() - entry.at < entry.ttl) return entry.value;
    if (entry?.kind === "pending") return entry.promise;
  }

  const promise = (async (): Promise<UpdateStatus> => {
    const token = ctx.secrets.reveal(ctx.config.updates.github_token) ?? undefined;
    try {
      const latest = await fetchLatestRelease(deps.fetch, deps.env, token);
      const status = compareVersions(latest.version, deps.current) > 0 ? "available" : "up_to_date";
      return {
        current: deps.current,
        commit: COMMIT,
        status,
        latest,
        checked_at: new Date(deps.now()).toISOString(),
        error: null,
        instructions:
          status === "available" ? upgradeInstructions(ctx.config.instance.target, latest.version) : [],
      };
    } catch (e) {
      return {
        current: deps.current,
        commit: COMMIT,
        status: "unknown",
        latest: null,
        checked_at: new Date(deps.now()).toISOString(),
        error: e instanceof UpgradeError ? e.message : (e as Error).message,
        instructions: [],
      };
    }
  })().then((value) => {
    cache.set(ctx, {
      kind: "ready",
      at: deps.now(),
      ttl: value.status === "unknown" ? ERROR_TTL_MS : OK_TTL_MS,
      value,
    });
    return value;
  });
  cache.set(ctx, { kind: "pending", promise });
  return promise;
}
