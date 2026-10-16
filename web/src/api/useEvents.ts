import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useGraph } from "../graph/store";
import { graphQueryKey } from "../graph/useGraphData";
import { useJobProgress, useQuota, useSseState } from "../shell/statusStore";
import { toast } from "../shell/Toasts";
import { api } from "./endpoints";
import type { Event } from "./generated/Event";
import type { GraphResponseDto } from "./generated/GraphResponseDto";
import { qk } from "./queryClient";
import { subscribeEvents } from "./sse";

/** Bursts of data/meta events are merged into one invalidation per window. */
const COALESCE_MS = 500;

/** Collects addresses and flushes them once, `COALESCE_MS` after the first one of a window arrived. */
function coalescer(flush: (addrs: Set<string>) => void) {
  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    add(addrs: Iterable<string>) {
      for (const a of addrs) pending.add(a.toLowerCase());
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        const batch = pending;
        pending = new Set();
        flush(batch);
      }, COALESCE_MS);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/** True when the address is a center or a node of the current graph. */
function onCanvas(qc: QueryClient, addr: string): boolean {
  const s = useGraph.getState();
  if (s.centers.includes(addr)) return true;
  const data = qc.getQueryData<GraphResponseDto>(graphQueryKey(s));
  return !!data?.nodes.some((n) => n.address.toLowerCase() === addr);
}

const TRANSFER_ADDR_FIELDS = ["address", "from", "to"];

/** Whether a `qk.transfers(params)` key concerns one of `addrs`. */
function transfersTouch(params: unknown, addrs: Set<string>): boolean {
  if (!params || typeof params !== "object") return false;
  const p = params as Record<string, unknown>;
  return TRANSFER_ADDR_FIELDS.some((k) => {
    const v = p[k];
    return typeof v === "string" && addrs.has(v.toLowerCase());
  });
}

/** Subscribes to the backend event stream for the app's lifetime; call once at the top of App. */
export function useEvents(): void {
  const qc = useQueryClient();

  useEffect(() => {
    const invalidateAddresses = (addrs: Set<string>) => {
      for (const a of addrs) void qc.invalidateQueries({ queryKey: qk.address(a) });
    };
    const dataChanged = coalescer((addrs) => {
      void qc.invalidateQueries({ queryKey: ["graph"] });
      invalidateAddresses(addrs);
      void qc.invalidateQueries({
        predicate: (q) => q.queryKey[0] === "transfers" && transfersTouch(q.queryKey[1], addrs),
      });
    });
    const metaChanged = coalescer((addrs) => {
      void qc.invalidateQueries({ queryKey: ["graph"] });
      invalidateAddresses(addrs);
    });

    const onEvent = (e: Event) => {
      switch (e.type) {
        case "AddressDataChanged": {
          const a = e.address.toLowerCase();
          if (onCanvas(qc, a)) dataChanged.add([a]);
          break;
        }
        case "NamesResolved":
          metaChanged.add(e.items.map((i) => i.address));
          break;
        case "MetaUpdated":
          metaChanged.add(e.addresses);
          break;
        case "TxReady":
          void qc.invalidateQueries({ queryKey: qk.tx(e.hash.toLowerCase()) });
          break;
        case "JobProgress":
          useJobProgress.getState().upsert(e);
          if (e.status === "failed" && e.kind === "fetch_tx") {
            toast(`交易抓取失败：${e.error ?? "未知原因"}`, "error");
          }
          break;
        case "QuotaStatus":
          useQuota.getState().setQuota({ used: e.used, limit: e.limit, paused: e.paused, reset_at: e.reset_at });
          break;
        case "Lagged":
          void qc.invalidateQueries();
          break;
      }
    };

    let alive = true;
    api
      .status()
      .then((s) => {
        if (!alive) return;
        const q = useQuota.getState();
        q.setQuota({ used: s.quota_used, limit: s.quota_limit, paused: s.paused, reset_at: s.reset_at });
        q.setDegraded(s.degraded);
      })
      .catch(() => {
        // Status is best-effort; QuotaStatus events and the SSE banner cover the live state.
      });

    const unsubscribe = subscribeEvents(onEvent, (s) => useSseState.getState().set(s));
    return () => {
      alive = false;
      unsubscribe();
      dataChanged.cancel();
      metaChanged.cancel();
    };
  }, [qc]);
}
