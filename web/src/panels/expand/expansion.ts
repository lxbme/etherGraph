import type { GraphResponseDto } from "../../api/generated/GraphResponseDto";
import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import { queryClient } from "../../api/queryClient";
import { setHistoryEffectHandler, type ExpandEffect } from "../../graph/historyEffects";
import { useGraph } from "../../graph/store";
import { t } from "../../i18n";
import { newBatchId } from "../../lib/batchId";
import { dismissToast, toast } from "../../shell/Toasts";

/** Most addresses one POST /api/sync accepts. */
export const SYNC_MAX = 50;

/** Addresses of `addrs` that no cached graph shows as synced (and not currently syncing). */
function unsynced(addrs: string[]): string[] {
  const done = new Set<string>();
  for (const [, data] of queryClient.getQueriesData<GraphResponseDto>({ queryKey: ["graph"] })) {
    for (const n of data?.nodes ?? []) if (n.synced && !n.syncing) done.add(n.address.toLowerCase());
  }
  return addrs.filter((a) => !done.has(a.toLowerCase()));
}

function onUndo(e: ExpandEffect): void {
  // The canvas is not rolled back on failure: only the background work could not be stopped.
  api.cancelBatch(e.batch).catch((err) => toast(messageFor(err), "error"));
}

function onRedo(e: ExpandEffect): ExpandEffect {
  const addresses = unsynced(e.addresses);
  if (addresses.length === 0) return e;
  const batch = newBatchId();
  const chunks: string[][] = [];
  for (let i = 0; i < addresses.length; i += SYNC_MAX) chunks.push(addresses.slice(i, i + SYNC_MAX));
  for (const c of chunks) {
    api.sync({ addresses: c, batch, depth: "shallow" }).catch((err) => toast(messageFor(err), "error"));
  }
  toast(t("expand.redo", { count: addresses.length }), "info");
  return { kind: "expand", batch, addresses: e.addresses };
}

/** Wires expansion history steps to the backend (undo cancels the batch, redo re-syncs under a new one). Idempotent. */
export function registerExpansionEffects(): void {
  setHistoryEffectHandler({ onUndo, onRedo });
}

/**
 * Shows the expansion as one undoable step: "Expanded N · Undo" with no timer, until another history step
 * replaces it or the user closes it.
 */
export function offerUndo(count: number): void {
  const past = useGraph.getState()._past;
  const entry = past[past.length - 1];
  if (!entry) return;
  const isTop = (p: typeof past) => p[p.length - 1] === entry;
  let id = 0;
  const unsubscribe = useGraph.subscribe((s) => {
    if (!isTop(s._past)) dismissToast(id);
  });
  id = toast(t("expand.done", { count }), "info", {
    ttlMs: null,
    onDismiss: unsubscribe,
    action: {
      label: t("common.undo"),
      onClick: () => {
        if (isTop(useGraph.getState()._past)) useGraph.getState().undo();
      },
    },
  });
}
