import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Client, createClient } from "@libsql/client";
import { migrate, orgMigrations } from "./migrate.ts";

const dir = mkdtempSync(join(tmpdir(), "cosimo-migrate-"));
let client: Client;

beforeAll(() => {
  client = createClient({ url: `file:${join(dir, "org.db")}` });
});
afterAll(() => {
  client.close();
  rmSync(dir, { recursive: true, force: true });
});

test("0002 detaches invalid sub-accounts and copies the top-level detail type and tax line down", async () => {
  const upTo = orgMigrations.findIndex((m) => m.tag === "0002_account_hierarchy");
  expect(upTo).toBeGreaterThan(0);
  await migrate(client, orgMigrations.slice(0, upTo));
  const rows: [string, string, string, string, string | null, string | null, number, string | null][] = [
    // id, code, type, subtype, parent, tax line, is_system, system_key
    ["p", "6000", "expense", "office", null, "schc.18", 0, null],
    ["c", "6010", "expense", "other", "p", null, 0, null],
    ["g", "6011", "expense", "cogs", "c", "schc.27a", 0, null],
    ["x", "1500", "asset", "fixed_asset", "p", "sched.x", 0, null],
    ["xc", "1510", "asset", "other", "x", null, 0, null],
    ["d", "6900", "expense", "travel", "missing", "schc.24a", 0, null],
    ["s", "6999", "expense", "other", "p", null, 1, "uncategorized_expense"],
  ];
  for (const [id, code, type, subtype, parent, tax, sys, key] of rows)
    await client.execute({
      sql: "INSERT INTO accounts (id, code, name, type, subtype, parent_id, tax_line, is_system, system_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [id, code, `Account ${code}`, type, subtype, parent, tax, sys, key],
    });

  expect(await migrate(client, orgMigrations)).toEqual(["0002_account_hierarchy"]);
  const rs = await client.execute("SELECT id, type, subtype, parent_id, tax_line FROM accounts ORDER BY id");
  const got = Object.fromEntries(
    rs.rows.map((r) => [String(r.id), [r.type, r.subtype, r.parent_id, r.tax_line]]),
  );
  expect(got).toEqual({
    p: ["expense", "office", null, "schc.18"],
    // Children and grandchildren take the top-level account's values.
    c: ["expense", "office", "p", "schc.18"],
    g: ["expense", "office", "c", "schc.18"],
    // A child of another type is detached with its values (and its own subtree's root) kept.
    x: ["asset", "fixed_asset", null, "sched.x"],
    xc: ["asset", "fixed_asset", "x", "sched.x"],
    // Dangling parents and system accounts become top level, unchanged.
    d: ["expense", "travel", null, "schc.24a"],
    s: ["expense", "other", null, null],
  });
});
