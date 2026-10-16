import { act, fireEvent, render, screen } from "@testing-library/react";
import { App } from "../App";
import { api } from "../api/endpoints";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import type { TxResponseDto } from "../api/generated/TxResponseDto";
import type { CytoscapeViewProps } from "../graph/CytoscapeView";
import { queryClient } from "../api/queryClient";
import { useGraph } from "../graph/store";
import { useTabs } from "../shell/tabs";

// One mocked canvas per mount, identified by the first node id of its elements.
const h = vi.hoisted(() => ({ byFirst: {} as Record<string, CytoscapeViewProps> }));
vi.mock("../graph/CytoscapeView", () => ({
  CytoscapeView: (p: CytoscapeViewProps) => {
    const first = String(p.elements[0]?.data.id ?? "none");
    h.byFirst[first] = p;
    return <div data-testid="cy" data-first={first} />;
  },
}));
vi.mock("../api/useEvents", () => ({ useEvents: () => {} }));
vi.mock("../panels/NodeDetail", () => ({ NodeDetail: ({ address }: { address: string }) => <div>detail:{address}</div> }));

const H1 = "0x" + "a1".repeat(32);
const H2 = "0x" + "b2".repeat(32);
const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const node = (address: string): NodeSummaryDto => ({
  address, kind: "eoa", display_name: null, ens: null, contract_name: null, labels: [],
  partial: false, syncing: false, synced: true, hot: false,
});
const resp = (from: string, to: string, hash: string): TxResponseDto => ({
  status: "ready", job_id: null,
  flow: {
    tx: { hash, block_number: 1, ts: "2026-01-01T00:00:00Z", from, to, value: "0", success: true, gas_used: "1", fee: "1", method: null, selector: null },
    call: null, nodes: [node(from), node(to)], flows: [], events: [], completeness: "full_trace",
  },
});

beforeEach(() => {
  queryClient.clear();
  useGraph.getState().reset();
  useTabs.setState({ tabs: [{ id: "graph" }], active: "graph" });
  history.replaceState(null, "", "/");
  localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

test("each tx tab keeps its own selection and table tab across switches", async () => {
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
  fireEvent.click(screen.getAllByRole("button", { name: "事件", hidden: true })[0]!);
  act(() => useTabs.getState().activate(H2));
  // tx B has no selection and still shows the flows tab.
  expect(screen.getByText(`detail:${B}`).closest("[hidden]")).not.toBeNull();
  expect(screen.getAllByRole("button", { name: "事件", hidden: true })[1]).toHaveAttribute("aria-pressed", "false");
  act(() => useTabs.getState().activate(H1));
  expect(screen.getByText(`detail:${B}`).closest("[hidden]")).toBeNull();
  expect(screen.getAllByRole("button", { name: "事件", hidden: true })[0]).toHaveAttribute("aria-pressed", "true");
});
