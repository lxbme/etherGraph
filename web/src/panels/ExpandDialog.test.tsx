import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api/endpoints";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { topNeighbors } from "../graph/neighbors";
import { useGraph } from "../graph/store";
import { useQuota } from "../shell/statusStore";
import { Toasts } from "../shell/Toasts";
import { ExpandDialog } from "./ExpandDialog";

const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const node = (n: number, o: Partial<NodeSummaryDto> = {}): NodeSummaryDto => ({
  address: addr(n), kind: "eoa", display_name: null, ens: null, contract_name: null, labels: [],
  partial: false, syncing: false, synced: false, hot: false, ...o,
});

beforeEach(() => {
  useGraph.getState().reset();
  useQuota.setState({ quota: { used: 100, limit: 5000, paused: false, reset_at: "" } });
  vi.spyOn(api, "status").mockResolvedValue({ rate: 2 } as never);
});
afterEach(() => vi.restoreAllMocks());

test("expand dialog unchecks hot neighbors by default and shows dry-run estimate", async () => {
  const sync = vi.spyOn(api, "sync").mockResolvedValue({
    estimated_calls: 9, estimated_seconds: 3, jobs: null,
    per_address: { [addr(1)]: 4, [addr(2)]: 0, [addr(3)]: 5 },
  });
  const ns = [node(1), node(2, { synced: true }), node(3, { hot: true })];
  render(<ExpandDialog neighbors={ns} onClose={() => {}} />);
  expect(await screen.findByText("Estimated 4 calls · ~2 s · 4900 left in today's quota")).toBeInTheDocument();
  expect(sync).toHaveBeenCalledTimes(1);
  expect(sync).toHaveBeenCalledWith({ addresses: [addr(1), addr(2), addr(3)], dry_run: true });
  const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
  expect(boxes.map((b) => b.checked)).toEqual([true, true, false]);
  expect(screen.getByText("Hot")).toBeInTheDocument();
  expect(screen.getByText("Synced")).toBeInTheDocument();
  // Toggling recomputes locally without another request.
  fireEvent.click(boxes[2]!);
  expect(await screen.findByText("Estimated 9 calls · ~5 s · 4900 left in today's quota")).toBeInTheDocument();
  expect(sync).toHaveBeenCalledTimes(1);
  fireEvent.click(boxes[0]!);
  fireEvent.click(boxes[1]!);
  fireEvent.click(boxes[2]!);
  expect(screen.getByRole("button", { name: "Start sync" })).toBeDisabled();
});

test("confirming expand syncs checked neighbors and adds them as centers", async () => {
  const sync = vi.spyOn(api, "sync")
    .mockResolvedValueOnce({ estimated_calls: 4, estimated_seconds: 1, jobs: null, per_address: { [addr(1)]: 4, [addr(3)]: 5 } })
    .mockResolvedValueOnce({ estimated_calls: null, estimated_seconds: null, per_address: null, jobs: [1] });
  const onClose = vi.fn();
  render(<><ExpandDialog neighbors={[node(1), node(3, { hot: true })]} onClose={onClose} /><Toasts /></>);
  await screen.findByText(/Estimated 4 calls/);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start sync" })));
  expect(sync).toHaveBeenLastCalledWith({ addresses: [addr(1)] });
  await waitFor(() => expect(useGraph.getState().centers).toEqual([addr(1)]));
  expect(await screen.findByText("Started syncing 1 address")).toBeInTheDocument();
  expect(onClose).toHaveBeenCalled();
});

test("top-K picks the 10 highest-count non-hot neighbors", () => {
  const me = addr(999);
  const nodes = [node(999)];
  const edges = [];
  for (let i = 1; i <= 12; i++) {
    nodes.push(node(i, { hot: i === 12 }));
    edges.push({ from: me, to: addr(i), asset: null, asset_kind: "native" as const, count: i * 10, sum: "1", first_ts: "", last_ts: "", decimals: 18, symbol: "ETH" });
  }
  const top = topNeighbors(me, nodes, edges, {});
  expect(top).toHaveLength(10);
  expect(top[0]).toBe(addr(11));
  expect(top).not.toContain(addr(12));
  expect(top).not.toContain(addr(1));
  // single-asset filter ranks by BigInt amount instead of count
  const e2 = [
    { ...edges[0]!, to: addr(1), count: 1, sum: "900000000000000000000000000" },
    { ...edges[1]!, to: addr(2), count: 99, sum: "5" },
  ];
  expect(topNeighbors(me, nodes, e2, { assets: [{ asset: "eth" }] }, 1)).toEqual([addr(1)]);
});

import { ApiError } from "../api/errors";

test("dry-run failure keeps confirm disabled, shows the error, never syncs for real; retry recovers", async () => {
  const sync = vi.spyOn(api, "sync").mockRejectedValueOnce(new ApiError("upstream_error", 502, "x"));
  render(<ExpandDialog neighbors={[node(1)]} onClose={() => {}} />);
  const btn = screen.getByRole("button", { name: "Start sync" });
  expect(btn).toBeDisabled(); // pending
  fireEvent.click(btn);
  expect(sync).toHaveBeenCalledTimes(1);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(btn).toBeDisabled();
  fireEvent.click(btn);
  expect(sync.mock.calls.every(([r]) => r.dry_run === true)).toBe(true);

  sync.mockResolvedValueOnce({ estimated_calls: 2, estimated_seconds: 1, jobs: null, per_address: { [addr(1)]: 2 } });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText(/Estimated 2 calls/);
  expect(btn).toBeEnabled();
});

test("a row without a per_address entry shows a dash", async () => {
  vi.spyOn(api, "sync").mockResolvedValue({ estimated_calls: 0, estimated_seconds: 0, jobs: null, per_address: {} });
  render(<ExpandDialog neighbors={[node(1)]} onClose={() => {}} />);
  await screen.findByText(/Estimated 0 calls/);
  expect(screen.getByText("—")).toBeInTheDocument();
});

test("shortcuts are suppressed while the dialog is open", async () => {
  vi.spyOn(api, "sync").mockResolvedValue({ estimated_calls: 0, estimated_seconds: 0, jobs: null, per_address: {} });
  const { useShortcuts } = await import("../graph/useShortcuts");
  function Host() { useShortcuts(() => undefined); return null; }
  render(<><Host /><ExpandDialog neighbors={[node(1)]} onClose={() => {}} /></>);
  act(() => useGraph.getState().select({ kind: "node", address: addr(1) }));
  useGraph.getState().setHidden([addr(5)], true);
  fireEvent.keyDown(document.body, { key: "h" });
  expect(useGraph.getState().ui[addr(1)]?.hidden).toBeFalsy();
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
  expect(useGraph.getState().ui[addr(5)]?.hidden).toBe(true);
});

test("warns (without blocking) when the estimate exceeds today's remaining quota", async () => {
  useQuota.setState({ quota: { used: 4995, limit: 5000, paused: false, reset_at: "" } });
  vi.spyOn(api, "sync").mockResolvedValue({
    estimated_calls: 9, estimated_seconds: 3, jobs: null, per_address: { [addr(1)]: 4, [addr(2)]: 5 },
  });
  render(<ExpandDialog neighbors={[node(1), node(2)]} onClose={() => {}} />);
  expect(await screen.findByText("Estimated calls exceed today's remaining quota")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start sync" })).toBeEnabled();
  fireEvent.click(screen.getAllByRole("checkbox")[1]!); // 4 calls left: within the remaining 5
  expect(screen.queryByText("Estimated calls exceed today's remaining quota")).toBeNull();
});
