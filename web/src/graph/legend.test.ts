import type cytoscape from "cytoscape";
import { fullLegendGroups, legendFor, txLegendFor, type LegendGroup } from "./legend";
import { NODE_SHAPE, assetColors, categoryColors, iconSvgs, stateColors } from "./styles";

const node = (id: string, classes: string): cytoscape.ElementDefinition => ({ group: "nodes", data: { id }, classes });
const edge = (id: string, classes: string, data: Record<string, unknown> = {}): cytoscape.ElementDefinition => ({
  group: "edges",
  data: { id, source: "a", target: "b", width: 2, ...data },
  classes,
});
const ids = (groups: LegendGroup[]) => Object.fromEntries(groups.map((g) => [g.id, g.items.map((i) => i.id)]));
const item = (groups: LegendGroup[], group: string, id: string) => {
  const it = groups.find((g) => g.id === group)?.items.find((i) => i.id === id);
  if (!it) throw new Error(`no ${group}/${id}`);
  return it;
};

const base = [node("a", "kind-eoa cat-none synced"), node("b", "kind-eoa cat-none synced"), edge("e", "asset-eth")];

describe("legendFor", () => {
  test("only eoa nodes and an eth edge: shape (eoa), asset (eth) and edge (width), no category", () => {
    expect(ids(legendFor(base, "light"))).toEqual({ shape: ["eoa"], asset: ["eth"], edge: ["width"] });
  });

  test("a cat-exchange node lists exchange and, for contrast, no-category", () => {
    const g = legendFor([...base, node("x", "kind-contract cat-exchange synced")], "light");
    expect(ids(g).category).toEqual(["exchange", "none"]);
    expect(ids(g).shape).toEqual(["eoa", "contract"]);
  });

  test("the swatch colours come from the graph style exports", () => {
    const g = legendFor([...base, node("x", "kind-eoa cat-exchange")], "light");
    expect(item(g, "category", "exchange").swatch).toMatchObject({
      kind: "node",
      fill: categoryColors("light").exchange.fill,
      stroke: categoryColors("light").exchange.stroke,
    });
    expect(item(g, "shape", "eoa").swatch).toMatchObject({ kind: "node", shape: NODE_SHAPE.eoa });
    expect(item(g, "asset", "eth").swatch).toMatchObject({ kind: "edge", color: assetColors("light").eth });
  });

  test("cat-other and categories the legend does not list count as no category", () => {
    expect(ids(legendFor([...base, node("o", "kind-eoa cat-other")], "light")).category).toBeUndefined();
    expect(ids(legendFor([...base, node("o", "kind-eoa cat-whatever")], "light")).category).toBeUndefined();
    const g = legendFor([node("o", "kind-eoa cat-other"), node("x", "kind-eoa cat-mixer")], "light");
    expect(ids(g).category).toEqual(["mixer", "none"]);
  });

  test("categories count only non-center nodes; sanctioned shows as scam", () => {
    const g = legendFor([node("c", "kind-eoa cat-exchange center"), node("s", "kind-eoa cat-sanctioned")], "light");
    expect(ids(g).category).toEqual(["scam"]);
  });

  test("a more node lists +N more in the state group", () => {
    const g = legendFor([...base, node("more:a", "more"), edge("more-edge:a", "more")], "light");
    expect(ids(g).state).toEqual(["more"]);
    // A pill with "+", outlined like the canvas pill.
    expect(item(g, "state", "more").swatch).toEqual({
      kind: "pill", fill: stateColors("light").more.fill, stroke: stateColors("light").more.stroke, text: "+",
    });
    expect(stateColors("light").more.stroke).toBe("#6b7280");
  });

  test("state lists center, unsynced, selected, label, pinned, syncing and partial only when present", () => {
    const g = legendFor(
      [
        node("a", "kind-eoa cat-none center selected"),
        node("b", "kind-eoa cat-none unsynced user-label pinned"),
        node("c", "kind-eoa cat-none syncing partial"),
      ],
      "dark",
    );
    expect(ids(g).state).toEqual(["center", "unsynced", "selected", "user-label", "pinned", "syncing", "partial"]);
    expect(item(g, "state", "unsynced").swatch).toMatchObject({ kind: "node", dashed: true });
    expect(item(g, "state", "pinned").swatch).toEqual({ kind: "icon", svg: iconSvgs("dark").pin });
    expect(item(g, "state", "selected").swatch).toMatchObject({ kind: "node", ring: expect.any(String) });
  });

  test("a merged edge badge adds the ×N row; more edges alone show no edge group", () => {
    expect(ids(legendFor([...base, edge("m", "asset-erc20", { badge: "×3" })], "light")).edge).toEqual(["width", "badge"]);
    expect(ids(legendFor([node("a", "kind-eoa"), node("more:a", "more"), edge("more-edge:a", "more")], "light")).edge).toBeUndefined();
  });

  test("no elements, no groups", () => {
    expect(legendFor([], "light")).toEqual([]);
  });
});

describe("txLegendFor", () => {
  test("call and flow edges with the seq note, the asset classes present, no width row", () => {
    const g = txLegendFor(
      [node("a", "kind-eoa cat-none"), node("b", "kind-contract cat-defi"), edge("call", "call"), edge("flow-1-0", "asset-stable")],
      "light",
    );
    expect(ids(g).tx).toEqual(["call", "flow", "seq"]);
    expect(ids(g).asset).toEqual(["stable"]);
    expect(ids(g).edge).toBeUndefined();
    expect(item(g, "tx", "call").swatch).toMatchObject({ kind: "edge", dashed: true, color: assetColors("light").other });
  });

  test("no elements, no groups", () => {
    expect(txLegendFor([], "light")).toEqual([]);
  });
});

test("fullLegendGroups lists every entry", () => {
  expect(ids(fullLegendGroups("light"))).toEqual({
    shape: ["eoa", "contract", "unknown"],
    category: ["exchange", "defi", "bridge", "mixer", "scam", "none"],
    state: ["center", "unsynced", "selected", "user-label", "pinned", "syncing", "partial", "more"],
    asset: ["eth", "stable", "erc20", "nft", "other"],
    edge: ["width", "badge"],
    tx: ["call", "flow", "seq"],
  });
});
