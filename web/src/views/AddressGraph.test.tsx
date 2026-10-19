import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type cytoscape from "cytoscape";
import { api } from "../api/endpoints";
import { ApiError } from "../api/errors";
import type { EdgeDto } from "../api/generated/EdgeDto";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { useCanvasMetrics } from "../graph/canvasMetrics";
import { openFakePopover, pressEscape } from "../graph/fakePopover.testutil";
import { useBoxSelection } from "../graph/boxSelection";
import type { CytoscapeViewProps } from "../graph/CytoscapeView";
import { pairKey, setUnfreezeHandler, useGraph } from "../graph/store";
import { Toasts } from "../shell/Toasts";
import { DetailPanel } from "../panels/DetailPanel";
import { useInfo } from "../panels/info/infoStore";
import { useUi } from "../panels/uiStore";
import { exportImage } from "../graph/exportImage";
import { relayoutGraph } from "../graph/relayout";
import { download } from "../lib/download";
import { useWorkspace } from "../workspace/useWorkspace";
import { registerSnapshotEffects } from "../workspace/snapshot";
import { clearExport, useFileRequest } from "../workspace/fileRequest";
import { AddressGraph } from "./AddressGraph";
import { GraphSnapshotBanner, LiveConfirm } from "./SnapshotBanner";

vi.mock("../graph/exportImage", async (orig) => ({ ...(await orig<typeof import("../graph/exportImage")>()), exportImage: vi.fn() }));
vi.mock("../graph/relayout", () => ({ relayoutGraph: vi.fn() }));
vi.mock("../lib/download", async (orig) => ({ ...(await orig<typeof import("../lib/download")>()), download: vi.fn() }));

const h = vi.hoisted(() => ({ props: null as CytoscapeViewProps | null, renders: 0 }));
vi.mock("../graph/CytoscapeView", () => ({
  CytoscapeView: (p: CytoscapeViewProps) => {
    h.props = p;
    h.renders++;
    return <div data-testid="cy" />;
  },
}));

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);

const node = (address: string, synced: boolean): NodeSummaryDto => ({
  address, kind: "eoa", display_name: null, ens: null, contract_name: null, labels: [],
  partial: false, syncing: false, synced, hot: false, identified: true, nonce: null, balance: null,
});
const edge: EdgeDto = {
  from: A, to: B, asset: null, asset_kind: "native", count: 3, sum: "1000", first_ts: "", last_ts: "",
  decimals: 18, symbol: "ETH", trust: { level: "listed", impersonates: null, reason: null },
};
const data: GraphResponseDto = { nodes: [node(A, true), node(B, false)], edges: [edge], omitted: {}, coverage: {} };

const props = () => {
  if (!h.props) throw new Error("CytoscapeView not rendered");
  return h.props;
};
const ids = () => props().elements.map((e) => e.data.id);

/** Minimal Cytoscape stand-in for the onReady handle. */
function fakeCy() {
  const unselect = vi.fn();
  const handlers: Record<string, (e: unknown) => void> = {};
  const cy = {
    $: vi.fn(() => ({ unselect })),
    on: vi.fn((ev: string, _sel: string, fn: (e: unknown) => void) => { handlers[ev] = fn; }),
    elements: () => ({ empty: () => false }),
  };
  const grab = (id: string, pos: { x: number; y: number }) =>
    handlers.grab?.({ target: { id: () => id, position: () => ({ ...pos }) } });
  return { cy: cy as unknown as cytoscape.Core, unselect, grab, $: cy.$ };
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={qc}>
      <AddressGraph />
      <Toasts />
    </QueryClientProvider>
  );
  return { ...render(tree()), tree };
}

async function mountWithData() {
  useGraph.getState().addCenter(A);
  const r = mount();
  await waitFor(() => expect(ids()).toContain(A));
  const f = fakeCy();
  act(() => props().onReady?.(f.cy));
  return { ...r, f };
}

beforeEach(() => {
  h.props = null;
  h.renders = 0;
  useGraph.getState().reset();
  useBoxSelection.setState({ ids: [] });
  useUi.setState({ labelEditorFor: null, detailOpen: true });
  vi.spyOn(api, "graphEdges").mockResolvedValue(data);
});
afterEach(() => vi.restoreAllMocks());

test("empty canvas shows the guide text and no elements", () => {
  mount();
  expect(screen.getByText("Enter an address, tx hash or ENS name to start exploring")).toBeInTheDocument();
  expect(props().elements).toEqual([]);
  expect(props().layout).toBe("incremental");
  expect(api.graphEdges).not.toHaveBeenCalled();
});

test("graph data flows into elements; elements and stylesheet are memoized", async () => {
  const { rerender, tree } = await mountWithData();
  expect(screen.queryByText("Enter an address, tx hash or ENS name to start exploring")).toBeNull();
  expect(ids()).toEqual([A, B, `c:${A}>${B}`]);
  const { elements, stylesheet } = props();
  const before = h.renders;
  rerender(tree());
  expect(h.renders).toBeGreaterThan(before);
  expect(props().elements).toBe(elements);
  expect(props().stylesheet).toBe(stylesheet);
});

test("the legend sits in the canvas and lists only what is on it", async () => {
  const { container } = mount();
  // Empty canvas: just the header and a hint (it is still the tour's second step).
  expect(screen.getByTestId("legend")).toHaveTextContent("Signals appear here once the graph has nodes");
  act(() => useGraph.getState().addCenter(A));
  await waitFor(() => expect(ids()).toContain(A));
  const legend = within(container.querySelector(".address-graph")!).getByTestId("legend");
  expect(within(legend).getByText("Center (address being explored)")).toBeInTheDocument();
  expect(within(legend).queryByText("Pinned")).toBeNull();
});

test("hover tooltips: a pinned center says so; an edge names its ends by display name", async () => {
  vi.mocked(api.graphEdges).mockResolvedValue({ ...data, nodes: [{ ...node(A, true), display_name: "alice.eth" }, node(B, false)] });
  await mountWithData();
  act(() => useGraph.getState().setPinned([A], true));
  act(() => props().onHover?.({ kind: "node", id: A, pos: { x: 10, y: 10 } }));
  expect(screen.getByTestId("graph-tooltip")).toHaveTextContent("StateCenter, Pinned");
  act(() => props().onHover?.({ kind: "edge", id: `c:${A}>${B}`, pos: { x: 10, y: 10 } }));
  expect(screen.getByTestId("graph-tooltip")).toHaveTextContent("alice.eth → 0xbbbb");
  act(() => props().onHover?.(null));
  expect(screen.queryByTestId("graph-tooltip")).toBeNull();
});

test("the expanded legend's width is kept clear on the left of every fit", async () => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(180);
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockReturnValue(12);
  await mountWithData();
  expect(props().fitInsetLeft).toBe(192);
  act(() => screen.getByRole("button", { name: "Collapse legend" }).click());
  expect(props().fitInsetLeft).toBe(0);
});

test("hidden nodes and their edges are left out", async () => {
  await mountWithData();
  act(() => useGraph.getState().setHidden([B], true));
  expect(ids()).toEqual([A]);
});

test("tapping a node selects it and drops the box selection (natively too); tapping an edge selects the pair", async () => {
  const { f } = await mountWithData();
  act(() => props().onSelectionChange([A, B]));
  act(() => props().onTapNode(B, { shift: false }));
  expect(useGraph.getState().selection).toEqual({ kind: "node", address: B });
  expect(useBoxSelection.getState().ids).toEqual([]);
  expect(f.$).toHaveBeenCalledWith(":selected");
  expect(f.unselect).toHaveBeenCalled();
  expect(props().elements.find((e) => e.data.id === B)?.classes).toContain("selected");

  act(() => props().onTapEdge(A, B, "e1"));
  expect(useGraph.getState().selection).toEqual({ kind: "pair", a: A, b: B });
});

test("double-clicking an unsynced node starts a sync and toasts", async () => {
  const sync = vi.spyOn(api, "sync").mockResolvedValue({ jobs: [] } as never);
  await mountWithData();
  act(() => props().onDblTapNode(A)); // synced: nothing
  expect(sync).not.toHaveBeenCalled();
  act(() => props().onDblTapNode(B));
  expect(sync).toHaveBeenCalledWith({ addresses: [B] });
  expect(await screen.findByText("Started syncing 0xbbbb…bbbb")).toBeInTheDocument();
});

test("double-clicking a contract never expands; it shallow-syncs only when unsynced", async () => {
  const sync = vi.spyOn(api, "sync").mockResolvedValue({ jobs: [] } as never);
  const contracts: GraphResponseDto = {
    ...data,
    nodes: [{ ...node(A, true), kind: "contract" }, { ...node(B, false), kind: "contract" }],
  };
  vi.spyOn(api, "graphEdges").mockResolvedValue(contracts);
  await mountWithData();
  act(() => props().onDblTapNode(A));
  expect(sync).not.toHaveBeenCalled();
  act(() => props().onDblTapNode(B));
  expect(sync).toHaveBeenCalledWith({ addresses: [B], depth: "shallow" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a failed sync shows the mapped error", async () => {
  vi.spyOn(api, "sync").mockRejectedValue(new ApiError("quota_exhausted", 429, "q"));
  await mountWithData();
  act(() => props().onDblTapNode(B));
  expect(await screen.findByText("Today's Etherscan quota is used up")).toBeInTheDocument();
});

test("double-clicking an edge toggles the pair", async () => {
  await mountWithData();
  act(() => props().onDblTapEdge(B, A));
  expect(useGraph.getState().expandedPairs.has(pairKey(A, B))).toBe(true);
  expect(ids()).toContain(`e:${A}>${B}:eth`);
});

test("the box selection mirrors the canvas's native selection", async () => {
  const { f } = await mountWithData();
  act(() => props().onSelectionChange([A, B]));
  expect(useBoxSelection.getState().ids).toEqual([A, B]);
  expect(f.unselect).not.toHaveBeenCalled(); // the ring stays on the canvas
  act(() => props().onSelectionChange([B]));
  expect(useBoxSelection.getState().ids).toEqual([B]);
  act(() => props().onSelectionChange([]));
  expect(useBoxSelection.getState().ids).toEqual([]);
});

test("right-click keeps the box selection when the node is in it, drops it when not", async () => {
  const { f } = await mountWithData();
  act(() => props().onSelectionChange([A, B]));
  act(() => props().onCxtNode(A, { x: 1, y: 1 }));
  expect(useBoxSelection.getState().ids).toEqual([A, B]);
  expect(f.unselect).not.toHaveBeenCalled();
  act(() => props().onSelectionChange([B]));
  act(() => props().onCxtNode(A, { x: 1, y: 1 }));
  expect(useBoxSelection.getState().ids).toEqual([]);
  expect(f.unselect).toHaveBeenCalled();
});

test("the dashed-ring legend row shows while nodes are box-selected", async () => {
  await mountWithData();
  act(() => screen.getByRole("button", { name: "Expand legend" }).click());
  expect(screen.queryByText("In the box selection (dashed ring)")).toBeNull();
  act(() => props().onSelectionChange([A]));
  expect(screen.getByText("In the box selection (dashed ring)")).toBeInTheDocument();
});

test("the select-mode toggle in the canvas tools drives the canvas", async () => {
  await mountWithData();
  expect(props().selectMode).toBe(false);
  const toggle = screen.getByRole("button", { name: "Box select (Shift+drag)" });
  expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(within(screen.getByRole("toolbar", { name: "Canvas tools" })).getByRole("button", { name: "Box select (Shift+drag)" })).toBe(toggle);
  act(() => toggle.click());
  expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(props().selectMode).toBe(true);
});

test("the canvas tools export the address graph as ethergraph-<workspace name or graph>.<ext>", async () => {
  const blob = new Blob(["x"]);
  vi.mocked(exportImage).mockReturnValue(blob);
  const { f } = await mountWithData();
  const pick = (item: string) => {
    act(() => within(screen.getByRole("toolbar", { name: "Canvas tools" })).getByRole("button", { name: "Export" }).click());
    act(() => within(screen.getByRole("menu", { name: "Export" })).getByRole("menuitem", { name: item }).click());
  };
  pick("SVG");
  expect(exportImage).toHaveBeenLastCalledWith(f.cy, "svg");
  expect(download).toHaveBeenLastCalledWith(blob, "ethergraph-graph.svg");
  act(() => useWorkspace.setState({ name: "Case/7" }));
  pick("Transparent PNG");
  expect(exportImage).toHaveBeenLastCalledWith(f.cy, "png-transparent");
  expect(download).toHaveBeenLastCalledWith(blob, "ethergraph-Case_7.png");
  act(() => useWorkspace.getState().clear());
});

test("the canvas tools' Re-layout lays the address graph out again", async () => {
  const { f } = await mountWithData();
  act(() => within(screen.getByRole("toolbar", { name: "Canvas tools" })).getByRole("button", { name: "Re-layout" }).click());
  expect(relayoutGraph).toHaveBeenCalledWith(f.cy);
});

test("the canvas tools' File… asks to export the address graph as a file", async () => {
  await mountWithData();
  act(() => within(screen.getByRole("toolbar", { name: "Canvas tools" })).getByRole("button", { name: "Export" }).click());
  act(() => within(screen.getByRole("menu", { name: "Export" })).getByRole("menuitem", { name: "File…" }).click());
  expect(useFileRequest.getState().exporting).toEqual({ kind: "graph" });
  act(() => clearExport());
});

test("a group drag of three selected nodes is one undo step (Ctrl+Z)", async () => {
  const C = "0x" + "cc".repeat(20);
  vi.mocked(api.graphEdges).mockResolvedValue({ ...data, nodes: [...data.nodes, node(C, true)] });
  const { f } = await mountWithData();
  await waitFor(() => expect(ids()).toContain(C));
  act(() => props().onSelectionChange([A, B, C]));
  const steps = useGraph.getState()._past.length;
  // Grabbing one selected node grabs them all; they are dropped in the same tick.
  f.grab(A, { x: 0, y: 0 });
  f.grab(B, { x: 100, y: 0 });
  f.grab(C, { x: 200, y: 0 });
  act(() => props().onDragEnd({ [A]: { x: 10, y: 50 }, [B]: { x: 110, y: 50 }, [C]: { x: 210, y: 50 } }));
  expect(useGraph.getState().ui[C]?.pos).toEqual({ x: 210, y: 50 });
  expect(useGraph.getState()._past).toHaveLength(steps + 1);
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true })); });
  expect(useGraph.getState().ui[A]?.pos).toEqual({ x: 0, y: 0 });
  expect(useGraph.getState().ui[B]?.pos).toEqual({ x: 100, y: 0 });
  expect(useGraph.getState().ui[C]?.pos).toEqual({ x: 200, y: 0 });
  expect(useGraph.getState()._past).toHaveLength(steps);
});

test("drag end stores positions and records an undoable move", async () => {
  const { f } = await mountWithData();
  act(() => useGraph.getState().setPositions({ [B]: { x: 5, y: 5 } }));
  f.grab(A, { x: 1, y: 2 }); // A was placed by the layout: position known only from the grab
  act(() => props().onDragEnd({ [A]: { x: 10, y: 20 }, [B]: { x: 50, y: 60 } }));
  expect(useGraph.getState().ui[A]?.pos).toEqual({ x: 10, y: 20 });
  expect(useGraph.getState().ui[B]?.pos).toEqual({ x: 50, y: 60 });
  act(() => useGraph.getState().undo());
  expect(useGraph.getState().ui[A]?.pos).toEqual({ x: 1, y: 2 });
  expect(useGraph.getState().ui[B]?.pos).toEqual({ x: 5, y: 5 });
});

test("loading text only before the first data; background refetches use a subtle indicator", async () => {
  let release!: () => void;
  vi.mocked(api.graphEdges).mockImplementation(() => new Promise((r) => { release = () => r(data); }));
  useGraph.getState().addCenter(A);
  mount();
  expect(await screen.findByText("Loading…")).toBeInTheDocument();
  act(() => release());
  await waitFor(() => expect(ids()).toContain(A));
  expect(screen.queryByText("Loading…")).toBeNull();
  expect(screen.queryByLabelText("Updating")).toBeNull();

  act(() => useGraph.getState().setSort("recent")); // new key: previous data kept while it loads
  expect(await screen.findByLabelText("Updating")).toBeInTheDocument();
  expect(screen.queryByText("Loading…")).toBeNull();
  expect(ids()).toContain(A);
  act(() => release());
  await waitFor(() => expect(screen.queryByLabelText("Updating")).toBeNull());
});

test("batch bar appears for 1+ box-selected nodes with the count; background/node tap clears it", async () => {
  await mountWithData();
  act(() => props().onSelectionChange([A]));
  expect(screen.getByText("1 node selected")).toBeInTheDocument();
  act(() => props().onSelectionChange([A, B]));
  expect(screen.getByText("2 nodes selected")).toBeInTheDocument();
  act(() => props().onTapBackground?.());
  expect(screen.queryByText("2 nodes selected")).toBeNull();
  act(() => props().onSelectionChange([A, B]));
  act(() => props().onTapNode(A, { shift: false }));
  expect(useBoxSelection.getState().ids).toEqual([]);
  act(() => props().onSelectionChange([A, B]));
  act(() => screen.getByRole("button", { name: "Pin" }).click());
  expect(useGraph.getState().ui[A]?.pinned).toBe(true);
  expect(useGraph.getState().ui[B]?.pinned).toBe(true);
});

test("Escape clears the box selection and the canvas's native selection", async () => {
  const { f } = await mountWithData();
  act(() => props().onSelectionChange([A, B]));
  expect(screen.getByRole("toolbar", { name: "Batch actions" })).toBeInTheDocument();
  act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(screen.queryByRole("toolbar", { name: "Batch actions" })).toBeNull();
  expect(useBoxSelection.getState().ids).toEqual([]);
  expect(f.$).toHaveBeenCalledWith(":selected");
  expect(f.unselect).toHaveBeenCalled();
});

test("Escape with a popover open (focus on its trigger) closes only the popover; a second Escape clears the selection", async () => {
  const { f } = await mountWithData();
  act(() => props().onSelectionChange([A, B]));
  const pop = openFakePopover();
  try {
    act(() => pressEscape(pop.trigger));
    expect(pop.isOpen()).toBe(false);
    expect(useBoxSelection.getState().ids).toEqual([A, B]);
    expect(f.unselect).not.toHaveBeenCalled();
    act(() => pressEscape(pop.trigger));
    expect(useBoxSelection.getState().ids).toEqual([]);
    expect(f.unselect).toHaveBeenCalled();
  } finally {
    pop.dispose();
  }
});

test("Escape with nothing box-selected is left alone (not consumed)", async () => {
  await mountWithData();
  const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => { window.dispatchEvent(e); });
  expect(e.defaultPrevented).toBe(false);
});

test("batch bar: Unpin only while a selected node is pinned; hide, make centers, copy", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  await mountWithData();
  act(() => props().onSelectionChange([A, B]));
  const bar = () => within(screen.getByRole("toolbar", { name: "Batch actions" }));
  expect(bar().queryByRole("button", { name: "Unpin" })).toBeNull();
  act(() => useGraph.getState().setPinned([B], true));
  act(() => bar().getByRole("button", { name: "Unpin" }).click());
  expect(useGraph.getState().ui[B]?.pinned).toBe(false);
  expect(useBoxSelection.getState().ids).toEqual([]);

  act(() => props().onSelectionChange([A, B]));
  await act(async () => bar().getByRole("button", { name: "Copy addresses" }).click());
  expect(writeText).toHaveBeenCalledWith(`${A}\n${B}`);
  expect(await screen.findByText("Copied 2 addresses")).toBeInTheDocument();
  expect(useBoxSelection.getState().ids).toEqual([A, B]); // copying keeps the selection

  act(() => bar().getByRole("button", { name: "Expand as centers" }).click());
  expect(useGraph.getState().centers).toEqual([A, B]);
  act(() => props().onSelectionChange([B]));
  act(() => bar().getByRole("button", { name: "Hide" }).click());
  expect(useGraph.getState().ui[B]?.hidden).toBe(true);
  expect(screen.queryByRole("toolbar", { name: "Batch actions" })).toBeNull();
});

test("batch bar: Add label opens one editor for all selected addresses", async () => {
  const add = vi.spyOn(api, "addLabel").mockResolvedValue({ id: 1, text: "x", category: "other", source: "user" });
  await mountWithData();
  act(() => props().onSelectionChange([A, B]));
  act(() => screen.getByRole("button", { name: "Add label" }).click());
  expect(useUi.getState().labelEditorFor).toEqual([A, B]);
  fireEvent.change(screen.getByLabelText("Label text"), { target: { value: "team" } });
  await act(async () => screen.getByRole("button", { name: "Add" }).click());
  await waitFor(() => expect(add).toHaveBeenCalledTimes(2));
  expect(add.mock.calls.map((c) => c[0].address)).toEqual([A, B]);
  expect(await screen.findByText("Added the label to 2 addresses")).toBeInTheDocument();
  await waitFor(() => expect(useUi.getState().labelEditorFor).toBeNull());
});

test("right-clicking a node opens the menu; Escape closes it", async () => {
  await mountWithData();
  act(() => props().onCxtNode(A, { x: 10, y: 20 }));
  expect(screen.getByRole("menu")).toBeInTheDocument();
  act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(screen.queryByRole("menu")).toBeNull();
});

test("'older' menu item syncs with direction older", async () => {
  const sync = vi.spyOn(api, "sync").mockResolvedValue({ jobs: [] } as never);
  vi.spyOn(api, "graphEdges").mockResolvedValue({ ...data, nodes: [{ ...node(A, true), partial: true }, node(B, false)] });
  await mountWithData();
  act(() => props().onCxtNode(A, { x: 1, y: 1 }));
  act(() => screen.getByText("Fetch older records").click());
  expect(sync).toHaveBeenCalledWith({ addresses: [A], direction: "older" });
  expect(screen.queryByRole("menu")).toBeNull();
});

test("'Expand neighbors…' opens the expansion dialog for that node", async () => {
  const counterparties = vi.spyOn(api, "counterparties").mockResolvedValue({ items: [], total: 0 });
  vi.spyOn(api, "status").mockReturnValue(new Promise(() => {}));
  await mountWithData();
  act(() => props().onCxtNode(A, { x: 1, y: 1 }));
  act(() => screen.getByRole("menuitem", { name: "Expand neighbors…" }).click());
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.getByRole("dialog", { name: "Expand neighbors of " + A.slice(0, 6) + "…" + A.slice(-4) })).toBeInTheDocument();
  expect(counterparties).toHaveBeenCalledWith(A, { sort: "count_asc", limit: 1000, kind: "all" });
  expect(await screen.findByText("No stored counterparties yet. Sync this address first.")).toBeInTheDocument();
});

test("right-clicking an unselected node selects it, so Add label opens the editor for that node", async () => {
  vi.spyOn(api, "address").mockImplementation(async (a) => ({
    node: node(a, true), is_proxy: false, implementation: null, creator: null, creation_tx: null, coverage: [],
    first_seen: null, last_seen: null,
  }));
  useGraph.getState().addCenter(A);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AddressGraph />
      <DetailPanel />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(ids()).toContain(B));
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  act(() => props().onCxtNode(B, { x: 1, y: 1 }));
  expect(useGraph.getState().selection).toEqual({ kind: "node", address: B });
  act(() => screen.getByRole("menuitem", { name: /Add label/ }).click());
  expect(useUi.getState().labelEditorFor).toBe(B);
  expect(await screen.findByText(B)).toBeInTheDocument(); // the panel shows B…
  expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument(); // …with its label editor open
  expect(screen.queryByRole("button", { name: "Add label" })).toBeNull();
});

test("'Show hidden nodes (N)' appears while nodes are hidden and unhides them all in one undo step", async () => {
  await mountWithData();
  expect(screen.queryByRole("button", { name: /Show hidden nodes/ })).toBeNull();
  act(() => useGraph.getState().setHidden([B], true));
  act(() => useGraph.getState().setHidden(["0x" + "cc".repeat(20)], true)); // not on the canvas: not counted
  // It sits in the top-right canvas tools group, so the two never overlap.
  const tools = screen.getByRole("toolbar", { name: "Canvas tools" });
  act(() => within(tools).getByRole("button", { name: "Show hidden nodes (1)" }).click());
  expect(ids()).toEqual([A, B, `c:${A}>${B}`]);
  expect(screen.queryByRole("button", { name: /Show hidden nodes/ })).toBeNull();
  act(() => useGraph.getState().undo());
  expect(ids()).toEqual([A]);
});

test("a failing query after a success keeps the previous nodes and shows the error inline", async () => {
  await mountWithData();
  vi.mocked(api.graphEdges).mockRejectedValue(new ApiError("internal", 500, "boom"));
  act(() => useGraph.getState().setSort("recent"));
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(ids()).toEqual([A, B, `c:${A}>${B}`]);
});

describe("+N more proxy", () => {
  const withOmitted = (n: number): GraphResponseDto => ({ ...data, omitted: { [A]: n } });

  test("omitted neighbours show as a proxy node; clicking it raises the limit once, as one undoable step and one refetch", async () => {
    vi.mocked(api.graphEdges).mockResolvedValue(withOmitted(12));
    await mountWithData();
    await waitFor(() => expect(ids()).toContain(`more:${A}`));
    expect(props().elements.find((e) => e.data.id === `more:${A}`)?.data.label).toBe("+12 more · click +12");
    act(() => {
      useGraph.getState().select({ kind: "node", address: B });
      useBoxSelection.getState().set([A]);
    });
    useCanvasMetrics.getState().set({ width: 960, height: 576, visible: 20 });
    const before = useGraph.getState().limits[A]!;
    const calls = vi.mocked(api.graphEdges).mock.calls.length;
    act(() => props().onTapNode(`more:${A}`, { shift: false }));
    expect(useGraph.getState().limits[A]).toBe(before + 40); // capacity 60 - 20 visible, 1 center
    expect(useGraph.getState().selection).toEqual({ kind: "node", address: B });
    expect(useBoxSelection.getState().ids).toEqual([A]);
    await waitFor(() => expect(vi.mocked(api.graphEdges).mock.calls.length).toBe(calls + 1));
    act(() => useGraph.getState().undo());
    expect(useGraph.getState().limits[A]).toBe(before);
  });

  test("a double-click on the proxy reveals one batch; a later click reveals another", async () => {
    vi.mocked(api.graphEdges).mockResolvedValue(withOmitted(12));
    await mountWithData();
    useCanvasMetrics.getState().set({ width: 960, height: 576, visible: 20 });
    const before = useGraph.getState().limits[A]!;
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    act(() => props().onTapNode(`more:${A}`, { shift: false }));
    now.mockReturnValue(1100);
    act(() => props().onTapNode(`more:${A}`, { shift: false }));
    expect(useGraph.getState().limits[A]).toBe(before + 40);
    now.mockReturnValue(1500);
    // The raised limit re-derived the elements, so the visible count was re-measured; pin it again.
    useCanvasMetrics.getState().set({ visible: 20 });
    act(() => props().onTapNode(`more:${A}`, { shift: false }));
    expect(useGraph.getState().limits[A]).toBe(before + 80);
  });

  test("a center at the server's maximum limit shows no proxy", async () => {
    vi.mocked(api.graphEdges).mockResolvedValue(withOmitted(12));
    await mountWithData();
    expect(ids()).toContain(`more:${A}`);
    act(() => useGraph.getState().raiseLimit(A, 5000));
    await waitFor(() => expect(ids()).not.toContain(`more:${A}`));
  });

  test("taps on the proxy edge neither select nor expand a pair", async () => {
    vi.mocked(api.graphEdges).mockResolvedValue(withOmitted(12));
    await mountWithData();
    act(() => props().onTapEdge(A, `more:${A}`, "e2"));
    act(() => props().onDblTapEdge(A, `more:${A}`));
    expect(useGraph.getState().selection).toBeNull();
    expect(useGraph.getState().expandedPairs.size).toBe(0);
  });
});

const unid = (address: string, kind: NodeSummaryDto["kind"] = "unknown"): NodeSummaryDto => ({ ...node(address, true), kind, identified: false });

test("Identify all (N) counts unidentified non-wallet nodes on the canvas, skips hidden ones, and sends exactly those", async () => {
  const C = "0x" + "cc".repeat(20);
  const D = "0x" + "dd".repeat(20);
  const identify = vi.spyOn(api, "identify").mockResolvedValue({ queued: 2, jobs: [1] });
  vi.mocked(api.graphEdges).mockResolvedValue({ ...data, nodes: [node(A, true), unid(B), unid(C, "contract"), unid(D)] });
  useGraph.getState().addCenter(A);
  mount();
  await waitFor(() => expect(ids()).toContain(B));
  const btn = () => screen.queryByRole("button", { name: /^Identify all/ });
  expect(btn()).toHaveTextContent("Identify all (3)");
  expect(btn()).toHaveAttribute("title", "Look up the type and name of every unknown node");
  act(() => useGraph.getState().setHidden([D], true));
  expect(btn()).toHaveTextContent("Identify all (2)");
  await act(async () => btn()!.click());
  expect(identify).toHaveBeenCalledTimes(1);
  expect(identify.mock.calls[0]![0].addresses).toEqual([B, C]);
  expect(await screen.findByText("Queued 2 addresses for identification")).toBeInTheDocument();
});

test("Identify all is hidden when nothing needs identification", async () => {
  await mountWithData();
  expect(screen.queryByRole("button", { name: /^Identify all/ })).toBeNull();
});

test("batch bar: Identify type only when a selected node needs it, sending only those", async () => {
  const identify = vi.spyOn(api, "identify").mockResolvedValue({ queued: 1, jobs: [1] });
  vi.mocked(api.graphEdges).mockResolvedValue({ ...data, nodes: [node(A, true), unid(B)] });
  await mountWithData();
  await waitFor(() => expect(ids()).toContain(B));
  const bar = () => within(screen.getByRole("toolbar", { name: "Batch actions" }));
  act(() => props().onSelectionChange([A]));
  expect(bar().queryByRole("button", { name: "Identify type" })).toBeNull();
  act(() => props().onSelectionChange([A, B]));
  await act(async () => bar().getByRole("button", { name: "Identify type" }).click());
  expect(identify.mock.calls[0]![0].addresses).toEqual([B]);
  expect(useBoxSelection.getState().ids).toEqual([]);
});

test("the context menu offers 'Identify type' for an unidentified node", async () => {
  vi.mocked(api.graphEdges).mockResolvedValue({ ...data, nodes: [node(A, true), unid(B)] });
  await mountWithData();
  await waitFor(() => expect(ids()).toContain(B));
  act(() => props().onCxtNode(A, { x: 1, y: 1 }));
  expect(screen.queryByRole("menuitem", { name: "Identify type" })).toBeNull();
  act(() => props().onCxtNode(B, { x: 1, y: 1 }));
  expect(screen.getByRole("menuitem", { name: "Identify type" })).toBeInTheDocument();
});

test("tapping a node or an edge clears the graph tab's info stack; the background keeps it", async () => {
  await mountWithData();
  const doc = { kind: "doc", id: "erc-20" } as const;
  act(() => useInfo.getState().open("graph", doc));
  act(() => props().onTapBackground?.());
  expect(useInfo.getState().stacks["graph"]).toEqual([doc]);
  act(() => props().onTapNode(B, { shift: false }));
  expect(useInfo.getState().stacks["graph"]).toEqual([]);
  act(() => useInfo.getState().open("graph", doc));
  act(() => props().onTapEdge(A, B, "e1"));
  expect(useInfo.getState().stacks["graph"]).toEqual([]);
});

describe("a frozen (snapshot) graph", () => {
  const SNAP = {
    exported_at: "2026-10-01T12:00:00Z",
    includes: { labels: false, notes: false },
    data,
  };
  const CONFIRM = "This view is a snapshot from a file. Refresh it from the chain first?";

  function mountFrozen(snap = SNAP) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      useGraph.getState().setCenters([A]);
      useGraph.getState().freeze(snap);
    });
    const r = render(
      <QueryClientProvider client={qc}>
        <GraphSnapshotBanner />
        <AddressGraph />
        <LiveConfirm />
        <Toasts />
      </QueryClientProvider>,
    );
    act(() => props().onReady?.(fakeCy().cy));
    return r;
  }

  let address: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    registerSnapshotEffects();
    vi.spyOn(api, "nodes").mockResolvedValue([]);
    address = vi.spyOn(api, "address").mockResolvedValue({} as never);
  });
  afterEach(() => setUnfreezeHandler(null));

  test("draws the file's data with no graph request, under a banner", () => {
    mountFrozen();
    expect(ids()).toEqual(expect.arrayContaining([A, B]));
    expect(api.graphEdges).not.toHaveBeenCalled();
    expect(screen.getByText(/^Snapshot from a file · exported /)).toBeInTheDocument();
  });

  test("a graph-changing action asks first: cancel keeps the snapshot, Refresh reloads and then runs it", async () => {
    mountFrozen();
    act(() => props().onDblTapEdge(A, B));
    const dialog = screen.getByRole("dialog", { name: "Refresh from chain" });
    expect(within(dialog).getByText(CONFIRM)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useGraph.getState().frozen).not.toBeNull();
    expect(useGraph.getState().expandedPairs.size).toBe(0);
    expect(api.graphEdges).not.toHaveBeenCalled();

    act(() => props().onDblTapEdge(A, B));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Refresh from chain" }));
    expect(useGraph.getState().frozen).toBeNull();
    expect(useGraph.getState().expandedPairs.has(pairKey(A, B))).toBe(true);
    await waitFor(() => expect(api.graphEdges).toHaveBeenCalled());
    // The centers get the request the app sends when a center is added (it syncs those not yet synced).
    expect(address).toHaveBeenCalledWith(A, { sync: "auto" });
    expect(screen.queryByText(/^Snapshot from a file/)).toBeNull();
  });

  test("syncing a node and opening the expansion dialog wait for the refresh", async () => {
    const sync = vi.spyOn(api, "sync").mockResolvedValue({ jobs: [] } as never);
    mountFrozen();
    act(() => props().onDblTapNode(B));
    expect(sync).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));

    act(() => props().onCxtNode(A, { x: 1, y: 1 }));
    act(() => screen.getByRole("menuitem", { name: "Expand neighbors…" }).click());
    expect(screen.queryByRole("dialog", { name: /Expand neighbors/ })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Refresh from chain" })).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(sync).not.toHaveBeenCalled();
  });

  test("browsing a contract's interactions waits for the refresh", () => {
    const sync = vi.spyOn(api, "sync").mockResolvedValue({ jobs: [] } as never);
    const counterparties = vi.spyOn(api, "counterparties");
    mountFrozen({ ...SNAP, data: { ...data, nodes: [{ ...node(A, true), kind: "contract" }, node(B, false)] } });
    act(() => props().onCxtNode(A, { x: 1, y: 1 }));
    act(() => screen.getByRole("menuitem", { name: "Browse interactions…" }).click());
    expect(screen.queryByRole("dialog", { name: /^Interactions of/ })).toBeNull();
    const dialog = screen.getByRole("dialog", { name: "Refresh from chain" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useGraph.getState().frozen).not.toBeNull();
    expect(sync).not.toHaveBeenCalled();
    expect(counterparties).not.toHaveBeenCalled();
  });

  test("the banner's Refresh from chain goes live at once", async () => {
    mountFrozen();
    fireEvent.click(screen.getByRole("button", { name: "Refresh from chain" }));
    expect(useGraph.getState().frozen).toBeNull();
    await waitFor(() => expect(api.graphEdges).toHaveBeenCalled());
    expect(address).toHaveBeenCalledWith(A, { sync: "auto" });
  });

  test("hide, pin and drag work on the snapshot", () => {
    mountFrozen();
    act(() => props().onDragEnd({ [A]: { x: 5, y: 6 } }));
    act(() => useGraph.getState().setPinned([A], true));
    act(() => useGraph.getState().setHidden([B], true));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useGraph.getState().frozen).not.toBeNull();
    expect(ids()).not.toContain(B);
  });
});
