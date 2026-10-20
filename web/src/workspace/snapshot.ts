import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/endpoints";
import type { CallFrameDto } from "../api/generated/CallFrameDto";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import type { LabelDto } from "../api/generated/LabelDto";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import type { TxFlowDto } from "../api/generated/TxFlowDto";
import type { TxRawDto } from "../api/generated/TxRawDto";
import { messageFor } from "../api/errors";
import { qk } from "../api/queryClient";
import { setUnfreezeHandler, useGraph } from "../graph/store";
import { t } from "../i18n";
import { newBatchId } from "../lib/batchId";
import { SYNC_MAX } from "../panels/expand/expansion";
import { toast } from "../shell/Toasts";

/**
 * Frozen view data from a file: shown read-only (never written to the chain tables, never mixed into live
 * results) until the view is refreshed from the chain.
 */
export interface SnapshotMeta {
  exported_at: string;
  includes: { labels: boolean; notes: boolean };
}
export interface GraphSnapshot extends SnapshotMeta {
  data: GraphResponseDto;
}
export interface TxSnapshot extends SnapshotMeta {
  flow: TxFlowDto;
  raw: TxRawDto | null;
  /** The decoded call trace, when it had been fetched before the export (older files have none). */
  trace?: CallFrameDto[];
}

/** `LabelDto.source` of a label that arrived in a file: shown in its snapshot only, never sent to the label API. */
export const FILE_SOURCE = "file";

const lc = (s: string) => s.toLowerCase();
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNodeList = (v: unknown) =>
  Array.isArray(v) && v.every((n) => isObj(n) && typeof n.address === "string" && Array.isArray(n.labels));

function isMeta(v: unknown): v is SnapshotMeta & Record<string, unknown> {
  return (
    isObj(v) &&
    typeof v.exported_at === "string" &&
    isObj(v.includes) &&
    typeof v.includes.labels === "boolean" &&
    typeof v.includes.notes === "boolean"
  );
}

/** Structural check of a saved graph snapshot (enough for the views to render it). */
export function isGraphSnapshot(v: unknown): v is GraphSnapshot {
  if (!isMeta(v) || !isObj(v.data)) return false;
  const d = v.data;
  return isNodeList(d.nodes) && Array.isArray(d.edges) && isObj(d.omitted) && isObj(d.coverage);
}

/** Structural check of a saved tx snapshot (`raw` is null or both JSON parts; `trace`, when there, a list). */
export function isTxSnapshot(v: unknown): v is TxSnapshot {
  if (!isMeta(v) || !isObj(v.flow)) return false;
  const f = v.flow;
  if (!isObj(f.tx) || typeof f.tx.hash !== "string" || !isNodeList(f.nodes) || !Array.isArray(f.flows) || !Array.isArray(f.events)) {
    return false;
  }
  if (v.trace !== undefined && !Array.isArray(v.trace)) return false;
  return v.raw === null || (isObj(v.raw) && "tx" in v.raw && "receipt" in v.raw);
}

/** Whether the receiver's own data knows who this address is. */
function hasIdentity(n: NodeSummaryDto): boolean {
  return n.kind !== "unknown" || n.labels.length > 0 || n.ens !== null || n.contract_name !== null;
}

/**
 * A snapshot node as shown: the funds stay the file's, the identity is the receiver's own when it has one
 * (then the file's `file` labels follow the live labels); otherwise the file node as it is. `identified` is
 * always the receiver's when it has the node, so Identify stays on offer for nodes only the sender identified.
 */
export function overlayIdentity(file: NodeSummaryDto, live: NodeSummaryDto | undefined): NodeSummaryDto {
  if (!live) return file;
  if (!hasIdentity(live)) return live.identified === file.identified ? file : { ...file, identified: live.identified };
  return {
    ...file,
    identified: live.identified,
    kind: live.kind,
    display_name: live.display_name,
    ens: live.ens,
    contract_name: live.contract_name,
    labels: [...live.labels, ...file.labels.filter((l) => l.source === FILE_SOURCE)],
  };
}

/** The `file` labels a snapshot carries for `address`. */
export function fileLabelsOf(nodes: NodeSummaryDto[] | undefined, address: string): LabelDto[] {
  const a = lc(address);
  return nodes?.find((n) => lc(n.address) === a)?.labels.filter((l) => l.source === FILE_SOURCE) ?? [];
}

/** Most addresses one POST /api/nodes accepts. */
const NODES_MAX = 2000;
const NO_LIVE = new Map<string, NodeSummaryDto>();

/** The receiver's own summaries of `key` (lowercase, deduped), in chunks the server accepts. No upstream call. */
async function fetchNodes(key: string[]): Promise<NodeSummaryDto[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < key.length; i += NODES_MAX) chunks.push(key.slice(i, i + NODES_MAX));
  return (await Promise.all(chunks.map((c) => api.nodes(c)))).flat();
}

const keyOf = (addresses: string[]) => [...new Set(addresses.map(lc))].sort();

/** The receiver's own summaries of `addresses` (lowercase key); no request for an empty list. */
export function useLiveIdentities(addresses: string[]): Map<string, NodeSummaryDto> {
  const key = useMemo(() => keyOf(addresses), [addresses]);
  const q = useQuery({ queryKey: qk.nodes(key), queryFn: () => fetchNodes(key), enabled: key.length > 0 });
  return useMemo(() => (q.data ? new Map(q.data.map((n) => [lc(n.address), n])) : NO_LIVE), [q.data]);
}

/**
 * The centers (lowercase) the receiver has never synced and is not syncing, from its own summaries `live`
 * (an address it does not know counts as never synced): what refreshing a snapshot graph syncs.
 */
export function neverSynced(centers: string[], live: NodeSummaryDto[]): string[] {
  const byAddr = new Map(live.map((n) => [lc(n.address), n]));
  return keyOf(centers).filter((a) => {
    const n = byAddr.get(a);
    return !n || (!n.synced && !n.syncing);
  });
}

/**
 * How many centers refreshing the snapshot graph from the chain will sync (`neverSynced`); null while not known yet
 * (or when the graph is live).
 */
export function useRefreshSyncCount(): number | null {
  const frozen = useGraph((s) => s.frozen !== null);
  const centers = useGraph((s) => s.centers);
  const key = useMemo(() => keyOf(centers), [centers]);
  const q = useQuery({ queryKey: qk.nodes(key), queryFn: () => fetchNodes(key), enabled: frozen && key.length > 0 });
  if (!frozen) return null;
  if (key.length === 0) return 0;
  return q.data ? neverSynced(key, q.data).length : null;
}

/**
 * "Refresh from chain" for the snapshot graph (the banner, the transfers table): goes live at once when that syncs no
 * center; otherwise (or while the count is not known yet) asks first with the refresh confirm, which says how many
 * centers and calls. Never call `unfreeze()` directly from a button: the confirm is the click that pays for the syncs.
 */
export function useRefreshFromChain(): () => void {
  const syncs = useRefreshSyncCount();
  return () => (syncs === 0 ? useGraph.getState().unfreeze() : useGraph.getState().guardLive(() => {}));
}

/**
 * Going live from a snapshot graph (the user confirmed "Refresh from chain"): shallow-syncs, as one batch, the centers
 * the receiver has never synced and is not syncing. Synced centers are not re-synced. Never `sync=auto`.
 */
export async function syncNeverSyncedCenters(centers: string[]): Promise<void> {
  const key = keyOf(centers);
  if (key.length === 0) return;
  try {
    const todo = neverSynced(key, await fetchNodes(key));
    if (todo.length === 0) return;
    const batch = newBatchId();
    for (let i = 0; i < todo.length; i += SYNC_MAX) {
      await api.sync({ addresses: todo.slice(i, i + SYNC_MAX), depth: "shallow", batch });
    }
    toast(t("snapshot.syncStarted", { count: todo.length }));
  } catch (e) {
    toast(messageFor(e), "error");
  }
}

/** Wires a graph refresh to the backend: the never-synced centers are synced (`syncNeverSyncedCenters`). Idempotent. */
export function registerSnapshotEffects(): void {
  setUnfreezeHandler((centers) => void syncNeverSyncedCenters(centers));
}

/** `nodes` with live identities laid over them. */
export function overlayNodes(nodes: NodeSummaryDto[], live: Map<string, NodeSummaryDto>): NodeSummaryDto[] {
  return live.size === 0 ? nodes : nodes.map((n) => overlayIdentity(n, live.get(lc(n.address))));
}
