import type cytoscape from "cytoscape";
import { fullLegendGroups, legendFor, txLegendFor, type LegendGroup } from "./legend";
import { NODE_SHAPE, assetColors, categoryColors, delegationColor, iconSvgs, mutedColor, stateColors, trustColors } from "./styles";

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

  test("a cat-cex node lists exchange and, for contrast, no-category", () => {
    const g = legendFor([...base, node("x", "kind-contract cat-cex synced")], "light");
    expect(ids(g).category).toEqual(["cex", "none"]);
    expect(ids(g).shape).toEqual(["eoa", "contract"]);
  });

  test("the swatch colours come from the graph style exports", () => {
    const g = legendFor([...base, node("x", "kind-eoa cat-cex")], "light");
    expect(item(g, "category", "cex").swatch).toMatchObject({
      kind: "node",
      fill: categoryColors("light").cex.fill,
      stroke: categoryColors("light").cex.stroke,
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
    const g = legendFor([node("c", "kind-eoa cat-cex center"), node("s", "kind-eoa cat-sanctioned")], "light");
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
    expect(ids(g).state).not.toContain("box-selected"); // native selection carries no class: full legend only
    expect(item(fullLegendGroups("light"), "state", "box-selected").swatch).toMatchObject({ kind: "node", ring: expect.any(String), ringDashed: true });
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

  test("token-contract and delegation rows only when their edges are on the canvas", () => {
    const plain = [node("a", "kind-eoa cat-none"), edge("call", "call")];
    expect(ids(txLegendFor(plain, "light")).tx).toEqual(["call", "flow", "seq"]);
    const g = txLegendFor([...plain, edge("asset-link-a-b", "asset-link"), edge("delegation-0", "delegation", { label: "delegates to" })], "light");
    expect(ids(g).tx).toEqual(["call", "flow", "seq", "asset-link", "delegation"]);
    // The dotted link is not an asset class.
    expect(ids(g).asset).toBeUndefined();
    expect(item(g, "tx", "asset-link")).toMatchObject({ label: "legend.tx.assetLink", swatch: { kind: "edge", dotted: true, color: mutedColor("light") } });
    expect(item(g, "tx", "delegation")).toMatchObject({
      label: "legend.tx.delegation",
      swatch: { kind: "edge", dashed: true, color: delegationColor("light") },
    });
  });
});

test("flagged edges add the possible-impersonation and known-scam rows on both canvases; a lone ⚠ is not a ×N badge", () => {
  const sus = edge("s", "asset-erc20 asset-suspicious", { badge: "⚠" });
  const g = legendFor([...base, sus], "light");
  expect(ids(g).asset).toEqual(["eth", "erc20", "suspicious"]);
  expect(ids(g).edge).toEqual(["width"]);
  expect(item(g, "asset", "suspicious")).toMatchObject({
    label: "legend.asset.suspicious",
    swatch: { kind: "edge", badge: "⚠", badgeColor: trustColors("light").suspicious },
  });
  expect(ids(legendFor([...base, edge("m", "asset-eth asset-scam", { badge: "⚠ ×2" })], "light"))).toMatchObject({
    asset: ["eth", "scam"],
    edge: ["width", "badge"],
  });
  const tx = txLegendFor([node("a", "kind-eoa cat-none"), edge("flow-1-0", "asset-erc20 asset-suspicious", { label: "⚠ ① 1 USDT" })], "light");
  expect(ids(tx).asset).toEqual(["erc20", "suspicious"]);
  expect(item(tx, "asset", "suspicious").label).toBe("legend.asset.suspicious");
  expect(ids(legendFor(base, "light")).asset).toEqual(["eth"]);
});

test("a canvas with cex and hacker nodes lists exactly those rows plus no-category for an untinted node", () => {
  const g = legendFor([node("a", "kind-eoa cat-cex"), node("b", "kind-eoa cat-hacker"), node("c", "kind-eoa cat-other")], "light");
  expect(ids(g).category).toEqual(["cex", "hacker", "none"]);
});

test("fullLegendGroups lists every entry", () => {
  expect(ids(fullLegendGroups("light"))).toEqual({
    shape: ["eoa", "contract", "unknown"],
    category: ["cex", "dex", "defi", "bridge", "mixer", "scam", "hacker", "mev", "fund", "nft", "staking", "none"],
    state: ["center", "unsynced", "selected", "box-selected", "user-label", "pinned", "syncing", "partial", "more"],
    asset: ["eth", "stable", "erc20", "nft", "other", "suspicious", "scam"],
    edge: ["width", "badge"],
    tx: ["call", "flow", "seq", "asset-link", "delegation"],
  });
});

test("a box selection count adds the dashed-ring row on both canvases", () => {
  expect(ids(legendFor(base, "light", 0)).state).toBeUndefined();
  expect(ids(legendFor(base, "light", 2)).state).toEqual(["box-selected"]);
  expect(ids(txLegendFor(base, "light", 2)).state).toEqual(["box-selected"]);
});
