import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../../api/endpoints";
import { ApiError, messageFor } from "../../api/errors";
import type { CounterpartyDto } from "../../api/generated/CounterpartyDto";
import type { NodeSummaryDto } from "../../api/generated/NodeSummaryDto";
import type { ProbeResponseDto } from "../../api/generated/ProbeResponseDto";
import type { StatusDto } from "../../api/generated/StatusDto";
import { useCanvasMetrics } from "../../graph/canvasMetrics";
import { useGraph } from "../../graph/store";
import { graphQueryKey } from "../../graph/useGraphData";
import { useJobProgress, useQuota } from "../../shell/statusStore";
import { clearToasts, Toasts } from "../../shell/Toasts";
import { ExpandDialog } from "./ExpandDialog";

const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const ME = addr(999);
const node = (n: number, o: Partial<NodeSummaryDto> = {}): NodeSummaryDto => ({
  address: addr(n), kind: "unknown", display_name: null, ens: null, contract_name: null, labels: [],
  partial: false, syncing: false, synced: false, hot: false, identified: true, nonce: null, balance: null, ...o,
});
/** Counterparty n: n transfers with ME (so count_asc order is 1, 2, 3, …). */
const cp = (n: number, o: Partial<NodeSummaryDto> = {}): CounterpartyDto => ({ node: node(n, o), count: n, last_ts: "", assets: [] });
const status = (o: Partial<StatusDto> = {}): StatusDto => ({
  quota_used: 100, quota_limit: 5000, paused: false, server_paused: false, reset_at: "", queue_len: 0, rate: 2.5, jobs_active: 0,
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

function mount(props: { preset?: string[]; onClose?: () => void; qc?: QueryClient; node?: Partial<NodeSummaryDto> } = {}) {
  const qc = props.qc ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = props.onClose ?? vi.fn();
  const r = render(
    <QueryClientProvider client={qc}>
      <ExpandDialog node={node(999, { kind: "eoa", synced: true, ...props.node })} preset={props.preset} onClose={onClose} />
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
  clearToasts();
  useGraph.getState().reset();
  nonces = {};
  probeCalls = 2;
  // 960 x 576 at 96 px per node: capacity 60, nothing shown → node budget 60 (10 new centers at 1 + K_MIN each).
  useCanvasMetrics.setState({ width: 960, height: 576, visible: 0 });
  useQuota.setState({ quota: { used: 100, limit: 5000, paused: false, server_paused: false, reset_at: "" } });
  vi.spyOn(api, "status").mockResolvedValue(status());
  vi.spyOn(api, "probe").mockImplementation(async (r) => probeAnswer(r.addresses));
});
afterEach(() => vi.restoreAllMocks());

test("candidates come from counterparties (centers excluded); chunk 1 is interactive, then exactly one extra chunk once the budget binds", async () => {
  useGraph.getState().addCenter(addr(61));
  const counterparties = mockCounterparties([...range(1, 60).map((n) => cp(n)), cp(61)]);
  mount();
  await waitFor(() => expect(api.probe).toHaveBeenCalled());
  expect(counterparties).toHaveBeenCalledWith(ME, { sort: "count_asc", limit: 1000, kind: "all" });
  expect(vi.mocked(api.probe).mock.calls[0]![0]).toEqual({ addresses: range(1, 20).map(addr), priority: "interactive" });
  expect(screen.queryByRole("checkbox", { name: addr(61) })).toBeNull();
  // Chunk 1 already fills the node budget (10 picks): one more chunk, then probing stops.
  expect(await screen.findByText("Probed 40 / 60")).toBeInTheDocument();
  expect(vi.mocked(api.probe).mock.calls[1]![0]).toEqual({ addresses: range(21, 40).map(addr), priority: "background" });
  await new Promise((r) => setTimeout(r, 20));
  expect(api.probe).toHaveBeenCalledTimes(2);
  // Further chunks only on demand.
  fireEvent.click(screen.getByRole("button", { name: "Probe more" }));
  expect(await screen.findByText("Probed 60 / 60")).toBeInTheDocument();
  expect(vi.mocked(api.probe).mock.calls[2]![0]).toEqual({ addresses: range(41, 60).map(addr), priority: "background" });
});

test("the lightest non-heavy wallets are checked by default; checking a Heavy one warns but does not block", async () => {
  nonces[addr(5)] = 100_000; // a Tukey outlier among nonces 1…30
  mockCounterparties(range(1, 30).map((n) => cp(n)));
  mount();
  await screen.findByText("Probed 30 / 30");
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
  // The meter's scale grows with the overrun; the text keeps used / budget.
  expect(nodes).toHaveAttribute("aria-valuenow", "66");
  expect(nodes).toHaveAttribute("aria-valuemax", "66");
  expect(nodes).toHaveAttribute("aria-valuetext", "66 / 60");
  expect(expandBtn()).toBeEnabled();
  // Rows show the local transfer count with the center and the probed facts.
  expect(within(heavyRow).getByText("5")).toBeInTheDocument();
  expect(within(heavyRow).getByText("100,000")).toBeInTheDocument();
  expect(within(heavyRow).getByText("1.500000 ETH")).toBeInTheDocument();
});

test("unprobed wallets show an estimated weight", async () => {
  mockCounterparties(range(1, 50).map((n) => cp(n)));
  mount();
  await screen.findByText("Probed 40 / 50");
  expect(within(box(45).closest("tr")!).getByText("est.")).toBeInTheDocument();
  expect(box(45).checked).toBe(false);
  expect(within(box(1).closest("tr")!).queryByText("est.")).toBeNull();
});

test("contracts are grouped, collapsed, never probed and never checked", async () => {
  mockCounterparties([cp(1), cp(2), cp(3, { kind: "contract" }), cp(4, { kind: "contract" }), cp(5)]);
  mount();
  await screen.findByText("Probed 3 / 3");
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
  await screen.findByText("Probed 30 / 30");
  expect(vi.mocked(api.probe).mock.calls[1]![0]).toEqual({ addresses: range(21, 30).map(addr), priority: "background" });
});

test("estimated wallets are never defaults; with real weights far above the estimates, probing still stops one chunk after the budget binds", async () => {
  for (const n of range(1, 60)) nonces[addr(n)] = 1000 * n; // real weights far above the count-based estimates
  let releaseSecond: () => void = () => {};
  vi.mocked(api.probe)
    .mockImplementationOnce(async (r) => probeAnswer(r.addresses))
    .mockImplementationOnce((r) => new Promise((res) => { releaseSecond = () => res(probeAnswer(r.addresses)); }));
  mockCounterparties(range(1, 60).map((n) => cp(n)));
  mount();
  await waitFor(() => expect(api.probe).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.probe).mock.calls[1]![0]).toEqual({ addresses: range(21, 40).map(addr), priority: "background" });
  // While chunk 2 is out: only probed wallets are checked (the 10 lightest probed ones), none estimated.
  expect(checkedAddrs()).toEqual(range(1, 10).map(addr));
  await act(async () => releaseSecond());
  await screen.findByText("Probed 40 / 60");
  await new Promise((r) => setTimeout(r, 20));
  expect(api.probe).toHaveBeenCalledTimes(2);
  expect(checkedAddrs()).toEqual(range(1, 10).map(addr));
  for (const n of range(1, 10)) expect(within(box(n).closest("tr")!).queryByText("est.")).toBeNull();
  expect(within(box(41).closest("tr")!).getByText("est.")).toBeInTheDocument();
});

test("a failed probe chunk shows the error, is not retried by itself, and 'Probe more' re-sends the same addresses", async () => {
  vi.mocked(api.probe).mockRejectedValueOnce(new ApiError("upstream_error", 502, "boom"));
  mockCounterparties(range(1, 30).map((n) => cp(n)));
  mount();
  expect(await screen.findByText(messageFor(new ApiError("upstream_error", 502, "boom")))).toBeInTheDocument();
  await new Promise((r) => setTimeout(r, 20));
  expect(api.probe).toHaveBeenCalledTimes(1);
  expect(checkedAddrs()).toEqual([]); // nothing probed: no estimated defaults
  fireEvent.click(screen.getByRole("button", { name: "Probe more" }));
  await waitFor(() => expect(api.probe).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.probe).mock.calls[1]![0].addresses).toEqual(range(1, 20).map(addr));
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
  // Every new center starts picked with no neighbours, waiting to be picked (spec §5).
  expect(g.picks[addr(1)]).toEqual([]);
  expect(g.limits[addr(1)]).toBeUndefined();
  expect(onClose).toHaveBeenCalled();
  expect(await screen.findByText("Expanded 3 addresses")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  act(() => useGraph.getState().setPinned([addr(1)], true));
  expect(screen.queryByText("Expanded 3 addresses")).toBeNull();
});

test("on a snapshot graph, confirming asks to refresh before any sync; cancel queues nothing, refresh then expands", async () => {
  const sync = vi.spyOn(api, "sync").mockResolvedValue({ estimated_calls: null, estimated_seconds: null, per_address: null, jobs: [1] });
  mockCounterparties(range(1, 3).map((n) => cp(n)));
  const { onClose } = mount();
  await waitFor(() => expect(checkedAddrs()).toHaveLength(3));
  act(() =>
    useGraph.getState().freeze({
      exported_at: "2026-10-01T12:00:00Z",
      includes: { labels: false, notes: false },
      data: { nodes: [], edges: [], omitted: {}, coverage: {} },
    }),
  );
  await act(async () => fireEvent.click(expandBtn()));
  expect(sync).not.toHaveBeenCalled();
  expect(useGraph.getState().pendingLive).not.toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();

  act(() => useGraph.getState().resolveLive(false));
  expect(sync).not.toHaveBeenCalled();
  expect(useGraph.getState().frozen).not.toBeNull();

  await act(async () => fireEvent.click(expandBtn()));
  await act(async () => useGraph.getState().resolveLive(true));
  expect(useGraph.getState().frozen).toBeNull();
  expect(sync).toHaveBeenCalledTimes(1);
  expect(useGraph.getState().centers).toEqual([addr(1), addr(2), addr(3)]);
  expect(onClose).toHaveBeenCalled();
});

test("the Undo toast has no timer: it stays until another history step or its close button", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    vi.spyOn(api, "sync").mockResolvedValue({ estimated_calls: null, estimated_seconds: null, per_address: null, jobs: [1] });
    mockCounterparties([cp(1)]);
    mount();
    await waitFor(() => expect(checkedAddrs()).toHaveLength(1));
    await act(async () => fireEvent.click(expandBtn()));
    expect(await screen.findByText("Expanded 1 address")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(10 * 60_000));
    expect(screen.getByText("Expanded 1 address")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Expanded 1 address")).toBeNull();
    expect(useGraph.getState().centers).toEqual([addr(1)]);
  } finally {
    vi.useRealTimers();
  }
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

test("a failed sync keeps the dialog open, expands nothing, cancels the batch and toasts the error", async () => {
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
  expect(await screen.findByText(messageFor(new ApiError("upstream_error", 502, "boom")))).toBeInTheDocument();
});

test("with several sync requests, the batch is cancelled only after all of them settled", async () => {
  useCanvasMetrics.setState({ width: 4000, height: 4000 });
  vi.mocked(api.status).mockResolvedValue(status({ rate: 10 }));
  let releaseFirst: () => void = () => {};
  const sync = vi.spyOn(api, "sync")
    .mockImplementationOnce(() => new Promise((r) => { releaseFirst = () => r({ estimated_calls: null, estimated_seconds: null, per_address: null, jobs: [1] }); }))
    .mockRejectedValueOnce(new ApiError("upstream_error", 502, "boom"));
  const cancel = vi.spyOn(api, "cancelBatch").mockResolvedValue({ cancelled: [] });
  mockCounterparties(range(1, 60).map((n) => cp(n)));
  mount();
  await waitFor(() => expect(checkedAddrs()).toHaveLength(60), { timeout: 5000 }); // probed chunk by chunk (20, 40, 60): waitFor's 1 s default expired mid-way under load
  await act(async () => fireEvent.click(expandBtn()));
  expect(sync).toHaveBeenCalledTimes(2);
  expect(cancel).not.toHaveBeenCalled();
  await act(async () => releaseFirst());
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(useGraph.getState().centers).toEqual([]);
});

test("while a confirm is in flight: no double submit, Cancel disabled, Escape and backdrop ignored", async () => {
  let release: () => void = () => {};
  const sync = vi.spyOn(api, "sync").mockImplementation(
    () => new Promise((r) => { release = () => r({ estimated_calls: null, estimated_seconds: null, per_address: null, jobs: [1] }); }),
  );
  mockCounterparties([cp(1)]);
  const { onClose, container } = mount();
  await waitFor(() => expect(checkedAddrs()).toHaveLength(1));
  fireEvent.click(expandBtn());
  fireEvent.click(expandBtn());
  expect(sync).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.click(container.querySelector(".dialog-backdrop")!);
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => release());
  expect(onClose).toHaveBeenCalledTimes(1);
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
  expect(within(box(8).closest("tr")!).getByText("—")).toBeInTheDocument(); // transfers with the center: unknown
  // Hand-picked contracts are shown (group open) and checked too.
  expect(screen.getByRole("button", { name: /Contracts \(1\)/ })).toHaveAttribute("aria-expanded", "true");
  expect(box(9)).toBeChecked();
  expect(screen.getByRole("meter", { name: "Nodes" })).toHaveAttribute("aria-valuenow", "16"); // 7 and 9 already on the canvas: 5 + 5 + 6
});

test("an 'up to about' line counts the checked addresses not on the canvas plus each one's first batch", async () => {
  mockCounterparties([cp(1), cp(2)]);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useGraph.getState().addCenter(ME);
  qc.setQueryData(graphQueryKey(useGraph.getState()), { nodes: [node(999), node(1)], edges: [], omitted: {}, coverage: {} });
  mount({ qc });
  await waitFor(() => expect(checkedAddrs()).toEqual([addr(1), addr(2)]));
  // 1 new address + 2 × perCenterBatch(60, 2, 1) = 1 + 2 × 29
  const line = screen.getByText("Up to about 59 new nodes");
  expect(line).toHaveAttribute("title", "The checked addresses plus each one's first batch of counterparties; the exact number is known after they sync");
  fireEvent.click(box(1));
  fireEvent.click(box(2));
  expect(screen.queryByText(/^Up to about/)).toBeNull();
});

test("a busy queue zeroes the call budget and says so", async () => {
  vi.mocked(api.status).mockResolvedValue(status({ queued_calls: 300 }));
  mockCounterparties(range(1, 3).map((n) => cp(n)));
  mount();
  expect(await screen.findByText("Queue is busy — new work will wait behind 300 calls.")).toBeInTheDocument();
  // Budget 0, the lightest probed wallet still checked: the scale is the usage.
  await waitFor(() => expect(screen.getByRole("meter", { name: "Calls" })).toHaveAttribute("aria-valuetext", "6 / 0"));
  expect(screen.getByRole("meter", { name: "Calls" })).toHaveAttribute("aria-valuemax", "6");
});

test("the probe cost is its own line; only checked calls are compared with the remaining quota", async () => {
  probeCalls = 5;
  vi.mocked(api.status).mockResolvedValue(status({ quota_used: 4990 }));
  mockCounterparties(range(1, 3).map((n) => cp(n)));
  mount();
  expect(await screen.findByText("Probe: 5 calls (already spent, not part of the work budget)")).toBeInTheDocument();
  // Call budget = remaining quota 10: one wallet (6 calls) is checked; 6 <= 10, the probe spend is not added again.
  await waitFor(() => expect(checkedAddrs()).toEqual([addr(1)]));
  expect(screen.queryByText("Checked calls exceed today's remaining quota")).toBeNull();
  fireEvent.click(box(2)); // 12 > 10
  expect(screen.getByText("Checked calls exceed today's remaining quota")).toBeInTheDocument();
  expect(expandBtn()).toBeEnabled();
});

test("synced candidates cost no calls unless their cached coverage failed or never finished", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useGraph.getState().addCenter(ME);
  const cov = (state: "ok" | "failed", last: string | null) =>
    [{ kind: "native" as const, from_block: 1, to_block: 2, truncated: false, state, last_synced_at: last, oldest_ts: null }];
  qc.setQueryData(graphQueryKey(useGraph.getState()), {
    nodes: [node(999), node(1, { synced: true }), node(2, { synced: true }), node(3, { synced: true })],
    edges: [], omitted: {},
    coverage: { [addr(1)]: cov("ok", "2026-10-18T00:00:00Z"), [addr(2)]: cov("failed", "2026-10-18T00:00:00Z"), [addr(3)]: cov("ok", null) },
  });
  vi.mocked(api.probe).mockImplementation(async (r) => ({
    calls: 0,
    items: r.addresses.map((a) => ({ ...probeAnswer([a]).items[0]!, synced: true })),
  }));
  mockCounterparties([cp(1, { synced: true }), cp(2, { synced: true }), cp(3, { synced: true })]);
  mount({ qc });
  await screen.findByText("Probed 3 / 3");
  await waitFor(() => expect(checkedAddrs()).toHaveLength(3));
  // 0 (fresh) + 6 (failed category) + 6 (never finished)
  expect(screen.getByRole("meter", { name: "Calls" })).toHaveAttribute("aria-valuenow", "12");
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
  fireEvent.click(screen.getByRole("dialog")); // inside: stays open
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.click(document.querySelector(".dialog-backdrop")!);
  expect(onClose).toHaveBeenCalledTimes(2);
});

test("an unsynced node is shallow-synced on open; its candidates load once the sync job ends", async () => {
  const sync = vi.spyOn(api, "sync").mockResolvedValue({ estimated_calls: null, estimated_seconds: null, per_address: null, jobs: [5] });
  useJobProgress.setState({ byId: {} });
  const counterparties = vi
    .spyOn(api, "counterparties")
    .mockResolvedValueOnce({ items: [], total: 0 })
    .mockResolvedValue({ items: [cp(1), cp(2)], total: 2 });
  mount({ node: { synced: false } });
  await waitFor(() => expect(sync).toHaveBeenCalledWith({ addresses: [ME], depth: "shallow" }));
  expect(await screen.findByText(/Syncing this address/)).toBeInTheDocument();
  expect(screen.queryByText(/No stored counterparties/)).toBeNull();
  act(() =>
    useJobProgress.getState().upsert({ type: "JobProgress", job_id: 5, kind: "sync_address", fetched: 0, cursor_block: null, status: "done", error: null }),
  );
  expect(await screen.findByRole("checkbox", { name: addr(1) })).toBeInTheDocument();
  expect(screen.queryByText(/Syncing this address/)).toBeNull();
  expect(counterparties).toHaveBeenCalledTimes(2);
});

test("a synced or syncing node is not synced again; a data-changed invalidation reloads its candidates", async () => {
  const sync = vi.spyOn(api, "sync");
  const counterparties = mockCounterparties([cp(1)]);
  const { qc } = mount({ node: { synced: false, syncing: true } });
  await screen.findByRole("checkbox", { name: addr(1) });
  expect(sync).not.toHaveBeenCalled();
  counterparties.mockResolvedValue({ items: [cp(1), cp(2)], total: 2 });
  await act(() => qc.invalidateQueries({ queryKey: ["counterparties", ME] }));
  expect(await screen.findByRole("checkbox", { name: addr(2) })).toBeInTheDocument();
});

test("preset candidates leave out current centers (Undo must not cancel their syncs)", async () => {
  useGraph.getState().addCenter(addr(2));
  mount({ preset: [addr(1), addr(2)] });
  await waitFor(() => expect(checkedAddrs()).toEqual([addr(1)]));
  expect(screen.queryByRole("checkbox", { name: addr(2) })).toBeNull();
});

test("the probe counter names the stored total when more counterparties exist than were loaded", async () => {
  vi.spyOn(api, "counterparties").mockResolvedValue({ items: range(1, 3).map((n) => cp(n)), total: 1500 });
  mount();
  expect(await screen.findByText("Probed 3 / 3 of 1,500")).toBeInTheDocument();
});
