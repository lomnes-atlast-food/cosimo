import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "../api/client";
import type { components } from "../api/schema";

export type Session = components["schemas"]["Session"];

export function useSession() {
  return useQuery({
    queryKey: ["session"],
    queryFn: () => unwrap(api.GET("/api/v1/auth/session")),
    staleTime: 60_000,
  });
}

export function useRefreshSession() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["session"] });
}
