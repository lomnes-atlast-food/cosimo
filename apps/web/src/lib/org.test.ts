import { describe, expect, test } from "bun:test";
import { groupOrgs } from "./org";

function org(name: string, is_sample = false) {
  return { name, is_sample };
}

describe("groupOrgs", () => {
  test("sample orgs come last even when the server returns them first", () => {
    const { real, sample } = groupOrgs([org("Demo Studio (sample data)", true), org("Acme Co")]);
    expect(real.map((o) => o.name)).toEqual(["Acme Co"]);
    expect(sample.map((o) => o.name)).toEqual(["Demo Studio (sample data)"]);
  });

  test("empty groups when there are only real or only sample orgs", () => {
    expect(groupOrgs([org("Acme Co"), org("Zebra Co")]).sample).toEqual([]);
    expect(groupOrgs([org("Demo Studio (sample data)", true)]).real).toEqual([]);
  });

  test("names are sorted case-insensitively within each group", () => {
    const { real, sample } = groupOrgs([
      org("zebra co"),
      org("Acme Co"),
      org("Demo B (sample data)", true),
      org("demo a (sample data)", true),
    ]);
    expect(real.map((o) => o.name)).toEqual(["Acme Co", "zebra co"]);
    expect(sample.map((o) => o.name)).toEqual(["demo a (sample data)", "Demo B (sample data)"]);
  });
});
