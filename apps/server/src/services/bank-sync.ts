/**
 * Bank feed sync status shared by the Plaid service and the bank account views: which syncs are
 * running now, and how each connection's last sync went. Kept apart from `plaid.ts`, which imports
 * `banking.ts`, so both can use it without an import cycle.
 */
import type { org } from "@cosimo/db";

type ConnRow = typeof org.bankConnections.$inferSelect;

// ----------------------------------------------------------------------------- in-flight syncs

// Keyed by connection ID (ULIDs are unique across orgs).
const inFlight = new Map<string, Promise<unknown>>();

/** True while a sync of this connection is running. */
export function isSyncing(connectionId: string): boolean {
  return inFlight.has(connectionId);
}

/** Run `start` unless a sync of this connection is already running; then share that run. */
export function trackSync<T>(connectionId: string, start: () => Promise<T>): Promise<T> {
  const running = inFlight.get(connectionId);
  if (running) return running as Promise<T>;
  const p = start().finally(() => inFlight.delete(connectionId));
  inFlight.set(connectionId, p);
  return p;
}

// ----------------------------------------------------------------------------- messages

export const STATUS_HELP: Record<string, string> = {
  ITEM_LOGIN_REQUIRED: "The bank needs you to sign in again.",
  PENDING_EXPIRATION: "Access expires soon. Reconnect to keep transactions flowing.",
  PENDING_DISCONNECT: "The bank will disconnect soon. Reconnect to keep transactions flowing.",
  USER_PERMISSION_REVOKED: "Access was revoked at the bank. Reconnect to restore it.",
  NETWORK_ERROR: "Plaid could not be reached. Cosimo will retry on the next sync.",
};

export function connectionMessage(c: ConnRow): string | null {
  if (c.status === "active" && !c.errorCode) return null;
  if (c.status === "disconnected") return "Disconnected. Transactions already imported are kept.";
  if (c.errorCode && STATUS_HELP[c.errorCode]) return STATUS_HELP[c.errorCode]!;
  if (c.status === "needs_reauth") return "The bank needs you to reconnect.";
  return c.errorCode ? `Sync failed (${c.errorCode}). Cosimo will retry.` : null;
}

// ----------------------------------------------------------------------------- status view

export type LastSyncStatus = "never" | "in_progress" | "success" | "error";
export type ConnectionHealth = "healthy" | "needs_reauth" | "error" | "disconnected";

export interface SyncStatusView {
  /** When the last sync finished, whether it worked or not. */
  last_synced_at: string | null;
  /** When the last sync that worked finished. */
  last_successful_sync_at: string | null;
  last_sync_status: LastSyncStatus | null;
  /** `<Plaid error code>: <message>`; null when the connection has no error. */
  last_sync_error: string | null;
  /** Counts from the last successful sync. */
  last_sync_added: number | null;
  last_sync_modified: number | null;
  last_sync_removed: number | null;
  connection_status: ConnectionHealth | null;
  /** Plaid reported accounts at this bank login that aren't in Cosimo yet. */
  new_accounts_available: boolean | null;
}

const HEALTH: Record<ConnRow["status"], ConnectionHealth> = {
  active: "healthy",
  needs_reauth: "needs_reauth",
  error: "error",
  disconnected: "disconnected",
};

/** Sync status of a connection; every field is null for an account with no bank feed. */
export function syncStatusView(c: ConnRow | null | undefined): SyncStatusView {
  if (!c)
    return {
      last_synced_at: null,
      last_successful_sync_at: null,
      last_sync_status: null,
      last_sync_error: null,
      last_sync_added: null,
      last_sync_modified: null,
      last_sync_removed: null,
      connection_status: null,
      new_accounts_available: null,
    };
  // Rows from before attempts were recorded have only the last success.
  const attempt = c.lastSyncAttemptAt ?? c.lastSyncedAt;
  const success = c.lastSyncedAt;
  // A successful sync writes the same time to both columns, so a newer attempt means it failed.
  const status: LastSyncStatus = isSyncing(c.id)
    ? "in_progress"
    : !attempt
      ? "never"
      : !success || attempt > success
        ? "error"
        : "success";
  return {
    last_synced_at: attempt,
    last_successful_sync_at: success,
    last_sync_status: status,
    last_sync_error: c.errorCode ? `${c.errorCode}: ${c.errorMessage ?? connectionMessage(c)}` : null,
    last_sync_added: c.lastSyncAdded,
    last_sync_modified: c.lastSyncModified,
    last_sync_removed: c.lastSyncRemoved,
    connection_status: HEALTH[c.status],
    new_accounts_available: c.newAccountsAvailable,
  };
}
