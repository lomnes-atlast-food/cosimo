/**
 * Connection factory. This is the ONLY place that branches on local file vs libSQL server URLs.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type Client, createClient, LibsqlError } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { mutexFor } from "./mutex.ts";
import * as orgSchema from "./org/schema.ts";
import * as systemSchema from "./system/schema.ts";

export type SystemSchema = typeof systemSchema;
export type OrgSchema = typeof orgSchema;
export type SystemDb = LibSQLDatabase<SystemSchema>;
export type OrgDb = LibSQLDatabase<OrgSchema>;
export type Tx<S extends Record<string, unknown>> = Parameters<
  Parameters<LibSQLDatabase<S>["transaction"]>[0]
>[0];
export type OrgTx = Tx<OrgSchema>;
export type SystemTx = Tx<SystemSchema>;

export interface DbHandle<S extends Record<string, unknown>> {
  readonly url: string;
  readonly client: Client;
  readonly db: LibSQLDatabase<S>;
  readonly isLocal: boolean;
  /**
   * Run `fn` in a write transaction. Writes to one database are serialized in-process,
   * which also serializes ledger and audit chain extension per org.
   */
  write<T>(fn: (tx: Tx<S>) => Promise<T>): Promise<T>;
  close(): void;
}

export function isLocalUrl(url: string): boolean {
  return url.startsWith("file:") || url === ":memory:";
}

export function localPathFromUrl(url: string): string {
  return url.replace(/^file:(\/\/)?/, "");
}

export function fileUrl(path: string): string {
  return `file:${path}`;
}

function isBusy(e: unknown): boolean {
  return e instanceof LibsqlError && /SQLITE_BUSY|database is locked/i.test(`${e.code} ${e.message}`);
}

function open<S extends Record<string, unknown>>(url: string, schema: S, authToken?: string): DbHandle<S> {
  const local = isLocalUrl(url);
  if (local && url !== ":memory:") mkdirSync(dirname(localPathFromUrl(url)), { recursive: true });
  const client = createClient(
    local ? { url, timeout: 5000, intMode: "number" } : { url, authToken, intMode: "number" },
  );
  const db = drizzle(client, { schema });
  const mutex = mutexFor(url);
  let initialized: Promise<void> | null = null;
  const init = () => {
    initialized ??= (async () => {
      if (local && url !== ":memory:") await client.execute("PRAGMA journal_mode=WAL");
    })();
    return initialized;
  };
  return {
    url,
    client,
    db,
    isLocal: local,
    async write(fn) {
      await init();
      return mutex.run(async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await db.transaction(fn);
          } catch (e) {
            if (isBusy(e) && attempt < 20) {
              await Bun.sleep(50 * (attempt + 1));
              continue;
            }
            throw e;
          }
        }
      });
    },
    close() {
      client.close();
    },
  };
}

export function connectSystem(url: string, authToken?: string): DbHandle<SystemSchema> {
  return open(url, systemSchema, authToken);
}

export function connectOrg(url: string, authToken?: string): DbHandle<OrgSchema> {
  return open(url, orgSchema, authToken);
}
