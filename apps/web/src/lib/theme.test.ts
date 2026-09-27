import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : /\.tsx?$/.test(e.name) && !/\.(d|test)\.tsx?$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );
}

// Tailwind silently skips a class whose color isn't in the theme, so a missing shade (such as a
// dark-mode `text-brand-300`) leaves the light color in place, unreadable on a dark background.
test("every custom color shade used in a class is defined in the theme", () => {
  const css = readFileSync(join(SRC, "styles.css"), "utf8");
  const defined = new Set([...css.matchAll(/--color-((?:brand|gold)-\d+):/g)].map((m) => m[1]));
  const missing = sources(SRC).flatMap((f) =>
    [...readFileSync(f, "utf8").matchAll(/\b(?:[a-z]+:)*[a-z]+-((?:brand|gold)-\d+)\b/g)]
      .map((m) => m[1]!)
      .filter((c) => !defined.has(c))
      .map((c) => `${f.slice(SRC.length + 1)}: ${c}`),
  );
  expect(missing).toEqual([]);
});
