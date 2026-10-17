import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import type cytoscape from "cytoscape";
import { api } from "../api/endpoints";
import { ApiError } from "../api/errors";
import type { EdgeDto } from "../api/generated/EdgeDto";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { useBoxSelection } from "../graph/boxSelection";
import type { CytoscapeViewProps } from "../graph/CytoscapeView";
import { pairKey, useGraph } from "../graph/store";
import { Toasts } from "../shell/Toasts";
import { DetailPanel } from "../panels/DetailPanel";
import { useUi } from "../panels/uiStore";
import { AddressGraph } from "./AddressGraph";

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
  partial: false, syncing: false, synced, hot: false,
});
const edge: EdgeDto = {
  from: A, to: B, asset: null, asset_kind: "native", count: 3, sum: "1000", first_ts: "", last_ts: "",
  decimals: 18, symbol: "ETH",
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

test("hidden nodes and their edges are left out", async () => {
  await mountWithData();
  act(() => useGraph.getState().setHidden([B], true));
  expect(ids()).toEqual([A]);
});

test("tapping a node or an edge selects it and clears native selection", async () => {
  const { f } = await mountWithData();
  act(() => props().onTapNode(B, { shift: false }));
  expect(useGraph.getState().selection).toEqual({ kind: "node", address: B });
  expect(f.$).toHaveBeenCalledWith(":selected");
  expect(f.unselect).toHaveBeenCalled();
  expect(props().elements.find((e) => e.data.id === B)?.classes).toContain("selected");

  f.unselect.mockClear();
  act(() => props().onTapEdge(A, B));
  expect(useGraph.getState().selection).toEqual({ kind: "pair", a: A, b: B });
  expect(f.unselect).toHaveBeenCalled();
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

test("box selection is stored and native selection cleared; empty boxes are ignored", async () => {
  const { f } = await mountWithData();
  act(() => props().onBoxSelect([A, B]));
  expect(useBoxSelection.getState().ids).toEqual([A, B]);
  expect(f.unselect).toHaveBeenCalled();
  act(() => props().onBoxSelect([]));
  expect(useBoxSelection.getState().ids).toEqual([A, B]);
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

test("batch bar appears for 2+ box-selected nodes; background/node tap clears it", async () => {
  await mountWithData();
  act(() => props().onBoxSelect([A, B]));
  expect(screen.getByText("2 nodes selected")).toBeInTheDocument();
  act(() => props().onTapBackground?.());
  expect(screen.queryByText("2 nodes selected")).toBeNull();
  act(() => props().onBoxSelect([A, B]));
  act(() => props().onTapNode(A, { shift: false }));
  expect(useBoxSelection.getState().ids).toEqual([]);
  act(() => props().onBoxSelect([A, B]));
  act(() => screen.getByRole("button", { name: "Pin" }).click());
  expect(useGraph.getState().ui[A]?.pinned).toBe(true);
  expect(useGraph.getState().ui[B]?.pinned).toBe(true);
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

test("top-K item opens the dialog with exactly the top 10 pre-checked; hidden neighbours are excluded", async () => {
  const x = (i: number) => "0x" + i.toString(16).padStart(40, "1");
  const many = Array.from({ length: 12 }, (_, i) => x(i + 1));
  vi.spyOn(api, "sync").mockResolvedValue({ estimated_calls: 0, estimated_seconds: 0, jobs: null, per_address: {} });
  vi.spyOn(api, "status").mockResolvedValue({ rate: 2 } as never);
  vi.spyOn(api, "graphEdges").mockResolvedValue({
    ...data, nodes: [node(A, true), ...many.map((m) => node(m, true))],
    edges: many.map((m, i) => ({ ...edge, to: m, count: i + 1 })),
  });
  await mountWithData();
  act(() => useGraph.getState().setHidden([many[11]!], true)); // highest count, hidden
  act(() => props().onCxtNode(A, { x: 1, y: 1 }));
  act(() => screen.getByText(/Top 10/).click());
  const boxes = (await screen.findAllByRole("checkbox")) as HTMLInputElement[];
  expect(boxes).toHaveLength(11);
  expect(boxes.filter((b) => b.checked)).toHaveLength(10);
  expect(boxes.filter((b) => !b.checked)).toHaveLength(1); // the lowest-count one
});

test("expanding a node with no neighbours toasts", async () => {
  vi.spyOn(api, "graphEdges").mockResolvedValue({ ...data, edges: [] });
  await mountWithData();
  act(() => props().onCxtNode(A, { x: 1, y: 1 }));
  act(() => screen.getByText("Select…").click());
  expect(await screen.findByText("No neighbors to expand")).toBeInTheDocument();
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
  act(() => screen.getByRole("button", { name: "Show hidden nodes (1)" }).click());
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
