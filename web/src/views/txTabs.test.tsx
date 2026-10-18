import { act, fireEvent, render, screen } from "@testing-library/react";
import { App } from "../App";
import { api } from "../api/endpoints";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import type { TxResponseDto } from "../api/generated/TxResponseDto";
import type { CytoscapeViewProps } from "../graph/CytoscapeView";
import { queryClient } from "../api/queryClient";
import { useGraph } from "../graph/store";
import { useUi } from "../panels/uiStore";
import { useTabs } from "../shell/tabs";
import { serialize } from "../workspace/serialize";
import { loadWorkspace, useWorkspace } from "../workspace/useWorkspace";

// One mocked canvas per mount, identified by the first node id of its elements.
const h = vi.hoisted(() => ({ byFirst: {} as Record<string, CytoscapeViewProps>, mounts: 0 }));
vi.mock("../graph/CytoscapeView", async () => {
  const { useEffect } = await import("react");
  return {
    CytoscapeView: (p: CytoscapeViewProps) => {
      useEffect(() => void h.mounts++, []);
      const first = String(p.elements[0]?.data.id ?? "none");
      h.byFirst[first] = p;
      return <div data-testid="cy" data-first={first} />;
    },
  };
});
vi.mock("../api/useEvents", () => ({ useEvents: () => {} }));
vi.mock("../panels/NodeDetail", () => ({ NodeDetail: ({ address }: { address: string }) => <div>detail:{address}</div> }));

const H1 = "0x" + "a1".repeat(32);
const H2 = "0x" + "b2".repeat(32);
const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const node = (address: string): NodeSummaryDto => ({
  address, kind: "eoa", display_name: null, ens: null, contract_name: null, labels: [],
  partial: false, syncing: false, synced: true, hot: false, identified: true, nonce: null, balance: null,
});
const resp = (from: string, to: string, hash: string): TxResponseDto => ({
  status: "ready", job_id: null,
  flow: {
    tx: { hash, block_number: 1, ts: "2026-01-01T00:00:00Z", from, to, value: "0", success: true, gas_used: "1", fee: "1", method: null, selector: null },
    detail: {
      nonce: 0, tx_type: 2, position: 0, confirmations: null, gas_limit: "21000", gas_used: "21000",
      gas_price: null, effective_gas_price: null, max_fee: null, max_priority_fee: null, base_fee: null,
      burnt_fee: null, savings: null, blob_gas_used: null, blob_gas_price: null, blob_fee: null, access_list_len: null,
      contract_created: null, revert_reason: null, input: "0x", authorizations: [], delegations: [],
    },
    call: null, nodes: [node(from), node(to)], flows: [], events: [], completeness: "full_trace",
  },
});

beforeEach(() => {
  queryClient.clear();
  useGraph.getState().reset();
  useTabs.setState({ tabs: [{ id: "graph" }], active: "graph" });
  history.replaceState(null, "", "/");
  localStorage.clear();
  useUi.setState({ txSelection: {}, labelEditorFor: null, detailOpen: true });
});
afterEach(() => vi.restoreAllMocks());

test("each tx tab keeps its own selection and detail tab across switches", async () => {
  vi.spyOn(api, "tx").mockImplementation(async (hash) => (hash === H1 ? resp(A, B, H1) : resp(B, A, H2)));
  render(<App />);
  act(() => {
    useTabs.getState().openTx(H1);
    useTabs.getState().openTx(H2);
  });
  await screen.findAllByTestId("cy");
  // Two mounted canvases (one per tx tab) distinguished by their first node.
  await vi.waitFor(() => expect(Object.keys(h.byFirst)).toEqual(expect.arrayContaining([A, B])));
  act(() => useTabs.getState().activate(H1));
  act(() => h.byFirst[A]!.onTapNode(B, { shift: false }));
  expect(screen.getByText(`detail:${B}`)).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button", { name: "Logs", hidden: true })[0]!);
  act(() => useTabs.getState().activate(H2));
  // tx B has no selection (the right panel shows its placeholder) and still shows the overview.
  expect(screen.queryByText(`detail:${B}`)).toBeNull();
  expect(screen.getByText("Select a node to see details")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Logs", hidden: true })[1]).toHaveAttribute("aria-pressed", "false");
  expect(screen.getAllByRole("button", { name: "Overview", hidden: true })[1]).toHaveAttribute("aria-pressed", "true");
  act(() => useTabs.getState().activate(H1));
  expect(screen.getByText(`detail:${B}`).closest("[hidden]")).toBeNull();
  expect(screen.getAllByRole("button", { name: "Logs", hidden: true })[0]).toHaveAttribute("aria-pressed", "true");
  expect(useTabs.getState().tabs.find((t) => t.id === H1)).toMatchObject({ detailTab: "logs" });
});

test("on a tx tab the right panel shows only that tab's detail, never the graph's as well", async () => {
  vi.spyOn(api, "tx").mockResolvedValue(resp(A, B, H1));
  render(<App />);
  act(() => {
    useGraph.getState().select({ kind: "node", address: A });
    useTabs.getState().openTx(H1);
  });
  await vi.waitFor(() => expect(h.byFirst[A]).toBeDefined());
  expect(screen.queryByText(`detail:${A}`)).toBeNull();
  act(() => h.byFirst[A]!.onTapNode(B, { shift: false }));
  expect(screen.getAllByText(/^detail:/)).toHaveLength(1);
  expect(screen.getByText(`detail:${B}`).closest(".main__right")).not.toBeNull();
  expect(screen.getByText(`detail:${B}`).closest(".main__tx")).toBeNull();
  act(() => useTabs.getState().activate("graph"));
  expect(screen.getAllByText(/^detail:/)).toHaveLength(1);
  expect(screen.getByText(`detail:${A}`)).toBeInTheDocument();
});

test("a tx canvas gets its tab's saved layout; a node drag marks the workspace dirty; opening a workspace re-creates an open tab", async () => {
  vi.spyOn(api, "tx").mockResolvedValue(resp(A, B, H1));
  render(<App />);
  act(() => useTabs.getState().openTx(H1));
  await vi.waitFor(() => expect(h.byFirst[A]).toBeDefined());
  expect(h.byFirst[A]!.initialLayout).toBeUndefined();

  useWorkspace.getState().setCurrent({ id: 7, name: "w", updated_at: "T1" });
  act(() => h.byFirst[A]!.onDragEnd({ [A]: { x: 1, y: 2 } }));
  expect(useWorkspace.getState().dirty).toBe(true);

  const layout = { positions: { [A]: { x: 1, y: 2 }, [B]: { x: 3, y: 4 } }, viewport: { zoom: 2, pan: { x: 5, y: 6 } } };
  const graph = JSON.parse(JSON.stringify(serialize(useGraph.getState(), { zoom: 1, pan: { x: 0, y: 0 } })));
  vi.spyOn(api, "workspace").mockResolvedValue({
    id: 8, name: "v", schema_version: 2, created_at: "T0", updated_at: "T2",
    state: { graph, tabs: [{ hash: H1, ...layout }], active: H1 },
  });
  const before = h.mounts;
  await act(() => loadWorkspace(8));
  await vi.waitFor(() => expect(h.byFirst[A]!.initialLayout).toEqual(layout));
  expect(h.mounts).toBeGreaterThan(before);
  expect(useTabs.getState().active).toBe(H1);
});
