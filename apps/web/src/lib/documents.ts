import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "../api/client";
import type { components } from "../api/schema";

export type Contact = components["schemas"]["Contact"];
export type Invoice = components["schemas"]["Invoice"];
export type Bill = components["schemas"]["Bill"];
export type Payment = components["schemas"]["Payment"];
export type Recurring = components["schemas"]["RecurringTemplate"];
export type Attachment = components["schemas"]["Attachment"];

export function useContacts(orgId: string, kind?: "customer" | "vendor") {
  return useQuery({
    queryKey: ["contacts", orgId, kind ?? "all"],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/orgs/{orgId}/contacts", {
          params: { path: { orgId }, query: kind ? { kind } : {} },
        }),
      ).then((r) => r.data),
    enabled: Boolean(orgId),
  });
}

export const INVOICE_STATUS: Record<
  Invoice["status"],
  { label: string; tone: "zinc" | "blue" | "amber" | "green" | "red" }
> = {
  draft: { label: "Draft", tone: "zinc" },
  sent: { label: "Open", tone: "blue" },
  partial: { label: "Partly paid", tone: "amber" },
  paid: { label: "Paid", tone: "green" },
  void: { label: "Void", tone: "red" },
};

export const BILL_STATUS: Record<
  Bill["status"],
  { label: string; tone: "zinc" | "blue" | "amber" | "green" | "red" }
> = {
  draft: { label: "Draft", tone: "zinc" },
  open: { label: "Open", tone: "blue" },
  partial: { label: "Partly paid", tone: "amber" },
  paid: { label: "Paid", tone: "green" },
  void: { label: "Void", tone: "red" },
};

/** "1", "2.5" from thousandths; and back. */
export function qtyText(milli: number) {
  const s = (milli / 1000).toFixed(3).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}
export function parseQty(s: string): number | null {
  const t = s.trim();
  if (!/^\d*(\.\d*)?$/.test(t) || !/\d/.test(t)) return null;
  let [w = "", f = ""] = t.split(".");
  if (f.length > 3) {
    if (/[1-9]/.test(f.slice(3))) return null; // extra non-zero digits past 3 decimals
    f = f.slice(0, 3);
  }
  const v = Number(w || 0) * 1000 + Number(f.padEnd(3, "0"));
  return v > 0 ? v : null;
}
