import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useGraph } from "../graph/store";
import { t } from "../i18n";
import { ACTIVE_JOB_STATUSES, useJobProgress, useQuota, useSseState } from "../shell/statusStore";
import { toast } from "../shell/Toasts";
import { api } from "./endpoints";
import type { Event } from "./generated/Event";
import type { JobDto } from "./generated/JobDto";
import type { GraphResponseDto } from "./generated/GraphResponseDto";
import { qk } from "./queryClient";
import { statusQuery } from "./statusQuery";
import { subscribeEvents } from "./sse";

/** Bursts of data/meta events are merged into one invalidation per window. */
const COALESCE_MS = 500;

/** Retry delays for the initial status load; the last one repeats. */
const STATUS_RETRY_MS = [2000, 5000, 10000, 30000];

/**
 * Collects addresses and flushes them once, `COALESCE_MS` after the first one of a window arrived.
 * While `busy()` holds, the flush is postponed by another window (pending addresses are kept), so
 * an invalidation never cancels a fetch that is still running.
 */
function coalescer(flush: (addrs: Set<string>) => void, busy: () => boolean) {
  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    if (busy()) {
      timer = setTimeout(fire, COALESCE_MS);
      return;
    }
    timer = null;
    const batch = pending;
    pending = new Set();
    flush(batch);
  };
  return {
    add(addrs: Iterable<string>) {
      for (const a of addrs) pending.add(a.toLowerCase());
      if (timer === null) timer = setTimeout(fire, COALESCE_MS);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * True when the address is a center or a node of any cached graph result (the current key may
 * still be loading while the previous result is shown as placeholder).
 */
function onCanvas(qc: QueryClient, addr: string): boolean {
  if (useGraph.getState().centers.includes(addr)) return true;
  return qc
    .getQueriesData<GraphResponseDto>({ queryKey: ["graph"] })
    .some(([, data]) => !!data?.nodes.some((n) => n.address.toLowerCase() === addr));
}

/** Whether an interactions list of `addr` is cached (it may be open for a node that is off the canvas). */
function hasCounterparties(qc: QueryClient, addr: string): boolean {
  return qc.getQueryCache().findAll({ queryKey: ["counterparties", addr] }).length > 0;
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
    let alive = true;
    const graphBusy = () => qc.isFetching({ queryKey: ["graph"] }) > 0;
    const invalidateAddresses = (addrs: Set<string>) => {
      for (const a of addrs) void qc.invalidateQueries({ queryKey: qk.address(a) });
    };
    const dataChanged = coalescer((addrs) => {
      void qc.invalidateQueries({ queryKey: ["graph"] });
      invalidateAddresses(addrs);
      void qc.invalidateQueries({
        predicate: (q) => q.queryKey[0] === "transfers" && transfersTouch(q.queryKey[1], addrs),
      });
      // A contract's interactions list refetches once its sync lands.
      void qc.invalidateQueries({
        predicate: (q) => q.queryKey[0] === "counterparties" && addrs.has(String(q.queryKey[1])),
      });
    }, graphBusy);
    const metaChanged = coalescer((addrs) => {
      void qc.invalidateQueries({ queryKey: ["graph"] });
      invalidateAddresses(addrs);
    }, graphBusy);

    /** Quota/degraded from /api/status; drops progress of tracked jobs that are no longer active. */
    const refreshStatus = async (): Promise<boolean> => {
      const tracked = Object.keys(useJobProgress.getState().byId).map(Number);
      const [status, jobs] = await Promise.allSettled([qc.fetchQuery(statusQuery), api.jobs()]);
      if (!alive) return false;
      if (jobs.status === "fulfilled") {
        const active = new Set(jobs.value.map((j) => j.id));
        useJobProgress.getState().remove(tracked.filter((id) => !active.has(id)));
      }
      return status.status === "fulfilled";
    };
    // Until the status has loaded once, failures are retried with backoff.
    let statusLoaded = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    const loadStatus = () => {
      void refreshStatus().then((ok) => {
        if (ok) {
          statusLoaded = true;
          if (retryTimer !== null) clearTimeout(retryTimer);
          retryTimer = null;
          return;
        }
        if (!alive || statusLoaded || retryTimer !== null) return;
        const delay = STATUS_RETRY_MS[Math.min(attempt++, STATUS_RETRY_MS.length - 1)];
        retryTimer = setTimeout(() => {
          retryTimer = null;
          loadStatus();
        }, delay);
      });
    };

    const onEvent = (e: Event) => {
      switch (e.type) {
        case "AddressDataChanged": {
          const a = e.address.toLowerCase();
          if (onCanvas(qc, a)) dataChanged.add([a]);
          // Off the canvas but browsed: only its interactions list is stale.
          else if (hasCounterparties(qc, a)) void qc.invalidateQueries({ queryKey: ["counterparties", a] });
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
          // A job we have not listed yet: refresh the list so its target can be shown.
          if (ACTIVE_JOB_STATUSES.has(e.status) && !qc.getQueryData<JobDto[]>(qk.jobs())?.some((j) => j.id === e.job_id)) {
            void qc.invalidateQueries({ queryKey: qk.jobs() });
          } else if (!ACTIVE_JOB_STATUSES.has(e.status)) {
            // A finished job leaves the active list now, not at the next poll,
            // so its cancel button cannot target a job that is already done.
            qc.setQueryData<JobDto[]>(qk.jobs(), (jobs) => jobs?.filter((j) => j.id !== e.job_id));
          }
          if (e.status === "failed" && e.kind === "fetch_tx") {
            toast(t("events.txFetchFailed", { reason: e.error ?? t("events.unknownReason") }), "error");
          }
          break;
        case "QuotaStatus":
          useQuota.getState().setQuota({ used: e.used, limit: e.limit, paused: e.paused, reset_at: e.reset_at });
          break;
        case "Lagged":
          // Events were missed: refetch everything and resync the status stores.
          void qc.invalidateQueries();
          loadStatus();
          break;
      }
    };

    loadStatus();
    const unsubscribe = subscribeEvents(onEvent, (s) => useSseState.getState().set(s));
    return () => {
      alive = false;
      if (retryTimer !== null) clearTimeout(retryTimer);
      unsubscribe();
      dataChanged.cancel();
      metaChanged.cancel();
    };
  }, [qc]);
}
