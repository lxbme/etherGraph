import type cytoscape from "cytoscape";
import { isMoreId, MORE_PREFIX } from "./moreId";
import { runRelayout } from "./layout";
import { useGraph, type Pos } from "./store";

/**
 * The address graph's "Re-layout" tool: lays the canvas out again by force, pinned nodes staying where they
 * are, and records the move as one undo step (like a drag). Dragged "+N more" proxies are placed again and
 * their positions forgotten (undo brings them back). Positions are view state, so it also works on a
 * snapshot graph.
 */
export function relayoutGraph(cy: cytoscape.Core): void {
  const { ui, proxyPos, setPositions, commitMove, clearProxyPositions } = useGraph.getState();
  const pinned = new Set(Object.keys(ui).filter((k) => ui[k]!.pinned));
  const before = new Map<string, Pos>();
  cy.nodes().forEach((n) => {
    if (!isMoreId(n.id())) before.set(n.id(), { ...n.position() });
  });
  const after = runRelayout(cy, new Set(cy.nodes().map((n) => n.id()).filter((id) => pinned.has(id.toLowerCase()))));
  if (after.size === 0) return;
  setPositions(Object.fromEntries(after));
  clearProxyPositions();
  const placed = Object.entries(proxyPos).map(([c, p]) => [`${MORE_PREFIX}${c}`, p] as const);
  commitMove(Object.fromEntries([...[...after.keys()].map((id) => [id, before.get(id)!] as const), ...placed]));
}
