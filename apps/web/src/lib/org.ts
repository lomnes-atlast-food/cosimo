import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { api, unwrap } from "../api/client";
import { useSession } from "./session";

export function useOrgId(): string {
  const p = useParams({ strict: false }) as { orgId?: string };
  return p.orgId ?? "";
}

export function useOrg() {
  const orgId = useOrgId();
  return useQuery({
    queryKey: ["org", orgId],
    queryFn: () => unwrap(api.GET("/api/v1/orgs/{orgId}", { params: { path: { orgId } } })),
    enabled: Boolean(orgId),
  });
}

export function useRole() {
  const orgId = useOrgId();
  const { data } = useSession();
  const role = data?.orgs.find((o) => o.id === orgId)?.role ?? "viewer";
  return {
    role,
    canWrite: role === "owner" || role === "bookkeeper",
    isOwner: role === "owner",
  };
}
