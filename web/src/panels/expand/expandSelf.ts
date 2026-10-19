import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import type { NodeSummaryDto } from "../../api/generated/NodeSummaryDto";
import { MAX_CENTERS, useGraph } from "../../graph/store";
import { t } from "../../i18n";
import { newBatchId } from "../../lib/batchId";
import { toast } from "../../shell/Toasts";
import { offerUndo, SYNC_MAX } from "./expansion";

/** How many centers there are once `targets` are centers too (targets already among `centers` count once). */
export function centersAfter(centers: readonly string[], targets: readonly NodeSummaryDto[]): number {
  return new Set([...centers, ...targets.map((n) => n.address)].map((a) => a.toLowerCase())).size;
}

/**
 * Makes `targets` centers with neighbour limit `k` as one undoable step (spec §3): shallow-syncs only the
 * targets that are neither synced nor syncing (never their neighbours) under a new batch, which Undo cancels.
 * `targets` should be the current result's summaries: their sync flags decide what is synced.
 * A snapshot asks to go live first and runs again once it is. Resolves false when nothing was expanded
 * (more than MAX_CENTERS centers after it, which the graph request rejects; a sync request failed; both toasted;
 * or the snapshot question is pending), true after the expansion.
 */
export async function expandSelf(targets: NodeSummaryDto[], k: number): Promise<boolean> {
  const count = centersAfter(useGraph.getState().centers, targets);
  if (count > MAX_CENTERS) {
    // The dialog blocks this already; nothing is synced for an expansion the graph could not show.
    toast(t("expandSelf.tooManyCenters", { max: MAX_CENTERS, count }), "error");
    return false;
  }
  if (useGraph.getState().frozen) {
    useGraph.getState().guardLive(() => void expandSelf(targets, k));
    return false;
  }
  const batch = newBatchId();
  const addresses = [...new Set(targets.map((t) => t.address.toLowerCase()))];
  const toSync = [...new Set(targets.filter((t) => t.synced === false && !t.syncing).map((t) => t.address.toLowerCase()))];
  const chunks: string[][] = [];
  for (let i = 0; i < toSync.length; i += SYNC_MAX) chunks.push(toSync.slice(i, i + SYNC_MAX));
  const results = await Promise.allSettled(chunks.map((c) => api.sync({ addresses: c, batch, depth: "shallow" })));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) {
    // Every request has settled, so all jobs the others started belong to the batch: release them.
    api.cancelBatch(batch).catch(() => {});
    toast(messageFor(failed.reason), "error");
    return false;
  }
  useGraph.getState().expand(addresses, batch, k);
  offerUndo(addresses.length);
  return true;
}
