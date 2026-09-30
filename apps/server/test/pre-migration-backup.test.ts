import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { auditGenesis, ledgerGenesis } from "@cosimo/core";
import {
  connectOrg,
  migrate,
  migrateSystem,
  newId,
  org,
  orgMigrations,
  pendingMigrations,
  systemMigrations,
} from "@cosimo/db";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { hasPendingMigrations } from "../src/cli/commands/serve.ts";
import { coaSeeder } from "../src/services/accounts.ts";
import { SYSTEM_ACTOR } from "../src/services/actor.ts";
import { readZip } from "../src/services/archive.ts";
import { appendAudit } from "../src/services/audit.ts";
import { type BackupManifest, createBackup } from "../src/services/backup.ts";
import { verifyOrg } from "../src/services/chain.ts";
import { submitEntryTx } from "../src/services/ledger.ts";
import { createTestEnv, DB_MODE, type TestEnv } from "./harness.ts";

/**
 * `cosimo serve` backs up before it migrates, so the backup runs against the schema of the release
 * being upgraded from. For every older schema level, build an instance at that level and run the
 * startup sequence: pending check, pre-migration backup, then the migrations. Each new migration is
 * covered automatically.
 */

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

/** Proper, non-empty prefixes: an instance always has the first migration, and a current one has nothing to back up. */
const levels = (n: number) => Array.from({ length: Math.max(0, n - 1) }, (_, i) => i + 1);

async function instance(systemLevel: number) {
  env = await createTestEnv({ migrate: false, configure: (c) => (c.backups.mode = "local") });
  await migrate(env.ctx.system.client, systemMigrations.slice(0, systemLevel));
  return env;
}

/**
 * The fixture is written with the current code, which reads and writes every org_settings column.
 * Columns added by later migrations are added for the writes and dropped again, so the database
 * keeps the schema of its level.
 */
async function withCurrentSettingsColumns(h: ReturnType<typeof connectOrg>, fn: () => Promise<void>) {
  const rs = await h.client.execute("SELECT name FROM pragma_table_info('org_settings')");
  const have = new Set(rs.rows.map((r) => String(r.name)));
  const missing = getTableConfig(org.orgSettings).columns.filter((c) => !have.has(c.name));
  for (const c of missing)
    await h.client.execute(`ALTER TABLE org_settings ADD COLUMN "${c.name}" ${c.getSQLType()}`);
  await fn();
  for (const c of missing) await h.client.execute(`ALTER TABLE org_settings DROP COLUMN "${c.name}"`);
}

/** A chart of accounts, an audit row and a posted entry. */
async function seedOrg(h: ReturnType<typeof connectOrg>, id: string, name: string) {
  await h.write(async (tx) => {
    await tx.insert(org.schemaMeta).values([
      { key: "org_id", value: id },
      { key: "ledger_genesis", value: ledgerGenesis(id) },
      { key: "audit_genesis", value: auditGenesis(id) },
      { key: "created_at", value: new Date().toISOString() },
    ]);
    await tx.insert(org.orgSettings).values({ id: 1, orgId: id, legalName: name });
    await coaSeeder(tx, id, { name, createdBy: null });
    await appendAudit(tx, id, SYSTEM_ACTOR, { action: "org.create", targetType: "org", targetId: id });
  });
  const rs = await h.client.execute(
    "SELECT (SELECT id FROM accounts WHERE type = 'asset' AND is_system = 0 ORDER BY code LIMIT 1) AS a, " +
      "(SELECT id FROM accounts WHERE type = 'income' AND is_system = 0 ORDER BY code LIMIT 1) AS i",
  );
  const [asset, income] = [String(rs.rows[0]!.a), String(rs.rows[0]!.i)];
  await h.write((tx) =>
    submitEntryTx(
      tx,
      id,
      SYSTEM_ACTOR,
      {
        date: "2026-01-15",
        memo: "before the upgrade",
        lines: [
          { accountId: asset, amount: 12_500 },
          { accountId: income, amount: -12_500 },
        ],
      },
      { forcePost: true },
    ),
  );
}

/**
 * Create an org database at `orgLevel` with a chart of accounts, an audit row and a posted entry,
 * then register it with the columns of the first system migration only (as an old release did).
 */
async function addOrg(e: TestEnv, name: string, orgLevel: number, opts: { archived?: boolean } = {}) {
  const id = newId();
  const prov = await e.ctx.orgs.provisionDatabase(id);
  const h = connectOrg(prov.url, prov.authToken);
  try {
    await migrate(h.client, orgMigrations.slice(0, orgLevel));
    await withCurrentSettingsColumns(h, () => seedOrg(h, id, name));
  } finally {
    h.close();
  }
  await e.ctx.system.client.execute({
    sql: "INSERT INTO organizations (id, name, db_url, db_token_enc, archived_at) VALUES (?, ?, ?, ?, ?)",
    args: [
      id,
      name,
      prov.url,
      prov.authToken ? e.ctx.secrets.encrypt(prov.authToken) : null,
      opts.archived ? new Date().toISOString() : null,
    ],
  });
  return id;
}

/** The `serve` startup sequence, checked step by step. */
async function startUp(e: TestEnv, orgIds: string[]) {
  expect(await hasPendingMigrations(e.ctx)).toBe(true);
  const b = await createBackup(e.ctx, { reason: "pre-migration" });
  await migrateSystem(e.ctx.system.client);
  await e.ctx.orgs.migrateAll();

  const files = readZip(new Uint8Array(readFileSync(b.file)));
  const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]!)) as BackupManifest;
  expect(manifest.reason).toBe("pre-migration");
  expect(manifest.orgs.map((o) => o.id).sort()).toEqual([...orgIds].sort());
  for (const o of manifest.orgs) {
    expect(files[`orgs/${o.id}.db`]).toBeDefined();
    expect(o.ledger_head.seq).toBeGreaterThan(0);
  }

  // Fully migrated: nothing pending, the current code can read the registry, and the chains hold.
  expect(await pendingMigrations(e.ctx.system.client, systemMigrations)).toEqual([]);
  expect(await hasPendingMigrations(e.ctx)).toBe(false);
  expect((await e.ctx.orgs.list({ includeArchived: true })).map((o) => o.id).sort()).toEqual(
    [...orgIds].sort(),
  );
  for (const id of orgIds) {
    const h = await e.ctx.orgs.mustOpen(id);
    expect(await pendingMigrations(h.client, orgMigrations)).toEqual([]);
    expect((await verifyOrg(h.db, id)).ok).toBe(true);
  }
}

// Each test builds and migrates whole instances; on a busy CI runner with sqld that can pass 5s.
describe(`pre-migration backup (${DB_MODE})`, () => {
  test("there are older schema levels to cover", () => {
    expect(levels(systemMigrations.length).length).toBeGreaterThan(0);
    expect(levels(orgMigrations.length).length).toBeGreaterThan(0);
  });

  for (const n of levels(systemMigrations.length)) {
    test(`upgrading from system schema ${systemMigrations[n - 1]!.tag}`, async () => {
      const e = await instance(n);
      const ids = [
        await addOrg(e, "Old Co", orgMigrations.length),
        await addOrg(e, "Closed Co", orgMigrations.length, { archived: true }),
      ];
      await startUp(e, ids);
    });
  }

  for (const n of levels(orgMigrations.length)) {
    test(`upgrading from org schema ${orgMigrations[n - 1]!.tag}`, async () => {
      const e = await instance(systemMigrations.length);
      const ids = [await addOrg(e, "Old Co", n), await addOrg(e, "Closed Co", n, { archived: true })];
      await startUp(e, ids);
    });
  }
});
