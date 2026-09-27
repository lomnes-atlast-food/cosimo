import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "../api/client";
import type { components } from "../api/schema";

export type BankAccount = components["schemas"]["BankAccount"];
export type BankTxn = components["schemas"]["BankTransaction"];
export type Rule = components["schemas"]["Rule"];
export type ReviewItem = components["schemas"]["ReviewItem"];
export type Recon = components["schemas"]["Reconciliation"];
export type CsvProfile = NonNullable<components["schemas"]["CsvProfile"]>;
export type ImportPreview = components["schemas"]["ImportPreview"];

export const KIND_LABEL: Record<BankAccount["kind"], string> = {
  checking: "Checking",
  savings: "Savings",
  credit_card: "Credit card",
  other: "Other",
};

export function useBankAccounts(orgId: string) {
  return useQuery({
    queryKey: ["bank-accounts", orgId],
    queryFn: () =>
      unwrap(api.GET("/api/v1/orgs/{orgId}/bank-accounts", { params: { path: { orgId } } })).then(
        (r) => r.data,
      ),
    enabled: Boolean(orgId),
  });
}

export function usePendingReviewCount(orgId: string) {
  return useQuery({
    queryKey: ["review", orgId, "count"],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/review", {
          params: { path: { orgId }, query: { status: "pending", limit: 1 } },
        }),
      ).then((r) => r.pending_count),
    enabled: Boolean(orgId),
  });
}

export function readFileText(f: File): Promise<string> {
  return f.text();
}
