import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MockInstance } from "vitest";
import { api } from "../../api/endpoints";
import type { CounterpartyPageDto } from "../../api/generated/CounterpartyPageDto";
import type { EdgeDto } from "../../api/generated/EdgeDto";
import type { GraphRequestDto } from "../../api/generated/GraphRequestDto";
import type { GraphResponseDto } from "../../api/generated/GraphResponseDto";
import type { NodeSummaryDto } from "../../api/generated/NodeSummaryDto";
import type { TrustDto } from "../../api/generated/TrustDto";
import { useCanvasMetrics } from "../../graph/canvasMetrics";
import { firstBatchFor, useGraph } from "../../graph/store";
import { useGraphData } from "../../graph/useGraphData";
import { clearToasts, Toasts } from "../../shell/Toasts";
import { useJobProgress, useQuota } from "../../shell/statusStore";
import { PickHost } from "./PickHost";
import { usePick } from "./pickStore";

const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const TOKEN = "0x" + "d".repeat(40);
const node = (n: number, o: Partial<NodeSummaryDto> = {}): NodeSummaryDto => ({
  address: addr(n), kind: "eoa", display_name: null, ens: null, contract_name: null, labels: [],
  partial: false, syncing: false, synced: true, hot: false, identified: true, nonce: null, balance: null, ...o,
});
/** A token other than the default scam USDT. */
interface Tok {
  address: string;
  symbol: string;
  trust: TrustDto;
}
const SCAM_USDT: Tok = { address: TOKEN, symbol: "USDT", trust: { level: "scam", impersonates: null, reason: "spam-token" } };
const edge = (from: number, to: number, count = 1, token: boolean | Tok = false): EdgeDto => {
  const tok = token === true ? SCAM_USDT : token || null;
  return {
    from: addr(from), to: addr(to), asset: tok?.address ?? null, asset_kind: tok ? "erc20" : "native", count, sum: "1",
    first_ts: "2024-01-01T00:00:00Z", last_ts: "2024-01-01T00:00:00Z", decimals: 18, symbol: tok?.symbol ?? "ETH",
    trust: tok?.trust ?? { level: "listed", impersonates: null, reason: null },
  };
};

/** A neighbour in the world: its number, and optionally a name, an ENS name or a token transfer instead of ETH. */
interface Nb {
  n: number;
  name?: string;
  ens?: string;
  token?: boolean | Tok;
}
/** Each center's neighbours in rank order (busiest first). */
let world: Record<number, Nb[]>;
/** The canvas (the non-dry-run graph result). */
let canvas: GraphResponseDto;

/** Like the server: preferred neighbours first and always shown, then the top `limit` of the rest; omitted beyond. */
function dryRun(req: GraphRequestDto): GraphResponseDto {
  const nodes: NodeSummaryDto[] = [];
  const edges: EdgeDto[] = [];
  const omitted: Record<string, number> = {};
  const pref = new Set(req.prefer ?? []);
  for (const a of req.addresses) {
    const c = parseInt(a, 16);
    const limit = req.limits?.[a] ?? 200;
    const all = world[c] ?? [];
    const ordered = [...all.filter((x) => pref.has(addr(x.n))), ...all.filter((x) => !pref.has(addr(x.n)))];
    const shown = ordered.filter((x, i) => i < limit || pref.has(addr(x.n)));
    if (all.length > shown.length) omitted[a] = all.length - shown.length;
    nodes.push(node(c), ...shown.map((x) => node(x.n, { display_name: x.name ?? null, ens: x.ens ?? null })));
    edges.push(...shown.map((x) => edge(c, x.n, 5000 - all.indexOf(x), x.token)));
  }
  return { nodes, edges, omitted, coverage: {} };
}

let sync: MockInstance<typeof api.sync>;
let K: number;

beforeEach(() => {
  clearToasts();
  usePick.getState().close();
  useGraph.getState().reset();
  // 384 x 384 at 96 px per node: capacity 16, one shown → a first batch of 14 for one center.
  useCanvasMetrics.setState({ width: 384, height: 384, visible: 1 });
  useQuota.setState({ quota: { used: 100, limit: 5000, paused: false, server_paused: false, reset_at: "" } });
  K = firstBatchFor(1);
  world = {};
  canvas = { nodes: [], edges: [], omitted: {}, coverage: {} };
  vi.spyOn(api, "graphEdges").mockImplementation(async (req) => (req.dry_run ? dryRun(req) : canvas));
  vi.spyOn(api, "counterparties").mockImplementation(
    async (a) => ({ items: [], total: (world[parseInt(a, 16)] ?? []).length }) satisfies CounterpartyPageDto,
  );
  sync = vi.spyOn(api, "sync").mockResolvedValue({ estimated_calls: null, estimated_seconds: null, per_address: null, jobs: [1] });
});
afterEach(() => vi.restoreAllMocks());

let qc: QueryClient;
function mount(targets: number[]) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <PickHost />
      <Toasts />
    </QueryClientProvider>,
  );
  act(() => usePick.getState().open(targets.map(addr)));
}

/** A new center C (picked with none) on the canvas alone. */
function newCenter(c: number, o: Partial<NodeSummaryDto> = {}) {
  useGraph.getState().addCenter(addr(c));
  canvas = { ...canvas, nodes: [...canvas.nodes, node(c, o)] };
}

const nbs = (from: number, count: number): Nb[] => Array.from({ length: count }, (_, i) => ({ n: from + i }));
/** The checkbox of neighbour `n` (in any group: the first). */
const box = (n: number) => screen.getAllByTitle(addr(n))[0]!.closest("label")!.querySelector("input")!;
const confirmBtn = () => screen.getByRole("button", { name: /^Expand \d+ checked$/ });
const closed = () => usePick.getState().targets === null;

const C0 = 1;
const C1 = 2;
const C9 = 9;
const X = 50;

test("default_checks_are_the_top_k", async () => {
  expect(K).toBe(14);
  newCenter(C0);
  world[C0] = nbs(100, K + 3);
  mount([C0]);
  await waitFor(() => expect(box(100).checked).toBe(true));
  for (let i = 0; i < K + 3; i++) expect(box(100 + i).checked).toBe(i < K);
  expect(screen.getByText(`${K} checked · about +${K} nodes · 0 calls`)).toBeInTheDocument();
  expect(screen.getByText(`${K + 3} neighbours · 0 on the canvas`)).toBeInTheDocument();
  expect(confirmBtn()).toHaveTextContent(`Expand ${K} checked`);
});

test("confirm_applies_only_checked", async () => {
  newCenter(C0);
  world[C0] = nbs(100, 5);
  mount([C0]);
  await waitFor(() => expect(box(104).checked).toBe(true));
  fireEvent.click(box(100));
  fireEvent.click(box(102));
  fireEvent.click(box(104));
  expect(confirmBtn()).toHaveTextContent("Expand 2 checked");
  const steps = useGraph.getState()._past.length;
  fireEvent.click(confirmBtn());
  expect(useGraph.getState().picks[addr(C0)]).toEqual([addr(101), addr(103)]);
  expect(useGraph.getState()._past.length).toBe(steps + 1);
  expect(closed()).toBe(true);
  expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
});

test("a legacy center's first pick hides the shown neighbours left unchecked", async () => {
  useGraph.getState().loadSnapshot({ centers: [addr(C0)], filter: {}, expandedPairs: [], ui: {}, limits: { [addr(C0)]: 3 } });
  canvas = {
    nodes: [node(C0), node(100), node(101), node(102)],
    edges: [edge(C0, 100), edge(C0, 101), edge(C0, 102)],
    omitted: {},
    coverage: {},
  };
  world[C0] = nbs(100, 4);
  mount([C0]);
  await waitFor(() => expect(box(103).checked).toBe(true));
  fireEvent.click(box(101));
  fireEvent.click(confirmBtn());
  const s = useGraph.getState();
  expect(s.picks[addr(C0)]).toEqual([100, 102, 103].map(addr));
  expect(s.ui[addr(101)]?.hidden).toBe(true);
  expect(s.ui[addr(100)]?.hidden ?? false).toBe(false);
});

test("locked_rows_are_checked_and_disabled", async () => {
  // X is on the canvas because of C9.
  useGraph.getState().loadSnapshot({
    centers: [addr(C0), addr(C9)],
    filter: {},
    expandedPairs: [],
    ui: {},
    picks: { [addr(C0)]: [], [addr(C9)]: [addr(X)] },
  });
  canvas = { nodes: [node(C0), node(C9), node(X)], edges: [edge(C9, X)], omitted: {}, coverage: {} };
  world[C0] = [{ n: 100 }, { n: X }];
  mount([C0]);
  await waitFor(() => expect(box(100).checked).toBe(true));
  expect(box(X)).toBeChecked();
  expect(box(X)).toBeDisabled();
  const row = box(X).closest("label")!;
  expect(within(row as HTMLElement).getByText("On canvas")).toBeInTheDocument();
  expect(within(box(100).closest("label") as HTMLElement).queryByText("On canvas")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Select none" }));
  expect(box(100)).not.toBeChecked();
  expect(box(X)).toBeChecked();
  expect(screen.getByText("1 checked · about +0 nodes · 0 calls")).toBeInTheDocument();
  fireEvent.click(confirmBtn());
  expect(useGraph.getState().picks[addr(C0)]).toEqual([addr(X)]);
});

test("search_and_asset_filter_narrow_rows_without_unchecking", async () => {
  newCenter(C0);
  world[C0] = [
    { n: 100, name: "Binance 15" },
    { n: 101, ens: "vitalik.eth" },
    { n: 102, token: true },
    { n: 0xabcdef },
    { n: 104, token: true },
  ];
  mount([C0]);
  await waitFor(() => expect(box(104).checked).toBe(true));
  const search = screen.getByRole("searchbox", { name: "Search name, ENS or address" });
  fireEvent.change(search, { target: { value: "binance" } });
  expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  expect(box(100)).toBeChecked();
  fireEvent.change(search, { target: { value: "VITALIK" } });
  expect(screen.getAllByRole("checkbox").map((b) => b.closest("label")!.querySelector("[title]")!.getAttribute("title"))).toEqual([addr(101)]);
  fireEvent.change(search, { target: { value: "abcdef" } });
  expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  expect(box(0xabcdef)).toBeInTheDocument();
  fireEvent.change(search, { target: { value: "" } });
  expect(screen.getAllByRole("checkbox")).toHaveLength(5);
  // Unchecked while all are listed: stays unchecked under the asset filter.
  fireEvent.click(box(102));
  const assets = screen.getByRole("combobox", { name: "Assets" });
  fireEvent.change(assets, { target: { value: TOKEN } });
  expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  expect(box(102)).not.toBeChecked();
  expect(box(104)).toBeChecked();
  // The scam token's badge shows next to its symbol.
  expect(within(box(104).closest("label") as HTMLElement).getByText("USDT")).toBeInTheDocument();
  expect(within(box(104).closest("label") as HTMLElement).getByText("Known scam")).toBeInTheDocument();
  // The hidden rows keep their checks.
  expect(screen.getByText("4 checked · about +4 nodes · 0 calls")).toBeInTheDocument();
  fireEvent.change(assets, { target: { value: "" } });
  expect(screen.getAllByRole("checkbox")).toHaveLength(5);
  expect(box(100)).toBeChecked();
});

test("the asset filter puts tokens on a token list first and every other token after, each with its contract", async () => {
  const REAL_USDT: Tok = { address: "0xdac17f958d2ee523a2206206994597c13d831ec7", symbol: "USDT", trust: { level: "listed", impersonates: null, reason: null } };
  const FAKE_USDC: Tok = {
    address: "0x" + "e".repeat(40),
    symbol: "USDC",
    trust: { level: "suspicious", impersonates: { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", name: "USD Coin" }, reason: null },
  };
  const ODD: Tok = { address: "0x" + "f".repeat(40), symbol: "ABC", trust: { level: "unknown", impersonates: null, reason: null } };
  const SAME_NAME: Tok = { address: "0x" + "a".repeat(40), symbol: "USDT", trust: { level: "unknown", impersonates: null, reason: null } };
  world = { 1: [{ n: 100, token: true }, { n: 101, token: FAKE_USDC }, { n: 102, token: ODD }, { n: 103, token: REAL_USDT }, { n: 104 }, { n: 105, token: SAME_NAME }] };
  newCenter(1);
  mount([1]);
  await waitFor(() => expect(box(104)).toBeInTheDocument());
  const select = screen.getByRole("combobox", { name: "Assets" });
  const text = (o: HTMLOptionElement) => o.textContent;
  // Tokens on a token list (the native coin first), then every other token: unknown ones, then the flagged ones.
  const options = within(select).getAllByRole("option") as HTMLOptionElement[];
  expect(options.map(text)).toEqual([
    "All assets", "ETH", "USDT · 0xdac1…1ec7",
    "ABC · 0xffff…ffff", "USDT · 0xaaaa…aaaa",
    "⚠ USDC · 0xeeee…eeee · Possible impersonation", "⚠ USDT · 0xdddd…dddd · Known scam",
  ]);
  const values = (name: string) =>
    within(within(select).getByRole("group", { name })).getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
  expect(values("On token lists (2)")).toEqual(["native", REAL_USDT.address]);
  expect(values("Other tokens (4)")).toEqual([ODD.address, SAME_NAME.address, FAKE_USDC.address, TOKEN]);
  expect(within(select).queryByRole("group", { name: /Possible impersonations/ })).toBeNull();
  // Each picks only its own contract: the real USDT is not the fake one.
  fireEvent.change(select, { target: { value: REAL_USDT.address } });
  expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  expect(box(103)).toBeInTheDocument();
  fireEvent.change(select, { target: { value: TOKEN } });
  expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  expect(box(100)).toBeInTheDocument();
  fireEvent.change(select, { target: { value: SAME_NAME.address } });
  expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  expect(box(105)).toBeInTheDocument();
});

test("with no listed token among the neighbours the picker shows no empty listed group", async () => {
  world = { 1: [{ n: 100, token: true }, { n: 101, token: true }] };
  newCenter(1);
  mount([1]);
  await waitFor(() => expect(box(100)).toBeInTheDocument());
  const select = screen.getByRole("combobox", { name: "Assets" });
  expect(within(select).queryByRole("group", { name: /On token lists/ })).toBeNull();
  const group = within(select).getByRole("group", { name: "Other tokens (1)" });
  expect(within(group).getAllByRole("option").map((o) => (o as HTMLOptionElement).value)).toEqual([TOKEN]);
});

test("sort by recent reorders the rows; the graph's sort is the default", async () => {
  newCenter(C0);
  world[C0] = nbs(100, 3);
  mount([C0]);
  await waitFor(() => expect(box(102).checked).toBe(true));
  const sort = screen.getByRole("combobox", { name: "Sort" }) as HTMLSelectElement;
  expect(sort.value).toBe("count");
  expect([...sort.options].map((o) => o.value)).toEqual(["count", "recent"]);
});

test("k_rechecks_and_reset_restores", async () => {
  newCenter(C0);
  world[C0] = nbs(100, 8);
  mount([C0]);
  await waitFor(() => expect(box(107).checked).toBe(true));
  fireEvent.click(box(100));
  const k = screen.getByRole("spinbutton", { name: /Check the top/ }) as HTMLInputElement;
  expect(k.value).toBe(String(K));
  fireEvent.change(k, { target: { value: "2" } });
  await waitFor(() => expect(box(102).checked).toBe(false));
  // Replaces the manual checks: 100 is checked again.
  expect([...Array(8).keys()].map((i) => box(100 + i).checked)).toEqual([true, true, false, false, false, false, false, false]);
  fireEvent.click(box(105));
  fireEvent.click(screen.getByRole("button", { name: "Restore default checks" }));
  expect(k.value).toBe(String(K));
  expect([...Array(8).keys()].every((i) => box(100 + i).checked)).toBe(true);
});

test("unsynced_single_target_is_a_sync_confirm", async () => {
  newCenter(C0, { synced: false });
  mount([C0]);
  expect(await screen.findByText("Sync first to list its neighbours (about 6 calls)")).toBeInTheDocument();
  expect(screen.getByText("4,900 calls left today")).toBeInTheDocument();
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  expect(closed()).toBe(true);
  expect(sync).not.toHaveBeenCalled();

  act(() => usePick.getState().open([addr(C0)]));
  fireEvent.click(await screen.findByRole("button", { name: "Sync" }));
  expect(sync).toHaveBeenCalledTimes(1);
  expect(sync).toHaveBeenCalledWith({ addresses: [addr(C0)], depth: "shallow", batch: expect.any(String) });
  expect(await screen.findByText("Syncing…")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Sync" })).toBeNull();
  expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
});

test("group_fills_after_sync", async () => {
  newCenter(C0, { synced: false });
  world[C0] = nbs(100, 3);
  mount([C0]);
  fireEvent.click(await screen.findByRole("button", { name: "Sync" }));
  canvas = { ...canvas, nodes: [node(C0, { synced: false, syncing: true })] };
  await act(() => qc.invalidateQueries());
  expect(await screen.findByText("Syncing…")).toBeInTheDocument();
  canvas = { ...canvas, nodes: [node(C0)] };
  await act(() => qc.invalidateQueries());
  await waitFor(() => expect(box(102).checked).toBe(true));
  expect(box(100)).toBeChecked();
  expect(confirmBtn()).toHaveTextContent("Expand 3 checked");
});

test("summary_counts_new_nodes_once_across_groups", async () => {
  useGraph.getState().loadSnapshot({
    centers: [addr(C0), addr(C1), addr(C9)],
    filter: {},
    expandedPairs: [],
    ui: {},
    picks: { [addr(C0)]: [], [addr(C1)]: [], [addr(C9)]: [addr(X)] },
  });
  canvas = { nodes: [node(C0), node(C1), node(C9), node(X)], edges: [edge(C9, X)], omitted: {}, coverage: {} };
  const S = 300;
  world[C0] = [{ n: X }, { n: S }, { n: 201 }];
  world[C1] = [{ n: S }, { n: 202 }];
  mount([C0, C1]);
  await waitFor(() => expect(screen.getByText("5 checked · about +3 nodes · 0 calls")).toBeInTheDocument());
  expect(screen.getByRole("heading", { name: "Expand 2 addresses" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: `${addr(C0).slice(0, 6)}…${addr(C0).slice(-4)} · 3 total · 3 checked` })).toBeInTheDocument();
  // S in one group only: still a new node.
  fireEvent.click(screen.getAllByTitle(addr(S))[1]!.closest("label")!.querySelector("input")!);
  expect(screen.getByText("4 checked · about +3 nodes · 0 calls")).toBeInTheDocument();
  fireEvent.click(confirmBtn());
  expect(useGraph.getState().picks).toMatchObject({ [addr(C0)]: [X, S, 201].map(addr), [addr(C1)]: [addr(202)] });
});

test("thousand_rows_render_windowed_with_cap_note", async () => {
  newCenter(C0);
  world[C0] = nbs(1000, 1050);
  mount([C0]);
  expect(await screen.findByText("Listing the first 1000 in the current order")).toBeInTheDocument();
  await waitFor(() => expect(box(1000).checked).toBe(true));
  expect(screen.getAllByRole("checkbox").length).toBeLessThan(300);
  expect(screen.getByText("1,000 neighbours · 0 on the canvas")).toBeInTheDocument();
  expect(screen.getByText(`${K} checked · about +${K} nodes · 0 calls`)).toBeInTheDocument();
  expect(confirmBtn()).toBeEnabled();
  // Scrolled to the end: the last rows are rendered.
  const list = screen.getByRole("group", { name: "Neighbours" });
  fireEvent.scroll(list, { target: { scrollTop: 999 * 44 } });
  expect(box(1999)).not.toBeChecked();
  expect(screen.getAllByRole("checkbox").length).toBeLessThan(300);
});

test("rows_toggle_with_space_and_no_hidden_focus", async () => {
  const user = userEvent.setup();
  newCenter(C0);
  newCenter(C1);
  world[C0] = nbs(100, 2);
  world[C1] = nbs(200, 2);
  mount([C0, C1]);
  await waitFor(() => expect(box(201).checked).toBe(true));
  box(100).focus();
  await user.keyboard(" ");
  expect(box(100)).not.toBeChecked();
  await user.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(box(101));
  await user.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(box(200));
  await user.keyboard("{ArrowUp}");
  expect(document.activeElement).toBe(box(101));
  // A collapsed group's rows leave the page: nothing hidden can take focus.
  const head = screen.getByRole("button", { name: /0x0000…0001 ·/ });
  expect(head).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(head);
  expect(head).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryAllByTitle(addr(100))).toHaveLength(0);
  const seen = new Set<Element>();
  for (let i = 0; i < 30; i++) {
    await user.tab();
    const el = document.activeElement!;
    seen.add(el);
    expect(el.closest("[hidden]")).toBeNull();
  }
  expect(seen.has(box(200))).toBe(true);
  // Unchecks stay while collapsed.
  fireEvent.click(head);
  expect(box(100)).not.toBeChecked();
});

test("picks_hidden_by_filter_are_kept", async () => {
  const H = 400;
  useGraph.getState().loadSnapshot({
    centers: [addr(C0)],
    filter: {},
    expandedPairs: [],
    ui: {},
    picks: { [addr(C0)]: [addr(100), addr(H)] },
  });
  canvas = { nodes: [node(C0), node(100)], edges: [edge(C0, 100)], omitted: {}, coverage: {} };
  // H is not listed: the graph's filter leaves its transfers out.
  world[C0] = nbs(100, 2);
  mount([C0]);
  await waitFor(() => expect(box(100).checked).toBe(true));
  expect(box(101)).not.toBeChecked();
  fireEvent.click(box(101));
  fireEvent.click(confirmBtn());
  expect([...useGraph.getState().picks[addr(C0)]!].sort()).toEqual([100, 101, H].map(addr).sort());
});

test("confirm at zero checked is disabled unless the center has picks to clear", async () => {
  newCenter(C0);
  world[C0] = nbs(100, 2);
  mount([C0]);
  await waitFor(() => expect(box(101).checked).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Select none" }));
  expect(confirmBtn()).toHaveTextContent("Expand 0 checked");
  expect(confirmBtn()).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(closed()).toBe(true);

  act(() => useGraph.getState().applyPicks({ [addr(C0)]: [addr(100)] }));
  canvas = { nodes: [node(C0), node(100)], edges: [edge(C0, 100)], omitted: {}, coverage: {} };
  act(() => usePick.getState().open([addr(C0)]));
  await waitFor(() => expect(box(100).checked).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Select none" }));
  expect(confirmBtn()).toBeEnabled();
  fireEvent.click(confirmBtn());
  expect(useGraph.getState().picks[addr(C0)]).toEqual([]);
  expect(useGraph.getState().ui[addr(100)]?.hidden).toBe(true);
});

test("more than MAX_CENTERS centers after it blocks", async () => {
  const others = Array.from({ length: 50 }, (_, i) => addr(500 + i));
  useGraph.getState().setCenters(others);
  const T = 7;
  canvas = { nodes: [node(T)], edges: [], omitted: {}, coverage: {} };
  world[T] = nbs(100, 2);
  mount([T]);
  expect(await screen.findByRole("alert")).toHaveTextContent("Centers would exceed 50 (51 after expanding)");
  await waitFor(() => expect(box(101).checked).toBe(true));
  expect(confirmBtn()).toBeDisabled();
});

test("a snapshot asks to go live before the picker opens", () => {
  useGraph.getState().freeze({
    exported_at: "2026-10-01T12:00:00Z",
    includes: { labels: false, notes: false },
    data: { nodes: [], edges: [], omitted: {}, coverage: {} },
  });
  usePick.getState().open([addr(C0)]);
  expect(usePick.getState().targets).toBeNull();
  expect(useGraph.getState().pendingLive).not.toBeNull();
  useGraph.getState().resolveLive(true);
  expect(usePick.getState().targets).toEqual([addr(C0)]);
});

test("a synced target shows when it was last synced and refreshes on a click", async () => {
  newCenter(C0);
  world[C0] = nbs(100, 1);
  const at = new Date(Date.now() - 3 * 86_400_000).toISOString();
  canvas = { ...canvas, coverage: { [addr(C0)]: [{ kind: "native", from_block: null, to_block: null, truncated: false, state: "ok", last_synced_at: at }] } };
  mount([C0]);
  expect(await screen.findByText("Last synced: 3 days ago")).toBeInTheDocument();
  expect(screen.getByText("about 6 calls · 4,900 calls left today")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(sync).toHaveBeenCalledWith({ addresses: [addr(C0)], depth: "shallow", batch: expect.any(String) });
  expect(await screen.findByText("Syncing…")).toBeInTheDocument();
});

test("the filter note counts the counterparties the graph's filter hides", async () => {
  newCenter(C0);
  world[C0] = nbs(100, 2);
  vi.mocked(api.counterparties).mockResolvedValue({ items: [], total: 9 });
  mount([C0]);
  expect(await screen.findByText("The current filter hides 7 neighbours")).toBeInTheDocument();
});

test("a legacy center showing neighbours can be cleared to none as well", async () => {
  useGraph.getState().loadSnapshot({ centers: [addr(C0)], filter: {}, expandedPairs: [], ui: {}, limits: { [addr(C0)]: 3 } });
  canvas = { nodes: [node(C0), node(100)], edges: [edge(C0, 100)], omitted: {}, coverage: {} };
  world[C0] = nbs(100, 2);
  mount([C0]);
  await waitFor(() => expect(box(101).checked).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Select none" }));
  expect(confirmBtn()).toBeEnabled();
  fireEvent.click(confirmBtn());
  expect(useGraph.getState().picks[addr(C0)]).toEqual([]);
  expect(useGraph.getState().ui[addr(100)]?.hidden).toBe(true);
});

test("a target just put on the graph: the picker waits for the canvas to show it (no sync question for a synced one)", async () => {
  newCenter(C1);
  world[C0] = nbs(100, 3);
  // The canvas: shows C1 and keeps showing it while a new graph request loads.
  function Canvas() {
    const { data } = useGraphData();
    return <div data-testid="canvas">{data?.nodes.map((n) => n.address).join(",")}</div>;
  }
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Canvas />
      <PickHost />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("canvas")).toHaveTextContent(addr(C1)));
  // The canvas request with C0 answers only when released.
  let release!: () => void;
  vi.mocked(api.graphEdges).mockImplementation(async (req) => {
    if (req.dry_run) return dryRun(req);
    if (!req.addresses.includes(addr(C0))) return canvas;
    await new Promise<void>((r) => (release = r));
    return canvas;
  });
  act(() => {
    useGraph.getState().revealCenter(addr(C0));
    usePick.getState().open([addr(C0)]);
  });
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("Loading…")).toBeInTheDocument();
  await waitFor(() => expect(release).toBeTypeOf("function"));
  expect(screen.queryByText("Sync first to list its neighbours (about 6 calls)")).toBeNull();
  canvas = { ...canvas, nodes: [...canvas.nodes, node(C0)] };
  await act(async () => release());
  await waitFor(() => expect(box(100)).toBeInTheDocument());
  expect(screen.queryByText("Sync first to list its neighbours (about 6 calls)")).toBeNull();
  expect(sync).not.toHaveBeenCalled();
});

test("the previous canvas standing in while the target's request loads shows loading, never the sync question", async () => {
  newCenter(C1);
  world[C0] = nbs(100, 3);
  mount([C0]);
  // The canvas answered without C0 (not a center yet): loading, no sync question, no Sync button.
  const dialog = await screen.findByRole("dialog");
  await new Promise((r) => setTimeout(r, 50));
  expect(within(dialog).getByText("Loading…")).toBeInTheDocument();
  expect(screen.queryByText("Sync first to list its neighbours (about 6 calls)")).toBeNull();
  expect(screen.queryByRole("button", { name: "Sync" })).toBeNull();
  // C0 becomes a center: its canvas request answers only when released, the previous result standing in meanwhile.
  let release!: () => void;
  vi.mocked(api.graphEdges).mockImplementation(async (req) => {
    if (req.dry_run) return dryRun(req);
    if (!req.addresses.includes(addr(C0))) return canvas;
    await new Promise<void>((r) => (release = r));
    return canvas;
  });
  act(() => useGraph.getState().revealCenter(addr(C0)));
  await waitFor(() => expect(release).toBeTypeOf("function"));
  expect(within(dialog).getByText("Loading…")).toBeInTheDocument();
  expect(screen.queryByText("Sync first to list its neighbours (about 6 calls)")).toBeNull();
  expect(screen.queryByRole("button", { name: "Sync" })).toBeNull();
  canvas = { ...canvas, nodes: [...canvas.nodes, node(C0)] };
  await act(async () => release());
  await waitFor(() => expect(box(102).checked).toBe(true));
  expect(screen.queryByText("Sync first to list its neighbours (about 6 calls)")).toBeNull();
  expect(sync).not.toHaveBeenCalled();
});

test("each group's rows are one Tab stop that follows the arrow keys; Tab leaves the list for the footer", async () => {
  const user = userEvent.setup();
  newCenter(C0);
  newCenter(C1);
  world[C0] = nbs(100, 5);
  world[C1] = nbs(200, 5);
  mount([C0, C1]);
  await waitFor(() => expect(box(204).checked).toBe(true));
  const stops = () => screen.getAllByRole("checkbox").filter((b) => b.tabIndex === 0);
  // The first rendered row of each group, the others out of the Tab order.
  expect(stops()).toEqual([box(100), box(200)]);
  expect(screen.getAllByRole("checkbox").filter((b) => b.tabIndex === -1)).toHaveLength(8);
  box(100).focus();
  await user.keyboard("{ArrowDown}{ArrowDown}");
  expect(document.activeElement).toBe(box(102));
  expect(stops()).toEqual([box(102), box(200)]);
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: /^0x0000…0002 ·/ }));
  await user.tab();
  expect(document.activeElement).toBe(box(200));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Select none" }));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Restore default checks" }));
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  await user.tab();
  expect(document.activeElement).toBe(confirmBtn());
  // Back into the first group: its stop is the row focused last.
  await user.tab({ shift: true });
  await user.tab({ shift: true });
  await user.tab({ shift: true });
  await user.tab({ shift: true });
  await user.tab({ shift: true });
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(box(102));
});

test("a locked first row is not the group's Tab stop: the first row that can take focus is", async () => {
  useGraph.getState().loadSnapshot({
    centers: [addr(C0), addr(C9)],
    filter: {},
    expandedPairs: [],
    ui: {},
    picks: { [addr(C0)]: [], [addr(C9)]: [addr(X)] },
  });
  canvas = { nodes: [node(C0), node(C9), node(X)], edges: [edge(C9, X)], omitted: {}, coverage: {} };
  world[C0] = [{ n: X }, { n: 100 }, { n: 101 }];
  mount([C0]);
  await waitFor(() => expect(box(101).checked).toBe(true));
  expect(box(X)).toBeDisabled();
  expect(screen.getAllByRole("checkbox").filter((b) => b.tabIndex === 0)).toEqual([box(100)]);
});

test("the footer says the picker itself spends no call", async () => {
  newCenter(C0);
  world[C0] = nbs(100, 2);
  mount([C0]);
  expect(await screen.findByText("2 checked · about +2 nodes · 0 calls")).toBeInTheDocument();
});

test("an errored list allows no confirm: a center showing neighbours is not cleared to none", async () => {
  useGraph.getState().loadSnapshot({ centers: [addr(C0)], filter: {}, expandedPairs: [], ui: {}, limits: { [addr(C0)]: 3 } });
  canvas = { nodes: [node(C0), node(100)], edges: [edge(C0, 100)], omitted: {}, coverage: {} };
  world[C0] = nbs(100, 2);
  vi.mocked(api.graphEdges).mockImplementation(async (req) => {
    if (req.dry_run && Object.values(req.limits ?? {}).includes(1000)) throw new Error("list failed");
    return req.dry_run ? dryRun(req) : canvas;
  });
  mount([C0]);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(confirmBtn()).toBeDisabled();
  fireEvent.click(confirmBtn());
  expect(useGraph.getState().picks[addr(C0)]).toBeUndefined();
});

test("an errored top-k run allows no confirm either", async () => {
  useGraph.getState().loadSnapshot({ centers: [addr(C0)], filter: {}, expandedPairs: [], ui: {}, limits: { [addr(C0)]: 3 } });
  canvas = { nodes: [node(C0), node(100)], edges: [edge(C0, 100)], omitted: {}, coverage: {} };
  world[C0] = nbs(100, 2);
  vi.mocked(api.graphEdges).mockImplementation(async (req) => {
    if (req.dry_run && !Object.values(req.limits ?? {}).includes(1000)) throw new Error("top-k failed");
    return req.dry_run ? dryRun(req) : canvas;
  });
  mount([C0]);
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(confirmBtn()).toBeDisabled();
});

test("a sync answered with no job offers Sync again", async () => {
  newCenter(C0, { synced: false });
  sync.mockResolvedValue({ estimated_calls: null, estimated_seconds: null, per_address: null, jobs: [] });
  mount([C0]);
  fireEvent.click(await screen.findByRole("button", { name: "Sync" }));
  expect(sync).toHaveBeenCalledTimes(1);
  expect(await screen.findByRole("button", { name: "Sync" })).toBeInTheDocument();
  expect(screen.queryByText("Syncing…")).toBeNull();
});

test("a sync whose job fails before the canvas saw it syncing offers Sync again", async () => {
  newCenter(C0, { synced: false });
  sync.mockResolvedValue({ estimated_calls: null, estimated_seconds: null, per_address: null, jobs: [7] });
  mount([C0]);
  fireEvent.click(await screen.findByRole("button", { name: "Sync" }));
  expect(await screen.findByText("Syncing…")).toBeInTheDocument();
  // Another job's progress changes nothing.
  act(() => useJobProgress.getState().upsert({ type: "JobProgress", job_id: 8, kind: "sync_address", fetched: 0, cursor_block: null, status: "failed", error: "x" }));
  expect(screen.getByText("Syncing…")).toBeInTheDocument();
  act(() => useJobProgress.getState().upsert({ type: "JobProgress", job_id: 7, kind: "sync_address", fetched: 0, cursor_block: null, status: "failed", error: "x" }));
  expect(await screen.findByRole("button", { name: "Sync" })).toBeInTheDocument();
  expect(screen.queryByText("Syncing…")).toBeNull();
});

test("a sync seen running that ends without a new sync time offers Sync again", async () => {
  newCenter(C0, { synced: false });
  mount([C0]);
  fireEvent.click(await screen.findByRole("button", { name: "Sync" }));
  canvas = { ...canvas, nodes: [node(C0, { synced: false, syncing: true })] };
  await act(() => qc.invalidateQueries());
  expect(await screen.findByText("Syncing…")).toBeInTheDocument();
  canvas = { ...canvas, nodes: [node(C0, { synced: false })] };
  await act(() => qc.invalidateQueries());
  expect(await screen.findByRole("button", { name: "Sync" })).toBeInTheDocument();
  expect(screen.queryByText("Syncing…")).toBeNull();
});

test("the list is measured once it replaces the loading text: only the rows near its height render", async () => {
  const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("pick__list") ? 220 : 0;
  });
  newCenter(C0);
  world[C0] = nbs(100, 100);
  mount([C0]);
  await waitFor(() => expect(box(100).checked).toBe(true));
  // 220 px of 44 px rows and 10 overscan below: 15 rows, not the 600 px fallback's 24.
  expect(screen.getAllByRole("checkbox")).toHaveLength(15);
  height.mockRestore();
});

test("a change of k can be undone back to the checks right before it, once", async () => {
  newCenter(C0);
  world[C0] = nbs(100, 8);
  mount([C0]);
  await waitFor(() => expect(box(107).checked).toBe(true));
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  fireEvent.click(box(100));
  fireEvent.click(box(105));
  const before = [false, true, true, true, true, false, true, true];
  const k = screen.getByRole("spinbutton", { name: /Check the top/ }) as HTMLInputElement;
  // Typing "2" then "3": one change of k, undone in one step.
  fireEvent.change(k, { target: { value: "2" } });
  fireEvent.change(k, { target: { value: "3" } });
  await waitFor(() => expect(box(103).checked).toBe(false));
  expect([...Array(8).keys()].map((i) => box(100 + i).checked)).toEqual([true, true, true, false, false, false, false, false]);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(k.value).toBe(String(K));
  expect([...Array(8).keys()].map((i) => box(100 + i).checked)).toEqual(before);
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  // The undone k's run answering later changes nothing.
  await new Promise((r) => setTimeout(r, 300));
  expect([...Array(8).keys()].map((i) => box(100 + i).checked)).toEqual(before);

  // A check made after the change ends the offer: Undo would drop it.
  fireEvent.change(k, { target: { value: "2" } });
  expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  fireEvent.click(box(107));
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});
