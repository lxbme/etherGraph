import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../../api/endpoints";
import type { CounterpartyDto } from "../../api/generated/CounterpartyDto";
import type { NodeSummaryDto } from "../../api/generated/NodeSummaryDto";
import type { ProbeResponseDto } from "../../api/generated/ProbeResponseDto";
import type { StatusDto } from "../../api/generated/StatusDto";
import { useCanvasMetrics } from "../../graph/canvasMetrics";
import { useGraph } from "../../graph/store";
import { graphQueryKey } from "../../graph/useGraphData";
import { useQuota } from "../../shell/statusStore";
import { Toasts } from "../../shell/Toasts";
import { ExpandDialog } from "./ExpandDialog";

const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const ME = addr(999);
const node = (n: number, o: Partial<NodeSummaryDto> = {}): NodeSummaryDto => ({
  address: addr(n), kind: "unknown", display_name: null, ens: null, contract_name: null, labels: [],
  partial: false, syncing: false, synced: false, hot: false, nonce: null, balance: null, ...o,
});
/** Counterparty n: n transfers with ME (so count_asc order is 1, 2, 3, …). */
const cp = (n: number, o: Partial<NodeSummaryDto> = {}): CounterpartyDto => ({ node: node(n, o), count: n, last_ts: "", assets: [] });
const status = (o: Partial<StatusDto> = {}): StatusDto => ({
  quota_used: 100, quota_limit: 5000, paused: false, reset_at: "", queue_len: 0, rate: 2.5, jobs_active: 0,
  queued_calls: 0, calls: 0, retries: 0, errors: {}, degraded: null, ...o,
});

/** Probe answers: nonce = n unless overridden; kind eoa. */
let nonces: Record<string, number> = {};
let probeCalls = 2;
const probeAnswer = (addresses: string[]): ProbeResponseDto => ({
  calls: probeCalls,
  items: addresses.map((a) => ({
    address: a, kind: "eoa" as const, nonce: nonces[a] ?? parseInt(a, 16), balance: "1500000000000000000",
    local_transfers: 0, synced: false, partial: false, probed_at: "",
  })),
});

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

function mockCounterparties(items: CounterpartyDto[]) {
  return vi.spyOn(api, "counterparties").mockResolvedValue({ items, total: items.length });
}

function mount(props: { preset?: string[]; onClose?: () => void; qc?: QueryClient } = {}) {
  const qc = props.qc ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = props.onClose ?? vi.fn();
  const r = render(
    <QueryClientProvider client={qc}>
      <ExpandDialog node={node(999, { kind: "eoa" })} preset={props.preset} onClose={onClose} />
      <Toasts />
    </QueryClientProvider>,
  );
  return { ...r, onClose, qc };
}

const box = (n: number) => screen.getByRole("checkbox", { name: addr(n) }) as HTMLInputElement;
const checkedAddrs = () =>
  (screen.queryAllByRole("checkbox") as HTMLInputElement[]).filter((b) => b.checked).map((b) => b.getAttribute("aria-label"));
const expandBtn = () => screen.getByRole("button", { name: "Expand" });

beforeEach(() => {
  useGraph.getState().reset();
  nonces = {};
  probeCalls = 2;
  // 960 x 576 at 96 px per node: capacity 60, nothing shown → node budget 60 (10 new centers at 1 + K_MIN each).
  useCanvasMetrics.setState({ width: 960, height: 576, visible: 0 });
  useQuota.setState({ quota: { used: 100, limit: 5000, paused: false, reset_at: "" } });
  vi.spyOn(api, "status").mockResolvedValue(status());
  vi.spyOn(api, "probe").mockImplementation(async (r) => probeAnswer(r.addresses));
});
afterEach(() => vi.restoreAllMocks());

test("candidates come from counterparties (centers excluded); the first probe asks for 20 addresses interactively", async () => {
  useGraph.getState().addCenter(addr(31));
  const counterparties = mockCounterparties([...range(1, 30).map((n) => cp(n)), cp(31)]);
  mount();
  await waitFor(() => expect(api.probe).toHaveBeenCalled());
  expect(counterparties).toHaveBeenCalledWith(ME, { sort: "count_asc", limit: 1000, kind: "all" });
  expect(vi.mocked(api.probe).mock.calls[0]![0]).toEqual({ addresses: range(1, 20).map(addr), priority: "interactive" });
  expect(await screen.findByText("Probed 20 / 30 · probe cost 2 calls")).toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: addr(31) })).toBeNull();
  // The 10 lightest fill the node budget long before the 20 probed run out: no second chunk.
  await new Promise((r) => setTimeout(r, 20));
  expect(api.probe).toHaveBeenCalledTimes(1);
});

test("the lightest non-heavy wallets are checked by default; checking a Heavy one warns but does not block", async () => {
  nonces[addr(5)] = 100_000; // a Tukey outlier among nonces 1…30
  mockCounterparties(range(1, 30).map((n) => cp(n)));
  mount();
  await screen.findByText("Probed 20 / 30 · probe cost 2 calls");
  const heavyRow = box(5).closest("tr")!;
  expect(within(heavyRow).getByText("Heavy")).toBeInTheDocument();
  await waitFor(() => expect(checkedAddrs()).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 10, 11].map(addr)));
  const nodes = screen.getByRole("meter", { name: "Nodes" });
  expect(nodes).toHaveAttribute("aria-valuenow", "60");
  expect(nodes).toHaveAttribute("aria-valuemax", "60");
  await waitFor(() => expect(screen.getByRole("meter", { name: "Calls" })).toHaveAttribute("aria-valuemax", "225"));
  expect(screen.getByRole("meter", { name: "Calls" })).toHaveAttribute("aria-valuenow", "60");
  expect(screen.queryByText(/over the canvas budget/)).toBeNull();

  fireEvent.click(box(5));
  expect(box(5).checked).toBe(true);
  expect(screen.getByText("6 nodes over the canvas budget")).toBeInTheDocument();
  expect(expandBtn()).toBeEnabled();
  // Rows show the probed facts.
  expect(within(heavyRow).getByText("100,000")).toBeInTheDocument();
  expect(within(heavyRow).getByText("1.500000 ETH")).toBeInTheDocument();
});

test("unprobed wallets show an estimated weight", async () => {
  mockCounterparties(range(1, 25).map((n) => cp(n)));
  mount();
  await screen.findByText("Probed 20 / 25 · probe cost 2 calls");
  expect(within(box(25).closest("tr")!).getByText("est.")).toBeInTheDocument();
  expect(within(box(1).closest("tr")!).queryByText("est.")).toBeNull();
});

test("contracts are grouped, collapsed, never probed and never checked", async () => {
  mockCounterparties([cp(1), cp(2), cp(3, { kind: "contract" }), cp(4, { kind: "contract" }), cp(5)]);
  mount();
  await screen.findByText("Probed 3 / 3 · probe cost 2 calls");
  expect(vi.mocked(api.probe).mock.calls[0]![0].addresses).toEqual([addr(1), addr(2), addr(5)]);
  const toggle = screen.getByRole("button", { name: /Contracts \(2\)/ });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(screen.getByText("Contracts are never expanded automatically. Browse a contract's interactions to pick its counterparties.")).toBeInTheDocument();
  expect(screen.queryByRole("checkbox", { name: addr(3) })).toBeNull();
  fireEvent.click(toggle);
  expect(box(3).checked).toBe(false);
  expect(box(4).checked).toBe(false);
  expect(checkedAddrs()).toEqual([addr(1), addr(2), addr(5)]);
});

test("only contracts: Expand is disabled with an explanation", async () => {
  mockCounterparties([cp(1, { kind: "contract" }), cp(2, { kind: "contract" })]);
  mount();
  expect(await screen.findByText("Nothing is checked by default: every candidate is a contract or heavy.")).toBeInTheDocument();
  expect(expandBtn()).toBeDisabled();
  expect(api.probe).not.toHaveBeenCalled();
});

test("no counterparties: an empty-state message and a disabled Expand", async () => {
  mockCounterparties([]);
  mount();
  expect(await screen.findByText("No stored counterparties yet. Sync this address first.")).toBeInTheDocument();
  expect(expandBtn()).toBeDisabled();
});

test("closing mid-probe sends no further chunk and logs no React warning", async () => {
  useCanvasMetrics.setState({ width: 4000, height: 4000 }); // room for everyone: the next chunk would be wanted
  let release: (v: ProbeResponseDto) => void = () => {};
  vi.mocked(api.probe).mockImplementation(() => new Promise((r) => { release = r; }));
  const err = vi.spyOn(console, "error");
  mockCounterparties(range(1, 30).map((n) => cp(n)));
  const { unmount } = mount();
  await waitFor(() => expect(api.probe).toHaveBeenCalledTimes(1));
  unmount();
  await act(async () => release(probeAnswer(range(1, 20).map(addr))));
  await new Promise((r) => setTimeout(r, 20));
  expect(api.probe).toHaveBeenCalledTimes(1);
  expect(err).not.toHaveBeenCalled();
});

test("with room left after the first chunk, the next chunk is probed in the background", async () => {
  useCanvasMetrics.setState({ width: 4000, height: 4000 });
  mockCounterparties(range(1, 30).map((n) => cp(n)));
  mount();
  await screen.findByText("Probed 30 / 30 · probe cost 4 calls");
  expect(vi.mocked(api.probe).mock.calls[1]![0]).toEqual({ addresses: range(21, 30).map(addr), priority: "background" });
});

test("confirming syncs shallow under a new batch, expands, and offers Undo until the next history step", async () => {
  const sync = vi.spyOn(api, "sync").mockResolvedValue({ estimated_calls: null, estimated_seconds: null, per_address: null, jobs: [1] });
  mockCounterparties(range(1, 3).map((n) => cp(n)));
  const { onClose } = mount();
  await waitFor(() => expect(checkedAddrs()).toHaveLength(3));
  await act(async () => fireEvent.click(expandBtn()));
  expect(sync).toHaveBeenCalledTimes(1);
  const req = sync.mock.calls[0]![0];
  expect(req).toEqual({ addresses: [addr(1), addr(2), addr(3)], batch: expect.any(String), depth: "shallow" });
  const g = useGraph.getState();
  expect(g._past.at(-1)?.effect).toEqual({ kind: "expand", batch: req.batch, addresses: [addr(1), addr(2), addr(3)] });
  expect(g.centers).toEqual([addr(1), addr(2), addr(3)]);
  // perCenterBatch(60, 3, 3) = 19
  expect(g.limits[addr(1)]).toBe(19);
  expect(onClose).toHaveBeenCalled();
  expect(await screen.findByText("Expanded 3 addresses")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  act(() => useGraph.getState().setPinned([addr(1)], true));
  expect(screen.queryByText("Expanded 3 addresses")).toBeNull();
});

test("the toast's Undo undoes the expansion", async () => {
  vi.spyOn(api, "sync").mockResolvedValue({ estimated_calls: null, estimated_seconds: null, per_address: null, jobs: [1] });
  mockCounterparties([cp(1)]);
  mount();
  await waitFor(() => expect(checkedAddrs()).toHaveLength(1));
  await act(async () => fireEvent.click(expandBtn()));
  fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
  expect(useGraph.getState().centers).toEqual([]);
  expect(screen.queryByText("Expanded 1 address")).toBeNull();
});

test("a failed sync keeps the dialog open, expands nothing and cancels the batch", async () => {
  const { ApiError } = await import("../../api/errors");
  vi.spyOn(api, "sync").mockRejectedValue(new ApiError("upstream_error", 502, "boom"));
  const cancel = vi.spyOn(api, "cancelBatch").mockResolvedValue({ cancelled: [] });
  mockCounterparties([cp(1)]);
  const { onClose } = mount();
  await waitFor(() => expect(checkedAddrs()).toHaveLength(1));
  await act(async () => fireEvent.click(expandBtn()));
  expect(useGraph.getState().centers).toEqual([]);
  expect(onClose).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledWith(vi.mocked(api.sync).mock.calls[0]![0].batch);
  expect(expandBtn()).toBeEnabled();
});

test("more than 50 checked addresses are synced in requests of at most 50 under one batch", async () => {
  useCanvasMetrics.setState({ width: 4000, height: 4000 });
  vi.mocked(api.status).mockResolvedValue(status({ rate: 10 })); // call budget 900: room for 60 x 6
  const sync = vi.spyOn(api, "sync").mockResolvedValue({ estimated_calls: null, estimated_seconds: null, per_address: null, jobs: [] });
  mockCounterparties(range(1, 60).map((n) => cp(n)));
  mount();
  await waitFor(() => expect(checkedAddrs()).toHaveLength(60));
  await act(async () => fireEvent.click(expandBtn()));
  expect(sync.mock.calls.map(([r]) => r.addresses.length)).toEqual([50, 10]);
  expect(new Set(sync.mock.calls.map(([r]) => r.batch)).size).toBe(1);
  expect(useGraph.getState().centers).toHaveLength(60);
});

test("preset candidates skip counterparties, resolve names from the cached graph and start all checked", async () => {
  const counterparties = mockCounterparties([]);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useGraph.getState().addCenter(ME);
  qc.setQueryData(graphQueryKey(useGraph.getState()), {
    nodes: [node(999), node(7, { display_name: "alice.eth" }), node(9, { kind: "contract" })], edges: [], omitted: {}, coverage: {},
  });
  mount({ qc, preset: [addr(7), addr(8), addr(9)] });
  expect(await screen.findByText("alice.eth")).toBeInTheDocument();
  expect(counterparties).not.toHaveBeenCalled();
  expect(screen.getByRole("checkbox", { name: "alice.eth" })).toBeChecked();
  expect(box(8)).toBeChecked();
  // Hand-picked contracts are shown (group open) and checked too.
  expect(screen.getByRole("button", { name: /Contracts \(1\)/ })).toHaveAttribute("aria-expanded", "true");
  expect(box(9)).toBeChecked();
  expect(screen.getByRole("meter", { name: "Nodes" })).toHaveAttribute("aria-valuenow", "16"); // 7 and 9 already on the canvas: 5 + 5 + 6
});

test("a busy queue zeroes the call budget and says so", async () => {
  vi.mocked(api.status).mockResolvedValue(status({ queued_calls: 300 }));
  mockCounterparties(range(1, 3).map((n) => cp(n)));
  mount();
  expect(await screen.findByText("Queue is busy — new work will wait behind 300 calls.")).toBeInTheDocument();
  expect(screen.getByRole("meter", { name: "Calls" })).toHaveAttribute("aria-valuemax", "0");
});

test("probe cost plus checked calls over today's remaining quota warns", async () => {
  probeCalls = 5;
  vi.mocked(api.status).mockResolvedValue(status({ quota_used: 4990 }));
  mockCounterparties(range(1, 3).map((n) => cp(n)));
  mount();
  // Call budget = remaining quota 10: one wallet (6 calls) fits; 6 + 5 probe calls > 10.
  expect(await screen.findByText("Probe and checked calls exceed today's remaining quota")).toBeInTheDocument();
  expect(expandBtn()).toBeEnabled();
});

test("Escape and the backdrop close; shortcuts are suppressed while open", async () => {
  mockCounterparties([cp(1)]);
  const { useShortcuts } = await import("../../graph/useShortcuts");
  function Host() { useShortcuts(() => undefined); return null; }
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Host />
      <ExpandDialog node={node(999)} onClose={onClose} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(checkedAddrs()).toHaveLength(1));
  act(() => useGraph.getState().setPinned([addr(5)], true));
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
  expect(useGraph.getState().ui[addr(5)]?.pinned).toBe(true);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});
