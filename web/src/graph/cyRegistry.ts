import type cytoscape from "cytoscape";

let mainCy: cytoscape.Core | null = null;

/** The live Cytoscape instance of the address graph (null when unmounted). */
export function setMainCy(cy: cytoscape.Core | null): void {
  mainCy = cy;
}
export function getMainCy(): cytoscape.Core | null {
  return mainCy;
}
