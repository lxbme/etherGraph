import type cytoscape from "cytoscape";
import { isMoreId } from "./elements";
import { runRelayout } from "./layout";
import { useGraph, type Pos } from "./store";

/**
 * The address graph's "Re-layout" tool: lays the canvas out again by force, pinned nodes staying where they
 * are, and records the move as one undo step (like a drag). Positions are view state, so it also works on a
 * snapshot graph.
 */
export function relayoutGraph(cy: cytoscape.Core): void {
  const { ui, setPositions, commitMove } = useGraph.getState();
  const pinned = new Set(Object.keys(ui).filter((k) => ui[k]!.pinned));
  const before = new Map<string, Pos>();
  cy.nodes().forEach((n) => {
    if (!isMoreId(n.id())) before.set(n.id(), { ...n.position() });
  });
  const after = runRelayout(cy, new Set(cy.nodes().map((n) => n.id()).filter((id) => pinned.has(id.toLowerCase()))));
  if (after.size === 0) return;
  setPositions(Object.fromEntries(after));
  commitMove(Object.fromEntries([...after.keys()].map((id) => [id, before.get(id)!])));
}
