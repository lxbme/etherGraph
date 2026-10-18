import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api/endpoints";
import type { AddressProfileDto } from "../api/generated/AddressProfileDto";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import type { LabelDto } from "../api/generated/LabelDto";
import { qk } from "../api/queryClient";
import { pairKey, useGraph } from "../graph/store";
import { useLocale } from "../i18n";
import { DetailPanel } from "./DetailPanel";
import { useUi } from "./uiStore";

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);

const profile = (labels: LabelDto[] = [], over: Partial<AddressProfileDto> = {}): AddressProfileDto => ({
  node: {
    address: A, kind: "contract", display_name: "Foo", ens: null, contract_name: "FooPool", labels,
    partial: true, syncing: false, synced: false, hot: false, identified: true, nonce: null, balance: null,
  },
  is_proxy: false, implementation: null, creator: null, creation_tx: null,
  coverage: [
    { kind: "native", from_block: 100, to_block: 200, truncated: true, state: "ok", last_synced_at: null },
    { kind: "erc20", from_block: null, to_block: null, truncated: false, state: "syncing", last_synced_at: null },
  ],
  first_seen: null, last_seen: null, ...over,
});

let qc: QueryClient;
function renderPanel() {
  return render(
    <QueryClientProvider client={qc}>
      <DetailPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useGraph.getState().reset();
  useUi.setState({ labelEditorFor: null });
});
afterEach(() => vi.restoreAllMocks());

test("nothing selected shows the hint", () => {
  renderPanel();
  expect(screen.getByText("Select a node or edge to see details")).toBeInTheDocument();
});

test("node detail shows coverage per kind with a neutral partial-sync marker", async () => {
  const spy = vi.spyOn(api, "address").mockResolvedValue(profile());
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  renderPanel();
  expect(await screen.findByText("FooPool")).toBeInTheDocument();
  expect(spy).toHaveBeenCalledWith(A);
  const why = "Too many records: Native transfers only synced from block 100";
  const top = within(screen.getByTestId("node-tags")).getByText("Partial sync");
  expect(top).toHaveClass("tag", "tag--neutral");
  expect(top).not.toHaveClass("tag--warn");
  expect(top).toHaveAttribute("title", why);
  const native = screen.getByText("Native transfers").closest("li")!;
  expect(within(native).getByText("100 – 200")).toBeInTheDocument();
  const tag = within(native).getByText("Partial sync");
  expect(tag).toHaveClass("tag", "tag--neutral");
  expect(tag).toHaveAttribute("title", why);
  expect(within(native).getByText("Synced")).toBeInTheDocument();
  const erc20 = screen.getByText("ERC20").closest("li")!;
  expect(within(erc20).getByText("Syncing")).toBeInTheDocument();
  expect(within(erc20).queryByText("Partial sync")).toBeNull();
  expect(screen.queryByText("Truncated")).toBeNull();
  expect(within(screen.getByText("ERC721").closest("li")!).getByText("Not synced")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Fetch older records" })).toBeInTheDocument();
});

test("the partial-sync marker and its reason are translated", async () => {
  vi.spyOn(api, "address").mockResolvedValue(profile());
  act(() => useLocale.getState().setLocale("zh"));
  try {
    act(() => useGraph.getState().select({ kind: "node", address: A }));
    renderPanel();
    await screen.findByText("FooPool");
    const tags = screen.getAllByText("部分同步");
    expect(tags).toHaveLength(2);
    for (const tag of tags) expect(tag).toHaveAttribute("title", "记录过多：普通转账 只同步了区块 100 之后的部分");
  } finally {
    act(() => useLocale.getState().setLocale("en"));
  }
});

test("sync buttons call api.sync", async () => {
  vi.spyOn(api, "address").mockResolvedValue(profile());
  const sync = vi.spyOn(api, "sync").mockResolvedValue({
    estimated_calls: null, estimated_seconds: null, per_address: null, jobs: [1],
  });
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  renderPanel();
  fireEvent.click(await screen.findByRole("button", { name: "Sync / refresh" }));
  await waitFor(() => expect(sync).toHaveBeenCalledWith({ addresses: [A] }));
  fireEvent.click(screen.getByRole("button", { name: "Fetch older records" }));
  await waitFor(() => expect(sync).toHaveBeenLastCalledWith({ addresses: [A], direction: "older" }));
});

test("imported labels have no delete button; user labels do", async () => {
  vi.spyOn(api, "address").mockResolvedValue(
    profile([
      { id: 1, text: "Binance 14", category: "cex", source: "import:etherscan-labels" },
      { id: 2, text: "mine", category: "other", source: "user" },
    ]),
  );
  const del = vi.spyOn(api, "deleteLabel").mockResolvedValue(undefined as never);
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  renderPanel();
  const imported = (await screen.findByText("Binance 14")).closest(".tag")!;
  expect(within(imported as HTMLElement).queryByRole("button")).toBeNull();
  expect(imported).toHaveAttribute("title", "CEX · Source: etherscan-labels");
  const user = screen.getByText("mine").closest(".tag") as HTMLElement;
  fireEvent.click(within(user).getByRole("button", { name: "Delete label" }));
  await waitFor(() => expect(del).toHaveBeenCalledWith(2));
});

test("note commits on blur only when changed", async () => {
  vi.spyOn(api, "address").mockResolvedValue(profile());
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  renderPanel();
  const box = await screen.findByLabelText("Note");
  fireEvent.focus(box);
  fireEvent.blur(box);
  expect(useGraph.getState().canUndo()).toBe(false);
  fireEvent.change(box, { target: { value: "hello" } });
  fireEvent.change(box, { target: { value: "hello!" } });
  expect(useGraph.getState().ui[A]?.note ?? "").toBe("");
  fireEvent.blur(box);
  expect(useGraph.getState().ui[A]?.note).toBe("hello!");
  expect(useGraph.getState()._past).toHaveLength(1);
});

test("label editor enforces 64 characters counting code points", async () => {
  vi.spyOn(api, "address").mockResolvedValue(profile());
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  act(() => useUi.getState().openLabelEditor(A));
  renderPanel();
  const input = await screen.findByLabelText("Label text");
  const submit = screen.getByRole("button", { name: "Add" });
  expect(submit).toBeDisabled();
  fireEvent.change(input, { target: { value: "é".repeat(64) } });
  expect(screen.getByText("64/64")).toBeInTheDocument();
  expect(submit).toBeEnabled();
  fireEvent.change(input, { target: { value: "é".repeat(65) } });
  expect(screen.getByText("65/64")).toBeInTheDocument();
  expect(submit).toBeDisabled();
  fireEvent.change(input, { target: { value: "   " } });
  expect(submit).toBeDisabled();
  // Astral code points count once.
  fireEvent.change(input, { target: { value: "😀".repeat(64) } });
  expect(submit).toBeEnabled();
});

test("adding a label invalidates address and graph queries", async () => {
  vi.spyOn(api, "address").mockResolvedValue(profile());
  const add = vi.spyOn(api, "addLabel").mockResolvedValue({ id: 9, text: "x", category: "defi", source: "user" });
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  act(() => useUi.getState().openLabelEditor(A));
  renderPanel();
  qc.setQueryData(qk.graph([A], {}), { nodes: [], edges: [], omitted: {}, coverage: {} });
  const inv = vi.spyOn(qc, "invalidateQueries");
  fireEvent.change(await screen.findByLabelText("Label text"), { target: { value: " x " } });
  fireEvent.change(screen.getByLabelText("Category"), { target: { value: "defi" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(add).toHaveBeenCalledWith({ address: A, text: "x", category: "defi" }));
  await waitFor(() => {
    const keys = inv.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(qk.address(A)));
    expect(keys).toContain(JSON.stringify(["graph"]));
  });
  await waitFor(() => expect(useUi.getState().labelEditorFor).toBeNull());
});

test("edge detail toggles the pair expansion", async () => {
  const data: GraphResponseDto = {
    nodes: [],
    edges: [
      { from: A, to: B, asset: null, asset_kind: "native", count: 3, sum: "1500000000000000000", first_ts: "", last_ts: "", decimals: 18, symbol: "ETH", trust: { level: "listed", impersonates: null, reason: null } },
      { from: B, to: A, asset: "0x" + "cc".repeat(20), asset_kind: "erc20", count: 1, sum: "2000000", first_ts: "", last_ts: "", decimals: 6, symbol: "USDC", trust: { level: "listed", impersonates: null, reason: null } },
    ],
    omitted: {}, coverage: {},
  };
  vi.spyOn(api, "graphEdges").mockResolvedValue(data);
  act(() => {
    useGraph.getState().addCenter(A);
    useGraph.getState().select({ kind: "pair", a: A, b: B });
  });
  renderPanel();
  const eth = (await screen.findByText("ETH")).closest("tr")!;
  expect(within(eth).getByText("A → B")).toBeInTheDocument();
  expect(within(eth).getByText("3")).toBeInTheDocument();
  expect(within(eth).getByText("1.500000")).toHaveAttribute("title", "1.5");
  const usdc = screen.getByText("USDC").closest("tr")!;
  expect(within(usdc).getByText("B → A")).toBeInTheDocument();
  expect(within(usdc).getByText("2.0000")).toHaveClass("num"); // an unlisted token: erc20 class, 4 places
  fireEvent.click(screen.getByRole("button", { name: "Expand parallel edges" }));
  expect(useGraph.getState().expandedPairs.has(pairKey(A, B))).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Collapse parallel edges" }));
  expect(useGraph.getState().expandedPairs.size).toBe(0);
});
