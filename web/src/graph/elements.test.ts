import { describe, expect, test } from "vitest";
import type { EdgeDto } from "../api/generated/EdgeDto";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { shortAddr } from "../lib/address";
import { edgeElement, nodeElement, toElements } from "./elements";
import { MAX_NEIGHBOUR_LIMIT, type GraphState, type NodeUi } from "./store";
import { edgeWidth, type VisualEdge } from "./visualEdges";

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const C = "0x" + "c".repeat(40);
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";

function node(p: Partial<NodeSummaryDto> = {}): NodeSummaryDto {
  return {
    address: A, kind: "eoa", display_name: null, ens: null, contract_name: null,
    labels: [], partial: false, syncing: false, synced: true, hot: false, identified: true, nonce: null, balance: null, ...p,
  };
}
function dto(p: Partial<EdgeDto> = {}): EdgeDto {
  return {
    from: A, to: B, asset: null, asset_kind: "native", count: 1, sum: "1",
    first_ts: "2024-01-01T00:00:00Z", last_ts: "2024-01-02T00:00:00Z",
    decimals: 18, symbol: null, trust: { level: "listed", impersonates: null, reason: null }, ...p,
  };
}
function vedge(p: Partial<VisualEdge> = {}): VisualEdge {
  return {
    id: `c:${A}>${B}`, from: A, to: B, color: "eth", count: 1,
    assets: [dto()], badge: null, expanded: false, ...p,
  };
}
const ui = (p: Partial<NodeUi> = {}): NodeUi => ({ pinned: false, hidden: false, note: "", ...p });
const ctx = { selected: false, isCenter: false, omitted: 0 };
const classesOf = (el: { classes?: string | string[] }) =>
  (Array.isArray(el.classes) ? el.classes : (el.classes ?? "").split(/\s+/)).filter(Boolean);

type St = Pick<GraphState, "ui" | "centers" | "selection" | "highlightTransfer">;
const state = (p: Partial<St> = {}): St => ({
  ui: {}, centers: [], selection: null, highlightTransfer: null, ...p,
});

describe("nodeElement", () => {
  test("node classes encode kind, category, sync state, user label, pinned", () => {
    const el = nodeElement(
      node({
        kind: "contract",
        partial: true,
        labels: [
          { id: 1, text: "Binance 14", category: "cex", source: "import:x" },
          { id: 2, text: "mine", category: "scam", source: "user" },
        ],
      }),
      ui({ pinned: true }),
      { selected: true, isCenter: true, omitted: 0 },
    );
    const cls = classesOf(el);
    expect(cls).toEqual(
      expect.arrayContaining(["kind-contract", "cat-cex", "synced", "partial", "pinned", "user-label", "selected", "center"]),
    );
    expect(cls).not.toContain("unsynced");
    expect(cls).not.toContain("syncing");
    expect(el.group).toBe("nodes");
  });

  test("node without labels gets cat-none and no optional classes", () => {
    const cls = classesOf(nodeElement(node({ kind: "unknown" }), undefined, ctx));
    expect(cls.sort()).toEqual(["cat-none", "kind-unknown", "synced"]);
  });

  test("unsynced node gets 'unsynced' class; syncing node gets 'syncing' not 'unsynced'", () => {
    const un = classesOf(nodeElement(node({ synced: false, syncing: false }), undefined, ctx));
    expect(un).toContain("unsynced");
    expect(un).not.toContain("synced");
    const sy = classesOf(nodeElement(node({ synced: false, syncing: true }), undefined, ctx));
    expect(sy).toContain("syncing");
    expect(sy).not.toContain("unsynced");
  });

  test("label falls back to short address", () => {
    const el = nodeElement(node({ address: A.toUpperCase().replace("0X", "0x") }), undefined, ctx);
    expect(el.data.id).toBe(A);
    expect(el.data.label).toBe(shortAddr(A));
    expect(el.data.sub).toBe(shortAddr(A));
    expect(el.data.text).toBe(shortAddr(A));

    const named = nodeElement(node({ display_name: "alice.eth" }), undefined, ctx);
    expect(named.data.label).toBe("alice.eth");
    expect(named.data.text).toBe(`alice.eth\n${shortAddr(A)}`);
  });

  test("states are classes (drawn as corner icons), never glyphs in the label; the omitted count stays", () => {
    const el = nodeElement(
      node({ display_name: "Binance 14", partial: true, syncing: true }),
      ui({ pinned: true }),
      { ...ctx, omitted: 1834 },
    );
    expect(el.data.omitted).toBe(1834);
    expect(el.data.text).toBe(`Binance 14\n${shortAddr(A)}`);
    expect(el.data.text).not.toMatch(/[⚠⏳📌]/u);
    expect(classesOf(el)).toEqual(expect.arrayContaining(["partial", "syncing", "pinned"]));
  });

  test("stored position is carried into the element", () => {
    const el = nodeElement(node(), ui({ pos: { x: 10, y: -5 } }), ctx);
    expect(el.position).toEqual({ x: 10, y: -5 });
    expect(nodeElement(node(), undefined, ctx).position).toBeUndefined();
  });
});

describe("edgeElement", () => {
  test("edge width and asset class", () => {
    const el = edgeElement(vedge({ count: 100, color: "stable", badge: "×3" }), false);
    expect(el.group).toBe("edges");
    expect(el.data).toMatchObject({ id: `c:${A}>${B}`, source: A, target: B, width: edgeWidth(100), badge: "×3" });
    expect(classesOf(el)).toEqual(["asset-stable"]);

    const hl = edgeElement(vedge({ color: "other" }), true);
    expect(classesOf(hl).sort()).toEqual(["asset-other", "highlighted"]);
    expect(hl.data.width).toBe(edgeWidth(1));
    expect("badge" in hl.data).toBe(false);
  });

  test("an edge carrying a suspicious or scam asset is flagged: class and a ⚠ label (scam wins)", () => {
    const fake = dto({ asset: "0x" + "f".repeat(40), asset_kind: "erc20", symbol: "USDT", trust: { level: "suspicious", impersonates: { address: USDT, symbol: "USDT", name: "Tether USD" }, reason: null } });
    const scam = dto({ asset: "0x" + "e".repeat(40), asset_kind: "erc20", symbol: "FREE", trust: { level: "scam", impersonates: null, reason: "spam-token" } });
    const one = edgeElement(vedge({ color: "erc20", assets: [fake] }), false);
    expect(classesOf(one).sort()).toEqual(["asset-erc20", "asset-suspicious"]);
    expect(one.data.badge).toBe("⚠");
    const merged = edgeElement(vedge({ badge: "×3", assets: [dto(), fake, scam] }), false);
    expect(classesOf(merged).sort()).toEqual(["asset-eth", "asset-scam"]);
    expect(merged.data.badge).toBe("⚠ ×3");
    const plain = edgeElement(vedge({ assets: [dto({ trust: { level: "unknown", impersonates: null, reason: null } })] }), false);
    expect(classesOf(plain)).toEqual(["asset-eth"]);
    expect("badge" in plain.data).toBe(false);
  });
});

describe("toElements", () => {
  const nodes = [node({ address: A }), node({ address: B }), node({ address: C })];

  test("skips hidden nodes and edges with missing endpoints; flags center, selection, omitted", () => {
    const els = toElements(
      nodes,
      [vedge(), vedge({ id: `c:${B}>${C}`, from: B, to: C })],
      state({ ui: { [C]: ui({ hidden: true }) }, centers: [A], selection: { kind: "node", address: B } }),
      { [A]: 7 },
    );
    const ids = els.map((e) => e.data.id);
    expect(ids).toEqual([A, B, `more:${A}`, `c:${A}>${B}`, `more-edge:${A}`]);
    expect(classesOf(els[0]!)).toContain("center");
    expect(els[0]!.data.omitted).toBe(7);
    expect(classesOf(els[1]!)).toContain("selected");
    expect(classesOf(els[0]!)).not.toContain("selected");
  });

  test("a center with omitted neighbours gets a +N more proxy node and a dashed-style edge", () => {
    const els = toElements(nodes, [vedge()], state({ centers: [A] }), { [A]: 12 });
    const more = els.find((e) => e.data.id === `more:${A}`)!;
    expect(more.data.label).toBe("+12 more · click +3");
    expect(more.data.center).toBe(A);
    expect(classesOf(more)).toEqual(["more"]);
    expect(more.selectable).toBe(false);
    expect(more.grabbable).toBe(false);
    const edge = els.find((e) => e.data.id === `more-edge:${A}`)!;
    expect(edge.group).toBe("edges");
    expect(edge.data).toMatchObject({ source: A, target: `more:${A}` });
    expect(els.filter((e) => String(e.data.id).startsWith("more")).length).toBe(2);
    expect(els[0]!.data.text).not.toMatch(/\+12/);
  });

  test("the +N more label says what one click adds: the batch, capped by what is left (limit raised past the shown count)", () => {
    const label = (omitted: number) => {
      const els = toElements(nodes, [], { ...state({ centers: [A] }), limits: { [A]: 10 }, reveal: { batch: 12, shown: { [A]: 25 } } }, { [A]: omitted });
      return els.find((e) => e.data.id === `more:${A}`)!.data.label;
    };
    expect(label(40)).toBe("+40 more · click +12");
    expect(label(5)).toBe("+5 more · click +5");
  });

  test("no proxy when the center is hidden, nothing is omitted, or the address is not a center", () => {
    const hiddenCenter = toElements(nodes, [], state({ centers: [A], ui: { [A]: ui({ hidden: true }) } }), { [A]: 12 });
    expect(hiddenCenter.some((e) => String(e.data.id).startsWith("more"))).toBe(false);
    const none = toElements(nodes, [], state({ centers: [A] }), { [A]: 0 });
    expect(none.some((e) => String(e.data.id).startsWith("more"))).toBe(false);
    const notCenter = toElements(nodes, [], state({ centers: [A] }), { [B]: 3 });
    expect(notCenter.some((e) => String(e.data.id).startsWith("more"))).toBe(false);
  });

  test("no proxy once the center's limit is at the server's maximum (it could reveal nothing more)", () => {
    const atMax = toElements(nodes, [], { ...state({ centers: [A] }), limits: { [A]: MAX_NEIGHBOUR_LIMIT } }, { [A]: 12 });
    expect(atMax.some((e) => String(e.data.id).startsWith("more"))).toBe(false);
    const below = toElements(nodes, [], { ...state({ centers: [A] }), limits: { [A]: MAX_NEIGHBOUR_LIMIT - 1 } }, { [A]: 12 });
    expect(below.some((e) => e.data.id === `more:${A}`)).toBe(true);
  });

  test("no proxy when a click would reveal nothing (the shown neighbours already reach the server's maximum)", () => {
    const full = toElements(
      nodes,
      [],
      { ...state({ centers: [A] }), limits: { [A]: 10 }, reveal: { batch: 12, shown: { [A]: MAX_NEIGHBOUR_LIMIT } } },
      { [A]: 12 },
    );
    expect(full.some((e) => String(e.data.id).startsWith("more"))).toBe(false);
  });

  test("selected pair marks edges in both directions", () => {
    const els = toElements(
      nodes,
      [vedge(), vedge({ id: `c:${B}>${A}`, from: B, to: A }), vedge({ id: `c:${B}>${C}`, from: B, to: C })],
      state({ selection: { kind: "pair", a: B, b: A } }),
      {},
    );
    const sel = els.filter((e) => e.group === "edges" && classesOf(e).includes("selected")).map((e) => e.data.id);
    expect(sel).toEqual([`c:${A}>${B}`, `c:${B}>${A}`]);
  });

  test("highlightTransfer marks the visual edge carrying that asset", () => {
    const usdt = dto({ asset: USDT, asset_kind: "erc20" });
    const els = toElements(
      nodes,
      [
        vedge({ id: `e:${A}>${B}:eth`, expanded: true }),
        vedge({ id: `e:${A}>${B}:${USDT}`, color: "stable", assets: [usdt], expanded: true }),
      ],
      state({ highlightTransfer: { from: A, to: B, asset: USDT.toUpperCase().replace("0X", "0x") } }),
      {},
    );
    const hl = els.filter((e) => classesOf(e).includes("highlighted")).map((e) => e.data.id);
    expect(hl).toEqual([`e:${A}>${B}:${USDT}`]);

    const eth = toElements(nodes, [vedge()], state({ highlightTransfer: { from: A, to: B, asset: null } }), {});
    expect(classesOf(eth.find((e) => e.group === "edges")!)).toContain("highlighted");
  });
});
