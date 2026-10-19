import { api } from "../../api/endpoints";
import { messageFor } from "../../api/errors";
import type { NodeSummaryDto } from "../../api/generated/NodeSummaryDto";
import { useGraph } from "../../graph/store";
import { newBatchId } from "../../lib/batchId";
import { toast } from "../../shell/Toasts";
import { offerUndo, SYNC_MAX } from "./expansion";

/**
 * Makes `targets` centers with neighbour limit `k` as one undoable step (spec §3): shallow-syncs only the
 * targets that are neither synced nor syncing (never their neighbours) under a new batch, which Undo cancels.
 * A snapshot asks to go live first and runs again once it is. Resolves false when nothing was expanded
 * (a sync request failed, toasted; or the snapshot question is pending), true after the expansion.
 */
export async function expandSelf(targets: NodeSummaryDto[], k: number): Promise<boolean> {
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
