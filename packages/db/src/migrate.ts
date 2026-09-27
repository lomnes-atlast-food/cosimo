import type { Client } from "@libsql/client";
import { type Migration, orgMigrations, systemMigrations } from "./migrations.gen.ts";

export { orgMigrations, systemMigrations };

const TABLE = "_cosimo_migrations";

async function ensureTable(client: Client) {
  await client.execute(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (tag TEXT PRIMARY KEY, hash TEXT NOT NULL, applied_at TEXT NOT NULL)`,
  );
}

export async function appliedMigrations(client: Client): Promise<string[]> {
  await ensureTable(client);
  const rs = await client.execute(`SELECT tag FROM ${TABLE} ORDER BY tag`);
  return rs.rows.map((r) => String(r.tag));
}

export async function pendingMigrations(client: Client, set: Migration[]): Promise<Migration[]> {
  const applied = new Set(await appliedMigrations(client));
  return set.filter((m) => !applied.has(m.tag));
}

/**
 * Apply pending migrations, one write transaction per migration. Forward-only.
 * Returns the tags applied.
 */
export async function migrate(client: Client, set: Migration[]): Promise<string[]> {
  const pending = await pendingMigrations(client, set);
  const done: string[] = [];
  for (const m of pending) {
    const statements = m.sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.replace(/--.*$/gm, "").trim().length > 0);
    const tx = await client.transaction("write");
    try {
      for (const s of statements) await tx.execute(s);
      await tx.execute({
        sql: `INSERT INTO ${TABLE} (tag, hash, applied_at) VALUES (?, ?, ?)`,
        args: [m.tag, m.hash, new Date().toISOString()],
      });
      await tx.commit();
    } catch (e) {
      await tx.rollback().catch(() => {});
      throw new Error(`Migration ${m.tag} failed: ${(e as Error).message}`, { cause: e });
    } finally {
      tx.close();
    }
    done.push(m.tag);
  }
  return done;
}

export const migrateSystem = (c: Client) => migrate(c, systemMigrations);
export const migrateOrg = (c: Client) => migrate(c, orgMigrations);
