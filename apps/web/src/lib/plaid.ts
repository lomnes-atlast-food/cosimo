import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "../api/client";
import type { components } from "../api/schema";

export type Connection = components["schemas"]["BankConnection"];
export type SyncSummary = NonNullable<components["schemas"]["SyncSummary"]>;

/** Account metadata Plaid Link hands back on success. */
export interface LinkAccount {
  id: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
}

interface LinkHandler {
  open(): void;
  exit(opts?: { force?: boolean }): void;
  destroy(): void;
}

declare global {
  interface Window {
    Plaid?: {
      create(opts: {
        token: string;
        receivedRedirectUri?: string;
        onSuccess: (publicToken: string, metadata: { accounts: LinkAccount[] }) => void;
        onExit: (err: { error_message?: string; display_message?: string } | null) => void;
      }): LinkHandler;
    };
  }
}

const SCRIPT = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
let loading: Promise<void> | null = null;

/** Plaid requires Link to be loaded from its CDN (allowed by the server's CSP). */
export function loadPlaidLink(): Promise<void> {
  if (window.Plaid) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new Error("Could not load Plaid Link. Check your connection and try again."));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** Saved across the OAuth redirect some banks require (session only, never the public token). */
export interface PendingLink {
  orgId: string;
  token: string;
  connectionId: string | null;
}
const PENDING_KEY = "cosimo.plaid.link";

export function savePendingLink(p: PendingLink) {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(p));
  } catch {
    // private mode: OAuth banks will need a retry
  }
}

export function takePendingLink(): PendingLink | null {
  try {
    const v = sessionStorage.getItem(PENDING_KEY);
    return v ? (JSON.parse(v) as PendingLink) : null;
  } catch {
    return null;
  }
}

export function clearPendingLink() {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // ignore
  }
}

/**
 * Open Plaid Link and resolve with the public token and accounts, or null if the user closed it.
 */
export async function openLink(
  token: string,
  receivedRedirectUri?: string,
): Promise<{ publicToken: string; accounts: LinkAccount[] } | null> {
  await loadPlaidLink();
  return new Promise((resolve, reject) => {
    const handler = window.Plaid!.create({
      token,
      receivedRedirectUri,
      onSuccess: (publicToken, metadata) => {
        handler.destroy();
        resolve({ publicToken, accounts: metadata.accounts ?? [] });
      },
      onExit: (err) => {
        handler.destroy();
        if (err)
          reject(new Error(err.display_message || err.error_message || "Plaid Link closed with an error."));
        else resolve(null);
      },
    });
    handler.open();
  });
}

export function usePlaidStatus(orgId: string) {
  return useQuery({
    queryKey: ["plaid", orgId],
    queryFn: () => unwrap(api.GET("/api/v1/orgs/{orgId}/plaid", { params: { path: { orgId } } })),
    enabled: Boolean(orgId),
  });
}

export function useConnections(orgId: string) {
  return useQuery({
    queryKey: ["bank-connections", orgId],
    queryFn: () =>
      unwrap(api.GET("/api/v1/orgs/{orgId}/bank-connections", { params: { path: { orgId } } })).then(
        (r) => r.data,
      ),
    enabled: Boolean(orgId),
  });
}

export function syncText(s: SyncSummary) {
  const parts = [`${s.added} new`];
  if (s.modified) parts.push(`${s.modified} updated`);
  if (s.removed) parts.push(`${s.removed} removed`);
  if (s.rules_applied) parts.push(`${s.rules_applied} matched a rule`);
  return parts.join(", ");
}
