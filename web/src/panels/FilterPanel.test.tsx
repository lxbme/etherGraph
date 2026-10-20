import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { EdgeDto } from "../api/generated/EdgeDto";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import { useAssetRegistry } from "../graph/assetRegistry";
import { useGraph } from "../graph/store";
import { graphQueryKey } from "../graph/useGraphData";
import { FilterPanel } from "./FilterPanel";

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const UNK = "0x" + "cc".repeat(20);

const edge = (o: Partial<EdgeDto>): EdgeDto => ({
  from: A, to: B, asset: null, asset_kind: "native", count: 1, sum: "1",
  first_ts: "2024-01-01T00:00:00Z", last_ts: "2024-01-02T00:00:00Z", decimals: 18, symbol: null,
  trust: { level: "listed", impersonates: null, reason: null }, ...o,
});

let qc: QueryClient;
function seed(edges: EdgeDto[]) {
  const data: GraphResponseDto = { nodes: [], edges, omitted: {}, coverage: {} };
  const s = useGraph.getState();
  qc.setQueryData(graphQueryKey(s), data);
}
function setup(edges: EdgeDto[] = [
  edge({}),
  edge({ asset: USDC, asset_kind: "erc20", decimals: 6, symbol: "USDC" }),
  edge({ asset: UNK, asset_kind: "erc20", decimals: null, symbol: "WEIRD" }),
]) {
  useGraph.getState().setCenters([A]);
  seed(edges);
  render(
    <QueryClientProvider client={qc}>
      <FilterPanel />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /Filter/ }));
}
const apply = () => screen.getByRole("button", { name: "Apply" });

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  useGraph.getState().reset();
});

test("applying builds an EdgeFilterDto with kinds, direction, time and asset thresholds", () => {
  setup();
  fireEvent.click(screen.getByLabelText("ERC20"));
  fireEvent.click(screen.getByLabelText("Native transfers"));
  fireEvent.click(screen.getByLabelText("Inbound"));
  fireEvent.change(screen.getByLabelText("Start time (local)"), { target: { value: "2024-03-01T08:00" } });
  fireEvent.click(screen.getByLabelText("USDC"));
  fireEvent.change(screen.getByLabelText("USDC min amount"), { target: { value: " 1,000.5 " } });
  fireEvent.click(screen.getByLabelText("By count"));
  fireEvent.click(apply());

  const s = useGraph.getState();
  expect(s.filter).toEqual({
    time: { from: new Date("2024-03-01T08:00").toISOString() },
    kinds: ["native", "erc20"],
    direction: "in",
    assets: [{ asset: USDC, min_amount: "1000.5" }],
  });
  expect(s.sort).toBe("count");
  expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
});

test("empty form applies an empty filter without empty arrays", () => {
  setup();
  fireEvent.click(apply());
  expect(useGraph.getState().filter).toEqual({});
});

test("invalid threshold disables apply", () => {
  setup();
  fireEvent.click(screen.getByLabelText("USDC"));
  const input = screen.getByLabelText("USDC min amount");
  for (const bad of ["1.2.3", "-5", "1.1234567"]) {
    fireEvent.change(input, { target: { value: bad } });
    expect(apply()).toBeDisabled();
    expect(input).toHaveAttribute("aria-invalid", "true");
  }
  fireEvent.change(input, { target: { value: "1.123456" } });
  expect(apply()).toBeEnabled();
});

test("unknown-decimals assets cannot take a threshold", () => {
  setup();
  fireEvent.click(screen.getByLabelText("WEIRD"));
  expect(screen.getByLabelText("WEIRD min amount")).toBeDisabled();
  expect(screen.getByText("Unknown decimals; cannot set a threshold")).toBeInTheDocument();
});

test("from after to disables apply", () => {
  setup();
  fireEvent.change(screen.getByLabelText("Start time (local)"), { target: { value: "2024-03-02T00:00" } });
  fireEvent.change(screen.getByLabelText("End time (local)"), { target: { value: "2024-03-01T00:00" } });
  expect(apply()).toBeDisabled();
  expect(screen.getByText("Start time is after end time")).toBeInTheDocument();
});

test("amount sort is disabled unless exactly one asset is selected", () => {
  setup();
  const amount = screen.getByLabelText("By amount");
  expect(amount).toBeDisabled();
  fireEvent.click(screen.getByLabelText("USDC"));
  expect(amount).toBeEnabled();
  fireEvent.click(amount);
  fireEvent.click(screen.getByLabelText("ETH"));
  expect(amount).toBeDisabled();
  fireEvent.click(apply());
  expect(useGraph.getState().sort).toBe("count");
});

test("reset clears the filter and sort", () => {
  setup();
  useGraph.getState().setFilter({ direction: "out" });
  useGraph.getState().setSort("recent");
  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(useGraph.getState().filter).toEqual({});
  expect(useGraph.getState().sort).toBe("count");
});

test("form initializes from the store and Escape / outside click close without applying", () => {
  useGraph.getState().setFilter({ kinds: ["erc721"], direction: "out", assets: [{ asset: null, min_amount: "2" }] });
  setup();
  expect(screen.getByLabelText("ERC721")).toBeChecked();
  expect(screen.getByLabelText("Outbound")).toBeChecked();
  expect(screen.getByLabelText("ETH min amount")).toHaveValue("2");
  fireEvent.click(screen.getByLabelText("ERC721"));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  expect(useGraph.getState().filter.kinds).toEqual(["erc721"]);

  fireEvent.click(screen.getByRole("button", { name: /Filter/ }));
  expect(screen.getByLabelText("ERC721")).toBeChecked();
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
});

test("filter button shows an indicator only when a filter is active", () => {
  setup();
  expect(screen.queryByTestId("filter-active")).toBeNull();
  fireEvent.click(screen.getByLabelText("Outbound"));
  fireEvent.click(apply());
  expect(screen.getByTestId("filter-active")).toBeInTheDocument();
});

test("min_amount is normalized for the backend (.5 -> 0.5, 5. -> 5)", () => {
  setup();
  fireEvent.click(screen.getByLabelText("USDC"));
  fireEvent.click(screen.getByLabelText("ETH"));
  fireEvent.change(screen.getByLabelText("USDC min amount"), { target: { value: ".5" } });
  fireEvent.change(screen.getByLabelText("ETH min amount"), { target: { value: "5." } });
  fireEvent.click(apply());
  expect(useGraph.getState().filter.assets).toEqual([
    { asset: null, min_amount: "5" },
    { asset: USDC, min_amount: "0.5" },
  ]);
});

test("assets seen earlier stay offered after a narrowing filter is applied", () => {
  const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
  useGraph.getState().setCenters([A]);
  seed([edge({ asset: USDC, asset_kind: "erc20", decimals: 6, symbol: "USDC" }), edge({ asset: USDT, asset_kind: "erc20", decimals: 6, symbol: "USDT" })]);
  useAssetRegistry.getState().merge([
    edge({ asset: USDC, asset_kind: "erc20", decimals: 6, symbol: "USDC" }),
    edge({ asset: USDT, asset_kind: "erc20", decimals: 6, symbol: "USDT" }),
  ]);
  useGraph.getState().applyFilter({ assets: [{ asset: USDC }] }, "count");
  seed([edge({ asset: USDC, asset_kind: "erc20", decimals: 6, symbol: "USDC" })]);
  render(
    <QueryClientProvider client={qc}>
      <FilterPanel />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /Filter/ }));
  expect(screen.getByLabelText("USDT")).toBeInTheDocument();
  expect(screen.getByLabelText("ETH")).toBeInTheDocument();
});

test("apply is one undo step restoring both filter and sort", () => {
  setup();
  fireEvent.click(screen.getByLabelText("Outbound"));
  fireEvent.click(screen.getByLabelText("Most recent"));
  fireEvent.click(apply());
  expect(useGraph.getState().sort).toBe("recent");
  useGraph.getState().undo();
  expect(useGraph.getState().filter).toEqual({});
  expect(useGraph.getState().sort).toBe("count");
});

test("form sort falls back to count when amount sort becomes unavailable", () => {
  setup();
  fireEvent.click(screen.getByLabelText("USDC"));
  fireEvent.click(screen.getByLabelText("By amount"));
  fireEvent.click(screen.getByLabelText("USDC"));
  expect(screen.getByLabelText("By count")).toBeChecked();
});

test("the top bar has one Filter chip whose count includes the hide-impersonations toggle", () => {
  setup();
  const chip = () => screen.getByRole("button", { name: /Filter/ });
  expect(screen.getAllByRole("button", { name: /Filter|assets/i })).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "All assets" })).toBeNull();
  expect(chip()).toHaveTextContent(/^Filter$/);
  expect(chip()).not.toHaveClass("chip--active");
  fireEvent.click(screen.getByLabelText("Outbound"));
  fireEvent.click(screen.getByLabelText("USDC"));
  fireEvent.click(apply());
  expect(chip()).toHaveTextContent("Filter · 2");
  expect(chip()).toHaveClass("chip", "chip--active");
  expect(chip().querySelector("svg.lucide")).not.toBeNull();
  fireEvent.click(chip());
  fireEvent.click(screen.getByLabelText("Hide possibly impersonating tokens"));
  fireEvent.click(apply());
  expect(chip()).toHaveTextContent("Filter · 3");
});

test("the hide-impersonations toggle is off by default and applies hide_suspicious", () => {
  setup();
  const toggle = screen.getByLabelText("Hide possibly impersonating tokens");
  expect(toggle).not.toBeChecked();
  fireEvent.click(toggle);
  fireEvent.click(apply());
  expect(useGraph.getState().filter).toEqual({ hide_suspicious: true });
  fireEvent.click(screen.getByRole("button", { name: /Filter/ }));
  expect(screen.getByLabelText("Hide possibly impersonating tokens")).toBeChecked();
  fireEvent.click(screen.getByLabelText("Hide possibly impersonating tokens"));
  fireEvent.click(apply());
  expect(useGraph.getState().filter).toEqual({});
});

test("the popover keeps Reset and Apply in a footer outside the scrolling body", () => {
  setup();
  const dialog = screen.getByRole("dialog", { name: "Filter" });
  const body = dialog.querySelector(".filter__body")!;
  const footer = dialog.querySelector(".filter__actions")!;
  expect(body).not.toBeNull();
  expect(body.contains(apply())).toBe(false);
  expect(footer.contains(apply())).toBe(true);
  expect(footer.contains(screen.getByRole("button", { name: "Reset" }))).toBe(true);
  expect(body.contains(screen.getByLabelText("USDC"))).toBe(true);
});

const listed = { level: "listed", impersonates: null, reason: null } as const;
const unknown = { level: "unknown", impersonates: null, reason: null } as const;
const FAKE_USDT = "0x" + "f1".repeat(20);
const SCAM = "0x" + "5c".repeat(20);
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const trustEdges = () => [
  edge({ asset: UNK, asset_kind: "erc20", decimals: 18, symbol: "ABC", trust: unknown }),
  edge({ asset: FAKE_USDT, asset_kind: "erc20", decimals: 6, symbol: "USDT",
    trust: { level: "suspicious", impersonates: { address: USDT, symbol: "USDT", name: "Tether USD" }, reason: null } }),
  edge({ asset: USDT, asset_kind: "erc20", decimals: 6, symbol: "USDT", trust: listed }),
  edge({ asset: SCAM, asset_kind: "erc20", decimals: 18, symbol: "AIRDROP", trust: { level: "scam", impersonates: null, reason: "spam-token" } }),
  edge({ asset: USDC, asset_kind: "erc20", decimals: 6, symbol: "USDC", trust: listed }),
  edge({}),
];
/** The asset rows' symbols, top to bottom (visible rows only). */
const rowSymbols = () =>
  [...document.querySelectorAll(".filter__asset .filter__check")].map((l) => l.textContent);

test("asset rows: tokens on a token list first, every other token in a collapsed group, each with its contract", () => {
  const PLAIN_USDT = "0x" + "ab".repeat(20);
  setup([...trustEdges(), edge({ asset: PLAIN_USDT, asset_kind: "erc20", decimals: 6, symbol: "USDT", trust: unknown })]);
  expect(rowSymbols()).toEqual(["ETH", "USDC", "USDT"]);
  expect(screen.getByText("On token lists (3)")).toBeInTheDocument();
  const group = screen.getByRole("button", { name: "Other tokens (4)" });
  expect(group).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByLabelText("AIRDROP")).toBeNull();
  // Short addresses (6…4) tell the real token from a copy; ETH has none.
  const usdcRow = screen.getByLabelText("USDC").closest(".filter__asset")!;
  expect(usdcRow).toHaveTextContent("0xa0b8…eb48");
  expect(screen.getByLabelText("ETH").closest(".filter__asset")!.querySelector(".filter__addr")).toBeNull();

  fireEvent.click(group);
  expect(group).toHaveAttribute("aria-expanded", "true");
  expect(rowSymbols()).toEqual(["ETH", "USDC", "USDT", "ABC", "USDT", "AIRDROP", "USDT"]);
  const fakeRow = screen.getByText("0xf1f1…f1f1").closest(".filter__asset")!;
  expect(fakeRow).toHaveTextContent("Possible impersonation");
  expect(screen.getByText("0x5c5c…5c5c").closest(".filter__asset")!).toHaveTextContent("Known scam");
  // The real USDT and the undetected one carry no warning.
  expect(screen.getByText("0xdac1…1ec7").closest(".filter__asset")!.querySelector(".tag")).toBeNull();
  expect(screen.getByText("0xabab…abab").closest(".filter__asset")!.querySelector(".tag")).toBeNull();

  // Ticking inside the group works like any other row.
  fireEvent.click(screen.getByLabelText("AIRDROP"));
  fireEvent.click(apply());
  expect(useGraph.getState().filter).toEqual({ assets: [{ asset: SCAM }] });
});

test("the other-tokens group starts open when one of its tokens is already ticked", () => {
  useGraph.getState().setFilter({ assets: [{ asset: UNK }] });
  setup(trustEdges());
  expect(screen.getByRole("button", { name: "Other tokens (3)" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByLabelText("ABC")).toBeChecked();
});

const many = () =>
  Array.from({ length: 10 }, (_, i) =>
    edge({ asset: "0x" + String(i).padStart(2, "0").repeat(20), asset_kind: "erc20", decimals: 18, symbol: `TOK${i}`, trust: unknown }),
  );

test("no asset search with 8 or fewer options", () => {
  setup(many().slice(0, 7));
  expect(screen.queryByRole("searchbox", { name: "Search assets" })).toBeNull();
});

test("asset search over more than 8 options matches symbol or address, case-insensitive, keeping ticks", () => {
  setup([...many(), edge({ asset: USDC, asset_kind: "erc20", decimals: 6, symbol: "USDC", trust: listed })]);
  fireEvent.click(screen.getByRole("button", { name: "Other tokens (10)" }));
  const search = screen.getByRole("searchbox", { name: "Search assets" });
  fireEvent.click(screen.getByLabelText("TOK3"));
  fireEvent.change(search, { target: { value: "usdc" } });
  expect(rowSymbols()).toEqual(["USDC"]);
  fireEvent.click(screen.getByLabelText("USDC"));
  // By address (any case).
  fireEvent.change(search, { target: { value: "0X0505" } });
  expect(rowSymbols()).toEqual(["TOK5"]);
  fireEvent.change(search, { target: { value: "zzz" } });
  expect(rowSymbols()).toEqual([]);
  expect(screen.getByText("No matching assets")).toBeInTheDocument();
  // Hidden ticked rows are still applied.
  fireEvent.click(apply());
  expect(useGraph.getState().filter.assets).toEqual([{ asset: USDC }, { asset: "0x" + "03".repeat(20) }]);
});

test("search narrows both groups and their counts", () => {
  setup([...many(), ...trustEdges()]);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search assets" }), { target: { value: "usdt" } });
  expect(rowSymbols()).toEqual(["USDT", "USDT"]);
  expect(screen.getByText("On token lists (1)")).toBeInTheDocument();
  const group = screen.getByRole("button", { name: "Other tokens (1)" });
  expect(group).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(group);
  expect(rowSymbols()).toEqual(["USDT"]);
});

test("typing a search opens the other-tokens group; the user can still close it", () => {
  setup([...many(), ...trustEdges()]);
  const search = screen.getByRole("searchbox", { name: "Search assets" });
  expect(screen.getByRole("button", { name: "Other tokens (13)" })).toHaveAttribute("aria-expanded", "false");
  fireEvent.change(search, { target: { value: "tok" } });
  const group = screen.getByRole("button", { name: "Other tokens (10)" });
  expect(group).toHaveAttribute("aria-expanded", "true");
  fireEvent.click(group);
  expect(group).toHaveAttribute("aria-expanded", "false");
  // Clearing the search leaves the state as it is.
  fireEvent.change(search, { target: { value: "" } });
  expect(screen.getByRole("button", { name: "Other tokens (13)" })).toHaveAttribute("aria-expanded", "false");
  // Whitespace alone is not a search.
  fireEvent.change(search, { target: { value: "  " } });
  expect(screen.getByRole("button", { name: "Other tokens (13)" })).toHaveAttribute("aria-expanded", "false");
});

test("tokens with the same symbol and trust level are ordered by contract address", () => {
  const hi = "0x" + "02".repeat(20);
  const lo = "0x" + "01".repeat(20);
  setup([
    edge({ asset: hi, asset_kind: "erc20", decimals: 18, symbol: "ZZZ", trust: unknown }),
    edge({ asset: lo, asset_kind: "erc20", decimals: 18, symbol: "ZZZ", trust: unknown }),
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Other tokens (2)" }));
  const addrs = [...document.querySelectorAll(".filter__asset .filter__addr")].map((e) => e.textContent);
  expect(addrs).toEqual(["0x0101…0101", "0x0202…0202"]);
});
