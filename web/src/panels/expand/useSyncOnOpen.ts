import { useEffect, useRef, useState } from "react";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import type { NodeSummaryDto } from "../../api/generated/NodeSummaryDto";
import { ACTIVE_JOB_STATUSES, useJobProgress } from "../../shell/statusStore";
import { toast } from "../../shell/Toasts";

/** How often the active jobs list is checked while the sync runs (fallback for a dropped event stream). */
const JOBS_POLL_MS = 5000;

/**
 * Shallow-syncs `node` once, on open, when it is neither synced nor syncing (no batch: a dialog's sync is
 * not undoable). Returns whether a sync is under way: from the request until its jobs end (or the node was
 * already syncing). `onJobDone` runs whenever one of the started jobs ends, so the caller can refetch
 * without waiting for the coalesced AddressDataChanged event.
 */
export function useSyncOnOpen(node: NodeSummaryDto, onJobDone: () => void, enabled = true): boolean {
  const start = enabled && !node.synced && !node.syncing;
  // Ids of the sync jobs started on open that have not finished.
  const [pendingJobs, setPendingJobs] = useState<number[]>([]);
  // True while the sync request itself is in flight (the note shows at once).
  const [requesting, setRequesting] = useState(start);
  const seenJobs = useRef(new Set<number>());
  const onDone = useRef(onJobDone);
  onDone.current = onJobDone;

  useEffect(() => {
    if (!start) return;
    api
      .sync({ addresses: [node.address.toLowerCase()], depth: "shallow" })
      .then((r) => setPendingJobs(r.jobs ?? []))
      .catch((err: unknown) => toast(messageFor(err), "error"))
      .finally(() => setRequesting(false));
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A job is done when its progress is terminal, or when it vanished after having been seen (the status
  // refresh drops finished jobs).
  useEffect(() => {
    if (pendingJobs.length === 0) return;
    const check = () => {
      const byId = useJobProgress.getState().byId;
      const left = pendingJobs.filter((id) => {
        const e = byId[id];
        if (e) {
          seenJobs.current.add(id);
          return ACTIVE_JOB_STATUSES.has(e.status);
        }
        return !seenJobs.current.has(id);
      });
      if (left.length < pendingJobs.length) {
        setPendingJobs(left);
        onDone.current();
      }
    };
    check();
    const unsubscribe = useJobProgress.subscribe(check);
    // Fallback when a terminal event never arrives (dropped stream): ids absent from the active list are done.
    let live = true;
    const timer = setInterval(() => {
      api
        .jobs()
        .then((active) => {
          if (!live) return;
          const ids = new Set(active.map((j) => j.id));
          const left = pendingJobs.filter((id) => ids.has(id));
          if (left.length === pendingJobs.length) return;
          setPendingJobs(left);
          onDone.current();
        })
        .catch(() => {});
    }, JOBS_POLL_MS);
    return () => {
      live = false;
      unsubscribe();
      clearInterval(timer);
    };
  }, [pendingJobs]);

  return requesting || pendingJobs.length > 0 || (enabled && node.syncing);
}
