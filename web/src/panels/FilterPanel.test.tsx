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
  first_ts: "2024-01-01T00:00:00Z", last_ts: "2024-01-02T00:00:00Z", decimals: 18, symbol: null, ...o,
});

let qc: QueryClient;
function seed(edges: EdgeDto[]) {
  const data: GraphResponseDto = { nodes: [], edges, omitted: {}, coverage: {} };
  const s = useGraph.getState();
  qc.setQueryData(graphQueryKey({ centers: s.centers, filter: s.filter, sort: s.sort }), data);
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
  fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "2024-03-01T08:00" } });
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
  fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "2024-03-02T00:00" } });
  fireEvent.change(screen.getByLabelText("End time"), { target: { value: "2024-03-01T00:00" } });
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
