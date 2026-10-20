import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";

const lc = (a: string) => a.toLowerCase();

/** Merges dry-run results of center chunks (nodes deduped by lowercase address, edges concatenated, omitted merged). */
export function mergeResults(parts: GraphResponseDto[]): GraphResponseDto {
  const nodes = new Map<string, NodeSummaryDto>();
  const out: GraphResponseDto = { nodes: [], edges: [], omitted: {}, coverage: {} };
  for (const p of parts) {
    for (const n of p.nodes) if (!nodes.has(lc(n.address))) nodes.set(lc(n.address), n);
    out.edges.push(...p.edges);
    for (const [a, n] of Object.entries(p.omitted)) out.omitted[a] = (out.omitted[a] ?? 0) + n;
    Object.assign(out.coverage, p.coverage);
  }
  out.nodes = [...nodes.values()];
  return out;
}
