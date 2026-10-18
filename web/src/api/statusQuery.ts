import { useQuota } from "../shell/statusStore";
import { api } from "./endpoints";
import type { StatusDto } from "./generated/StatusDto";
import { qk } from "./queryClient";

/** The one place that maps /api/status onto the quota/degraded stores. */
export function applyStatus(s: StatusDto): void {
  const q = useQuota.getState();
  q.setQuota({ used: s.quota_used, limit: s.quota_limit, paused: s.paused, server_paused: s.server_paused, reset_at: s.reset_at });
  q.setDegraded(s.degraded);
}

/** Shared by useEvents (fetchQuery) and StatusBar (useQuery); stores are written at fetch time, not on read. */
export const statusQuery = {
  queryKey: qk.status(),
  queryFn: async (): Promise<StatusDto> => {
    const s = await api.status();
    applyStatus(s);
    return s;
  },
  staleTime: 0,
};
