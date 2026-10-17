import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api/endpoints";
import type { AddressProfileDto } from "../api/generated/AddressProfileDto";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import { useGraph } from "../graph/store";
import { graphQueryKey } from "../graph/useGraphData";
import { formatLocalTime } from "../lib/format";
import { NodeDetail } from "./NodeDetail";

const A = "0x" + "aa".repeat(20);
const IMPL = "0x" + "AB".repeat(20);

const profile: AddressProfileDto = {
  node: {
    address: A, kind: "contract", display_name: null, ens: null, contract_name: "Proxy", labels: [],
    partial: false, syncing: false, synced: true, hot: false,
  },
  is_proxy: true, implementation: IMPL, creator: null, creation_tx: null, coverage: [], first_seen: null, last_seen: null,
};

let qc: QueryClient;
function renderDetail(onNavigate?: (a: string) => void, p: AddressProfileDto = profile) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  vi.spyOn(api, "address").mockResolvedValue(p);
  render(
    <QueryClientProvider client={qc}>
      <NodeDetail address={A} onNavigate={onNavigate} />
    </QueryClientProvider>,
  );
}
beforeEach(() => useGraph.getState().reset());
afterEach(() => vi.restoreAllMocks());

test("with onNavigate the implementation button navigates locally and leaves the main graph alone", async () => {
  const onNavigate = vi.fn();
  renderDetail(onNavigate);
  fireEvent.click(await screen.findByTitle(IMPL));
  expect(onNavigate).toHaveBeenCalledWith(IMPL.toLowerCase());
  expect(useGraph.getState().centers).toEqual([]);
  expect(useGraph.getState().selection).toBeNull();
});

test("without onNavigate the implementation button adds a center and selects it", async () => {
  renderDetail();
  fireEvent.click(await screen.findByTitle(IMPL));
  expect(useGraph.getState().centers.map((c) => c.toLowerCase())).toContain(IMPL.toLowerCase());
  expect(useGraph.getState().selection).toEqual({ kind: "node", address: IMPL.toLowerCase() });
});

const B = "0x" + "bb".repeat(20);
const C = "0x" + "cc".repeat(20);
const wallet: AddressProfileDto = {
  node: {
    address: A, kind: "eoa", display_name: null, ens: null, contract_name: null,
    labels: [{ id: 1, text: "Hot wallet", category: "exchange", source: "import:x" }],
    partial: false, syncing: false, synced: true, hot: false,
  },
  is_proxy: false, implementation: null, creator: null, creation_tx: null,
  coverage: [{ kind: "native", from_block: 1, to_block: 2, truncated: false, state: "ok", last_synced_at: null }],
  first_seen: "2024-09-12T01:02:03Z", last_seen: "2026-10-16T04:11:07Z",
};

test("follows the spec hierarchy: kind, address with copy, tags, key/value grid, primary action", async () => {
  renderDetail(undefined, wallet);
  const kind = await screen.findByText("Wallet");
  expect(kind).toHaveClass("overline");
  const addr = screen.getByText(A);
  expect(addr).toHaveClass("num");
  expect(within(addr.parentElement!).getByRole("button", { name: "Copy" })).toBeInTheDocument();

  const tags = screen.getByTestId("node-tags");
  expect(within(tags).getByText("Exchange")).toBeInTheDocument();
  expect(within(tags).getByText("Synced")).toBeInTheDocument();
  expect(within(tags).getByText("Hot wallet")).toBeInTheDocument();

  const kv = screen.getByTestId("node-kv");
  expect(kv).toHaveClass("kv");
  const keys = [...kv.querySelectorAll("dt")].map((d) => d.textContent);
  expect(keys.slice(0, 5)).toEqual(["Transactions", "First seen", "Last active", "Neighbours", "Coverage"]);
  const last = within(kv).getByText("2026-10-16 04:11:07");
  expect(last).toHaveAttribute("title", formatLocalTime("2026-10-16T04:11:07Z"));
  expect(within(kv).getByText("1 / 5")).toBeInTheDocument();
  // No balance until probing exists (plan 3).
  expect(screen.queryByText(/balance/i)).toBeNull();

  expect(screen.getByRole("button", { name: "Sync / refresh" })).toHaveClass("btn--primary");
  // Order on the page.
  const order = [kind, addr, tags, kv, screen.getByRole("button", { name: "Sync / refresh" })];
  for (let i = 1; i < order.length; i++) {
    expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
});

test("transactions and neighbours come from the canvas edges", async () => {
  act(() => useGraph.getState().setCenters([A]));
  renderDetail(undefined, wallet);
  const e = { asset: null, asset_kind: "native", sum: "1", first_ts: "", last_ts: "", decimals: 18, symbol: null } as const;
  const data: GraphResponseDto = {
    nodes: [], omitted: {}, coverage: {},
    edges: [{ ...e, from: A, to: B, count: 3 }, { ...e, from: C, to: A, count: 4 }, { ...e, from: B, to: A, count: 2 }, { ...e, from: B, to: C, count: 9 }],
  };
  const s = useGraph.getState();
  act(() => qc.setQueryData(graphQueryKey({ centers: s.centers, filter: s.filter, sort: s.sort }), data));
  const kv = await screen.findByTestId("node-kv");
  await waitFor(() => expect(within(kv).getByText("Transactions").nextElementSibling).toHaveTextContent("9"));
  expect(within(kv).getByText("Neighbours").nextElementSibling).toHaveTextContent("2");
});

test("copy writes the full address and shows a check", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  renderDetail(undefined, wallet);
  fireEvent.click(await screen.findByRole("button", { name: "Copy" }));
  expect(writeText).toHaveBeenCalledWith(A);
  await screen.findByRole("button", { name: "Copied" });
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
});

test("free-text key/value cells carry the full value as title (they ellipsize in the panel)", async () => {
  const ens = "the-quick-brown-fox-jumps-over-lazys.eth";
  renderDetail(undefined, { ...profile, node: { ...profile.node, ens, contract_name: "AVeryLongContractNameThatWillNotFit" } });
  const kv = await screen.findByTestId("node-kv");
  expect(within(kv).getByText(ens)).toHaveAttribute("title", ens);
  expect(within(kv).getByText("AVeryLongContractNameThatWillNotFit")).toHaveAttribute("title", "AVeryLongContractNameThatWillNotFit");
});
