import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/endpoints";
import type { CallFrameDto } from "../api/generated/CallFrameDto";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import type { LabelDto } from "../api/generated/LabelDto";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import type { TxFlowDto } from "../api/generated/TxFlowDto";
import type { TxRawDto } from "../api/generated/TxRawDto";
import { qk } from "../api/queryClient";
import { syncCenter } from "../graph/nodeActions";
import { setUnfreezeHandler } from "../graph/store";

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

/** The receiver's own summaries of `addresses` (lowercase key); no request for an empty list. */
export function useLiveIdentities(addresses: string[]): Map<string, NodeSummaryDto> {
  const key = useMemo(() => [...new Set(addresses.map(lc))].sort(), [addresses]);
  const q = useQuery({
    queryKey: qk.nodes(key),
    queryFn: async () => {
      const chunks: string[][] = [];
      for (let i = 0; i < key.length; i += NODES_MAX) chunks.push(key.slice(i, i + NODES_MAX));
      return (await Promise.all(chunks.map((c) => api.nodes(c)))).flat();
    },
    enabled: key.length > 0,
  });
  return useMemo(() => (q.data ? new Map(q.data.map((n) => [lc(n.address), n])) : NO_LIVE), [q.data]);
}

/** `nodes` with live identities laid over them. */
export function overlayNodes(nodes: NodeSummaryDto[], live: Map<string, NodeSummaryDto>): NodeSummaryDto[] {
  return live.size === 0 ? nodes : nodes.map((n) => overlayIdentity(n, live.get(lc(n.address))));
}

/** Wires a graph refresh to the backend: each center gets the request the app sends when a center is added. Idempotent. */
export function registerSnapshotEffects(): void {
  setUnfreezeHandler((centers) => centers.forEach(syncCenter));
}
