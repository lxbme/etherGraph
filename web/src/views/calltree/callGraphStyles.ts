import type cytoscape from "cytoscape";
import { assetColors, mutedColor, negColor, stateColors, txFlowStylesheet, type Theme } from "../../graph/styles";

type Block = { selector: string; style: Record<string, string | number> };
const lineColor = (c: string) => ({ "line-color": c, "target-arrow-color": c, "source-arrow-color": c });

/**
 * The call graph: the tx stylesheet (nodes, labelled edges) plus the call kinds. A call is a solid grey line, a
 * delegatecall dashed, a read-only call thin and muted, a creation starts at a hollow circle and a self-destruct
 * is dotted; a failed call is red. Edge classes: `delegate`, `static`, `create`, `destruct`, `failed`,
 * `self-loop`, `highlighted`; endpoint nodes of the selected call are `highlighted` too.
 */
export function callGraphStylesheet(theme: Theme): cytoscape.StylesheetJson {
  const muted = mutedColor(theme);
  const neg = negColor(theme);
  const accent = stateColors(theme).selectedRing;
  const blocks: Block[] = [
    { selector: "edge", style: lineColor(assetColors(theme).other) },
    { selector: "edge.delegate", style: { "line-style": "dashed" } },
    { selector: "edge.static", style: { width: 1, ...lineColor(muted), color: muted, opacity: 0.6 } },
    { selector: "edge.create", style: { "source-arrow-shape": "circle", "source-arrow-fill": "hollow" } },
    { selector: "edge.destruct", style: { "line-style": "dotted" } },
    { selector: "edge.failed", style: { ...lineColor(neg), color: neg, opacity: 1 } },
    {
      // A contract calling itself (e.g. a multicall delegating to its own code): a loop above the node.
      selector: "edge.self-loop",
      style: { "text-rotation": "none", "loop-direction": "-30deg", "loop-sweep": "-60deg", "control-point-step-size": 56 },
    },
    {
      selector: "node.highlighted",
      style: { "outline-color": accent, "outline-style": "solid", "outline-width": 3, "outline-offset": 2, "outline-opacity": 0.55 },
    },
    // After the kinds, so the selected call shows in the accent whatever its kind.
    { selector: "edge.highlighted", style: { ...lineColor(accent), color: accent, opacity: 1, "z-index": 10 } },
  ];
  return [...(txFlowStylesheet(theme) as unknown as Block[]), ...blocks] as unknown as cytoscape.StylesheetJson;
}
