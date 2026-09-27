/** The admin update check (issue #12): a nav dot plus the Updates card on the admin page. */
import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "../api/client";
import type { components } from "../api/schema";
import { useSession } from "./session";

export type UpdateStatus = components["schemas"]["UpdateStatus"];

/**
 * Fetched only for instance admins. The server caches its own answer for 12h (1h on error), so an
 * hour of client-side staleness costs nothing extra.
 */
export function useUpdateStatus() {
  const { data } = useSession();
  return useQuery({
    queryKey: ["admin-update"],
    queryFn: () => unwrap(api.GET("/api/v1/admin/update")),
    enabled: Boolean(data?.user?.is_instance_admin),
    staleTime: 3_600_000,
  });
}
