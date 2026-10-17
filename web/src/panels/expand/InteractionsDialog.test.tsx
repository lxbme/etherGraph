import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../../api/endpoints";
import type { CounterpartyDto } from "../../api/generated/CounterpartyDto";
import type { NodeSummaryDto } from "../../api/generated/NodeSummaryDto";
import type { StatusDto } from "../../api/generated/StatusDto";
import { useCanvasMetrics } from "../../graph/canvasMetrics";
import { useGraph } from "../../graph/store";
import { useJobProgress, useQuota } from "../../shell/statusStore";
import { InteractionsDialog } from "./InteractionsDialog";

const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const node = (n: number, o: Partial<NodeSummaryDto> = {}): NodeSummaryDto => ({
  address: addr(n), kind: "eoa", display_name: null, ens: null, contract_name: null, labels: [],
  partial: false, syncing: false, synced: true, hot: false, nonce: null, balance: null, ...o,
});
const contract = node(999, { kind: "contract" });
const cp = (n: number, o: Partial<CounterpartyDto> = {}): CounterpartyDto => ({
  node: node(n), count: n, last_ts: "2026-01-02T03:04:05Z", assets: [], ...o,
});
const status: StatusDto = {
  quota_used: 100, quota_limit: 5000, paused: false, reset_at: "", queue_len: 0, rate: 2.5, jobs_active: 0,
  queued_calls: 0, calls: 0, retries: 0, errors: {}, degraded: null,
};

function mount(c: NodeSummaryDto = contract) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const r = render(
    <QueryClientProvider client={qc}>
      <InteractionsDialog contract={c} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { ...r, qc, onClose };
}

beforeEach(() => {
  useGraph.getState().reset();
  useCanvasMetrics.setState({ width: 960, height: 576, visible: 0 });
  useQuota.setState({ quota: { used: 100, limit: 5000, paused: false, reset_at: "" } });
  vi.spyOn(api, "status").mockResolvedValue(status);
  vi.spyOn(api, "probe").mockResolvedValue({ calls: 0, items: [] });
});
afterEach(() => vi.restoreAllMocks());

test("an unsynced contract is shallow-synced on open and shows the syncing note", async () => {
  const sync = vi.spyOn(api, "sync").mockResolvedValue({ jobs: [3] } as never);
  useJobProgress.setState({ byId: {} });
  vi.spyOn(api, "counterparties").mockResolvedValue({ items: [], total: 0 });
  mount(node(999, { kind: "contract", synced: false }));
  await waitFor(() => expect(sync).toHaveBeenCalledWith({ addresses: [addr(999)], depth: "shallow" }));
  expect(await screen.findByText(/Syncing this contract/)).toBeInTheDocument();
});

test("when the sync job finishes with no counterparties the syncing note gives way to the empty message", async () => {
  vi.spyOn(api, "sync").mockResolvedValue({ jobs: [7] } as never);
  vi.spyOn(api, "counterparties").mockResolvedValue({ items: [], total: 0 });
  useJobProgress.setState({ byId: {} });
  mount(node(999, { kind: "contract", synced: false }));
  expect(await screen.findByText(/Syncing this contract/)).toBeInTheDocument();
  expect(screen.queryByText("No stored interactions match.")).toBeNull();
  act(() =>
    useJobProgress.getState().upsert({ type: "JobProgress", job_id: 7, kind: "sync_address", fetched: 0, cursor_block: null, status: "done", error: null }),
  );
  expect(await screen.findByText("No stored interactions match.")).toBeInTheDocument();
  expect(screen.queryByText(/Syncing this contract/)).toBeNull();
});

test("a failed sync request clears the syncing note", async () => {
  vi.spyOn(api, "sync").mockRejectedValue(new Error("boom"));
  vi.spyOn(api, "counterparties").mockResolvedValue({ items: [], total: 0 });
  mount(node(999, { kind: "contract", synced: false }));
  expect(await screen.findByText("No stored interactions match.")).toBeInTheDocument();
  expect(screen.queryByText(/Syncing this contract/)).toBeNull();
});

test("a synced contract is not synced again", async () => {
  const sync = vi.spyOn(api, "sync").mockResolvedValue({ jobs: [] } as never);
  vi.spyOn(api, "counterparties").mockResolvedValue({ items: [cp(1)], total: 1 });
  mount();
  await screen.findByRole("checkbox", { name: addr(1) });
  expect(sync).not.toHaveBeenCalled();
});

test("rows show the counterparty, asset symbols (max 3 plus +N) and Count is the default sort", async () => {
  const assets = ["A", "B", "C", "D", "E"].map((s) => ({ asset: "0x" + s.charCodeAt(0).toString(16).repeat(20), symbol: s }));
  const spy = vi.spyOn(api, "counterparties").mockResolvedValue({ items: [cp(1, { assets })], total: 1 });
  mount();
  const row = (await screen.findByRole("checkbox", { name: addr(1) })).closest("tr")!;
  expect(within(row).getByText("A, B, C")).toBeInTheDocument();
  expect(within(row).getByText("+2")).toBeInTheDocument();
  expect(spy).toHaveBeenCalledWith(addr(999), expect.objectContaining({ sort: "count_desc", limit: 100, offset: 0, kind: "all" }));
});

test("choosing Wallets requests kind=eoa; Recent sorts by recency; 7d sends a from bound", async () => {
  const spy = vi.spyOn(api, "counterparties").mockResolvedValue({ items: [cp(1)], total: 1 });
  mount();
  await screen.findByRole("checkbox", { name: addr(1) });
  fireEvent.click(screen.getByRole("radio", { name: "Wallets" }));
  await waitFor(() => expect(spy).toHaveBeenLastCalledWith(addr(999), expect.objectContaining({ kind: "eoa" })));
  fireEvent.click(screen.getByRole("radio", { name: "Recent" }));
  await waitFor(() => expect(spy).toHaveBeenLastCalledWith(addr(999), expect.objectContaining({ sort: "recent" })));
  fireEvent.click(screen.getByRole("radio", { name: "Last 7 days" }));
  await waitFor(() => expect(spy.mock.lastCall?.[1]?.from).toMatch(/^\d{4}-\d\d-\d\dT/));
});

test("Load more pages by offset and keeps checked rows", async () => {
  const first = Array.from({ length: 100 }, (_, i) => cp(i + 1));
  const spy = vi.spyOn(api, "counterparties").mockImplementation(async (_a, p) =>
    p?.offset ? { items: [cp(101)], total: 101 } : { items: first, total: 101 },
  );
  mount();
  fireEvent.click(await screen.findByRole("checkbox", { name: addr(1) }));
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: addr(101) }));
  expect(spy).toHaveBeenLastCalledWith(addr(999), expect.objectContaining({ offset: 100 }));
  expect((screen.getByRole("checkbox", { name: addr(1) }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByRole("button", { name: "Expand selected (2)" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  expect(screen.getAllByRole("checkbox", { name: addr(1) })).toHaveLength(1);
});

test("a data-changed invalidation of the contract's counterparties refetches", async () => {
  const spy = vi.spyOn(api, "counterparties").mockResolvedValue({ items: [], total: 0 });
  const { qc } = mount();
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  await act(() => qc.invalidateQueries({ queryKey: ["counterparties", addr(999)] }));
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
});

test("rows repeated across pages show once", async () => {
  vi.spyOn(api, "counterparties").mockImplementation(async (_a, p) =>
    p?.offset ? { items: [cp(100), cp(101)], total: 101 } : { items: Array.from({ length: 100 }, (_, i) => cp(i + 1)), total: 101 },
  );
  mount();
  await screen.findByRole("checkbox", { name: addr(1) });
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await screen.findByRole("checkbox", { name: addr(101) });
  expect(screen.getAllByRole("checkbox", { name: addr(100) })).toHaveLength(1);
});

test("confirming opens the expansion dialog with exactly the picked candidates, all checked", async () => {
  vi.spyOn(api, "counterparties").mockResolvedValue({ items: [cp(1), cp(2), cp(3)], total: 3 });
  mount();
  fireEvent.click(await screen.findByRole("checkbox", { name: addr(1) }));
  fireEvent.click(screen.getByRole("checkbox", { name: addr(3) }));
  expect(screen.queryByRole("checkbox", { name: addr(999) })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Expand selected (2)" }));
  const dlg = await screen.findByRole("dialog", { name: /Expand neighbors of/ });
  await waitFor(() => expect(within(dlg).getAllByRole("checkbox")).toHaveLength(2));
  const boxes = within(dlg).getAllByRole("checkbox") as HTMLInputElement[];
  expect(boxes.map((b) => b.getAttribute("aria-label")).sort()).toEqual([addr(1), addr(3)]);
  expect(boxes.every((b) => b.checked)).toBe(true);
  expect(within(dlg).getByRole("meter", { name: "Nodes" })).toBeInTheDocument();
});
