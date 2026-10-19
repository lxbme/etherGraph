import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";
import type { EdgeDto } from "../../api/generated/EdgeDto";
import type { GraphResponseDto } from "../../api/generated/GraphResponseDto";
import type { NodeSummaryDto } from "../../api/generated/NodeSummaryDto";
import { useCanvasMetrics } from "../../graph/canvasMetrics";
import { useGraph } from "../../graph/store";
import { useQuota } from "../../shell/statusStore";
import { clearToasts, Toasts } from "../../shell/Toasts";
import { ExpandSelfDialog } from "./ExpandSelfDialog";
import { expandSelf } from "./expandSelf";

const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const node = (n: number, o: Partial<NodeSummaryDto> = {}): NodeSummaryDto => ({
  address: addr(n), kind: "eoa", display_name: null, ens: null, contract_name: null, labels: [],
  partial: false, syncing: false, synced: true, hot: false, identified: true, nonce: null, balance: null, ...o,
});
const edge = (from: number, to: number) => ({
  from: addr(from), to: addr(to), asset: null, asset_kind: "native", count: 1, sum: "1", first_ts: "", last_ts: "",
  decimals: 18, symbol: "ETH", trust: "ok",
}) as unknown as EdgeDto;

const C0 = 1;
const T = 2;
const A = 3;
/** The canvas: center C0 with neighbours T and A. */
const data: GraphResponseDto = { nodes: [node(C0), node(T), node(A)], edges: [edge(C0, T), edge(C0, A)], omitted: {}, coverage: {} };

/** Dry-run neighbours per center: A (on the canvas) plus `fresh` new ones (center * 100 + i); omitted 7. */
let fresh: Record<string, number> = {};
function answer(addresses: string[]): GraphResponseDto {
  const nodes: NodeSummaryDto[] = [node(A)];
  const edges: EdgeDto[] = [];
  for (const a of addresses) {
    const c = parseInt(a, 16);
    nodes.push(node(c));
    edges.push(edge(c, A));
    for (let i = 0; i < (fresh[a] ?? 2); i++) {
      nodes.push(node(c * 100 + i));
      edges.push(edge(c, c * 100 + i));
    }
  }
  return { nodes, edges, omitted: Object.fromEntries(addresses.map((a) => [a, 7])), coverage: {} };
}

/**
 * `data` with the targets' summaries in place of its own: the dialog reads the live ones from the result it is
 * given. Targets the canvas lacks stay out (the dialog falls back to the summaries it was opened with).
 */
const withTargets = (targets: NodeSummaryDto[]): GraphResponseDto => {
  const own = new Map(targets.map((n) => [n.address, n]));
  return { ...data, nodes: data.nodes.map((n) => own.get(n.address) ?? n) };
};

function mount(targets: NodeSummaryDto[], canvas: GraphResponseDto = withTargets(targets)) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const view = (d: GraphResponseDto) => (
    <QueryClientProvider client={qc}>
      <ExpandSelfDialog targets={targets} data={d} onClose={onClose} />
      <Toasts />
    </QueryClientProvider>
  );
  const { rerender } = render(view(canvas));
  return { onClose, setData: (d: GraphResponseDto) => rerender(view(d)) };
}

const expandBtn = () => screen.getByRole("button", { name: "Expand" });
const centers = () => useGraph.getState().centers;

beforeEach(() => {
  clearToasts();
  fresh = {};
  useGraph.getState().reset();
  useGraph.getState().addCenter(addr(C0));
  // 960 x 576 at 96 px per node: capacity 60; 3 shown → first batch for one center = 57 - 1 = 56.
  useCanvasMetrics.setState({ width: 960, height: 576, visible: 3 });
  useQuota.setState({ quota: { used: 100, limit: 5000, paused: false, server_paused: false, reset_at: "" } });
  vi.spyOn(api, "graphEdges").mockImplementation(async (req) => answer(req.addresses));
  vi.spyOn(api, "sync").mockResolvedValue(undefined as never);
  vi.spyOn(api, "cancelBatch").mockResolvedValue({ cancelled: [] } as never);
});
afterEach(() => vi.restoreAllMocks());

test("a synced target: exact headline, its counterparties, no calls, the canvas after", async () => {
  mount([node(T, { display_name: "alice.eth" })]);
  expect(screen.getByRole("dialog", { name: "Expand alice.eth" })).toBeInTheDocument();
  expect(screen.getByText("Estimating…")).toBeInTheDocument();
  expect(expandBtn()).toBeEnabled();
  expect(await screen.findByText("About 2 new nodes")).toBeInTheDocument();
  expect(screen.getByLabelText("Show at most per address")).toHaveValue(56);
  expect(vi.mocked(api.graphEdges).mock.calls[0]![0]).toMatchObject({ addresses: [addr(T)], limits: { [addr(T)]: 56 }, dry_run: true });
  expect(screen.getByText("10 counterparties")).toBeInTheDocument();
  expect(screen.getByText("1 already on canvas")).toBeInTheDocument();
  expect(screen.getByText("2 shown now")).toBeInTheDocument();
  expect(screen.getByText("7 more folded into “+N more”")).toBeInTheDocument();
  expect(screen.getByText("1 of its counterparties are already on the canvas and use up this batch")).toBeInTheDocument();
  expect(screen.getByText("No calls needed")).toBeInTheDocument();
  expect(screen.getByText("Canvas after: about 5 / 60 nodes")).toBeInTheDocument();
  expect(screen.queryByText(/not synced yet/)).toBeNull();
  expect(screen.queryByText(/Over the canvas capacity/)).toBeNull();
});

test("an unsynced target: a range, the sync calls; Expand syncs only it (shallow) and centers it with k; one undo removes it", async () => {
  fresh[addr(T)] = 3;
  const { onClose } = mount([node(T, { synced: false, nonce: 42 })]);
  expect(await screen.findByText("About 3–55 new nodes")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Show at most per address"), { target: { value: "9" } });
  expect(await screen.findByText("About 3–8 new nodes")).toBeInTheDocument();
  expect(screen.getByText("At least 3, up to 8 after the sync")).toBeInTheDocument();
  expect(screen.getByText("42 transactions sent")).toBeInTheDocument();
  expect(screen.getByText("1 address is not synced yet; the exact number is known after the sync")).toBeInTheDocument();
  expect(screen.getByText("1 address is synced first, about 6 calls")).toBeInTheDocument();
  expect(screen.getByText("4,900 calls left today")).toBeInTheDocument();
  expect(screen.queryByText("The calls needed exceed today's remaining quota")).toBeNull();

  fireEvent.click(expandBtn());
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(api.sync).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api.sync).mock.calls[0]![0]).toEqual({ addresses: [addr(T)], batch: expect.any(String), depth: "shallow" });
  expect(centers()).toEqual([addr(C0), addr(T)]);
  expect(useGraph.getState().limits[addr(T)]).toBe(9);

  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  expect(centers()).toEqual([addr(C0)]);
});

test("a rejected sync cancels the batch, toasts the error and leaves the centers alone", async () => {
  const err = new ApiError("upstream_error", 502, "boom");
  vi.mocked(api.sync).mockRejectedValue(err);
  const { onClose } = mount([node(T, { synced: false })]);
  fireEvent.click(expandBtn());
  await waitFor(() => expect(api.cancelBatch).toHaveBeenCalledTimes(1));
  expect(api.cancelBatch).toHaveBeenCalledWith(vi.mocked(api.sync).mock.calls[0]![0].batch);
  expect(await screen.findByText(messageFor(err))).toBeInTheDocument();
  expect(centers()).toEqual([addr(C0)]);
  expect(onClose).not.toHaveBeenCalled();
  expect(expandBtn()).toBeEnabled();
});

test("many targets: a row each, already-syncing targets are not synced again", async () => {
  const syncing = node(6, { synced: false, syncing: true });
  const { onClose } = mount([node(5, { ens: "bob.eth" }), syncing]);
  expect(screen.getByRole("dialog", { name: "Expand 2 addresses as centers" })).toBeInTheDocument();
  // Default per-center batch for 2: (57 - 2) / 2 = 27. Fresh: 2 + 2; both targets are new themselves.
  expect(await screen.findByText("About 6–30 new nodes")).toBeInTheDocument();
  const rows = within(screen.getByRole("table")).getAllByRole("row");
  expect(rows).toHaveLength(2);
  expect(within(rows[0]!).getByText("bob.eth")).toBeInTheDocument();
  expect(within(rows[0]!).getByText(/2 shown now/)).toBeInTheDocument();
  expect(within(rows[1]!).getByText(/At least 2, up to 26 after the sync/)).toBeInTheDocument();
  // The facts wrap inside the dialog: their cell opts out of the table's nowrap.
  for (const r of rows) expect(within(r).getByText(/shown now|after the sync/)).toHaveClass("expand-self__facts-cell");
  expect(screen.getByText("No calls needed")).toBeInTheDocument();
  fireEvent.click(expandBtn());
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(api.sync).not.toHaveBeenCalled();
  expect(centers()).toEqual([addr(C0), addr(5), addr(6)]);
});

test("over the quota and the canvas: warnings, Expand stays enabled", async () => {
  useQuota.setState({ quota: { used: 4998, limit: 5000, paused: false, server_paused: false, reset_at: "" } });
  useCanvasMetrics.setState({ width: 384, height: 192, visible: 7 }); // capacity 8
  mount([node(T, { synced: false })]);
  // First batch on a full canvas: K_FLOOR 3, so at most 3 - 1 = 2 fresh.
  expect(await screen.findByText("About 2 new nodes")).toBeInTheDocument();
  expect(screen.getByText("2 calls left today")).toBeInTheDocument();
  expect(screen.getByText("The calls needed exceed today's remaining quota")).toBeInTheDocument();
  expect(screen.getByText("Over the canvas capacity: the graph may get crowded")).toBeInTheDocument();
  expect(expandBtn()).toBeEnabled();
});

test("a snapshot asks to go live first and sends nothing", async () => {
  useGraph.setState({ frozen: { data } as never });
  const { onClose } = mount([node(T, { synced: false })]);
  fireEvent.click(expandBtn());
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(useGraph.getState().pendingLive).toBeTruthy();
  expect(api.sync).not.toHaveBeenCalled();
  expect(api.graphEdges).not.toHaveBeenCalled();
  expect(centers()).toEqual([addr(C0)]);
});

test("Escape and a backdrop click close it", async () => {
  const { onClose } = mount([node(T)]);
  await screen.findByText("About 2 new nodes");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("dialog").parentElement!);
  expect(onClose).toHaveBeenCalledTimes(2);
});

test("more than 50 centers after the expansion: a warning, Expand disabled, and expandSelf refuses without syncing", async () => {
  // 48 centers (C0 and 47 more) + 3 targets = 51: the live graph request would be rejected.
  useGraph.getState().setCenters([addr(C0), ...Array.from({ length: 47 }, (_, i) => addr(1000 + i))]);
  const targets = [node(T, { synced: false }), node(5, { synced: false }), node(6, { synced: false })];
  const { onClose } = mount(targets);
  expect(
    screen.getByText("Centers would exceed 50 (now 51); the server shows at most 50 centers at once. Select fewer addresses or remove some centers first."),
  ).toBeInTheDocument();
  expect(expandBtn()).toBeDisabled();
  fireEvent.click(expandBtn());
  expect(await expandSelf(targets, 5)).toBe(false);
  expect(api.sync).not.toHaveBeenCalled();
  expect(centers()).toHaveLength(48);
  expect(onClose).not.toHaveBeenCalled();
});

test("a target that finishes syncing while the dialog is open: the live result's flags win (exact headline, no sync)", async () => {
  const unsynced: GraphResponseDto = { ...data, nodes: [node(C0), node(T, { synced: false }), node(A)] };
  const { onClose, setData } = mount([node(T, { synced: false })], unsynced);
  expect(await screen.findByText("About 2–55 new nodes")).toBeInTheDocument();
  expect(screen.getByText("1 address is synced first, about 6 calls")).toBeInTheDocument();
  setData(data); // the refetch after the sync: T is synced now
  expect(await screen.findByText("About 2 new nodes")).toBeInTheDocument();
  expect(screen.getByText("No calls needed")).toBeInTheDocument();
  fireEvent.click(expandBtn());
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(api.sync).not.toHaveBeenCalled();
  expect(centers()).toEqual([addr(C0), addr(T)]);
});
