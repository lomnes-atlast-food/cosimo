/** Instance config (SPEC §13.7): `COSIMO_<SECTION>_<KEY>` env overrides and secret masking. */
import { describe, expect, test } from "bun:test";
import { applyEnv, defaultConfig, listKeys, SECRET_KEYS } from "../src/config.ts";

describe("updates config", () => {
  test("defaults to on, with no token", () => {
    const cfg = defaultConfig();
    expect(cfg.updates).toEqual({ check: true, github_token: "" });
  });

  test("COSIMO_UPDATES_CHECK and COSIMO_UPDATES_GITHUB_TOKEN override the defaults", () => {
    const cfg = applyEnv(defaultConfig(), {
      COSIMO_UPDATES_CHECK: "false",
      COSIMO_UPDATES_GITHUB_TOKEN: "ghp_example",
    });
    expect(cfg.updates).toEqual({ check: false, github_token: "ghp_example" });
  });

  test("the token is a secret key and is masked by listKeys", () => {
    expect(SECRET_KEYS.has("updates.github_token")).toBe(true);
    const cfg = applyEnv(defaultConfig(), { COSIMO_UPDATES_GITHUB_TOKEN: "ghp_example" });
    const row = listKeys(cfg).find((r) => r.key === "updates.github_token");
    expect(row).toMatchObject({ value: "********", secret: true });
  });

  test("an empty token is left blank, not masked", () => {
    const row = listKeys(defaultConfig()).find((r) => r.key === "updates.github_token");
    expect(row).toMatchObject({ value: "", secret: true });
  });
});

describe("anchoring config", () => {
  test("public timestamps are on by default with the public services", () => {
    expect(defaultConfig().anchoring).toEqual({
      enabled: true,
      ots_calendars:
        "https://alice.btc.calendar.opentimestamps.org,https://bob.btc.calendar.opentimestamps.org,https://finney.calendar.eternitywall.com",
      tsa_url: "https://freetsa.org/tsr",
      tsa_ca_file: "",
      bitcoin_api: "https://blockstream.info/api",
    });
  });

  test("COSIMO_ANCHORING_* overrides them", () => {
    const cfg = applyEnv(defaultConfig(), {
      COSIMO_ANCHORING_ENABLED: "0",
      COSIMO_ANCHORING_OTS_CALENDARS: "https://a.example",
      COSIMO_ANCHORING_TSA_URL: "",
    });
    expect(cfg.anchoring).toMatchObject({ enabled: false, ots_calendars: "https://a.example", tsa_url: "" });
  });
});
