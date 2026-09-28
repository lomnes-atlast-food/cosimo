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

interface NamedOrg {
  name: string;
  is_sample: boolean;
}

/** Sort by name, case-insensitively, without mutating the input. */
function byName<T extends NamedOrg>(orgs: T[]): T[] {
  return [...orgs].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/**
 * Split and sort orgs for the switcher: real orgs first, then sample orgs, each by name
 * case-insensitively. The server's own order isn't relied on.
 */
export function groupOrgs<T extends NamedOrg>(orgs: T[]): { real: T[]; sample: T[] } {
  return {
    real: byName(orgs.filter((o) => !o.is_sample)),
    sample: byName(orgs.filter((o) => o.is_sample)),
  };
}
