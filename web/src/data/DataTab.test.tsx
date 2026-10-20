import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render as rtlRender, screen, within } from "@testing-library/react";
import type { EdgeDto } from "../api/generated/EdgeDto";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import type { TransferDto } from "../api/generated/TransferDto";
import { transferKey } from "../graph/hiddenTransfers";
import { useGraph } from "../graph/store";
import { DataTab } from "./DataTab";
import { useDataFilter } from "./dataFilter";

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const C = "0x" + "cc".repeat(20);
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

const transfer = (i: number, over: Partial<TransferDto> = {}): TransferDto => ({
  tx_hash: "0x" + i.toString(16).padStart(64, "0"), sub_id: "top", kind: "native", block_number: 1,
  ts: `2024-01-0${i}T00:00:00Z`, from: A, to: B, asset: null, amount: "1000000000000000000", token_id: null, decimals: 18,
  symbol: null, trust: { level: "listed", impersonates: null, reason: null }, ...over,
});
const edge = (from: string, to: string, asset: string | null = null): EdgeDto => ({
  from, to, asset, asset_kind: asset === null ? "native" : "erc20", count: 1, sum: "1", first_ts: "2024-01-01T00:00:00Z",
  last_ts: "2024-01-01T00:00:00Z", decimals: asset === null ? 18 : 6, symbol: null, trust: { level: "listed", impersonates: null, reason: null },
});
const node = (address: string, over: Partial<NodeSummaryDto> = {}) => ({ address, display_name: null, labels: [], ...over });

// A → B twice in ETH, A → C once in USDC; C is named only by its first label.
const ROWS = [
  transfer(1),
  transfer(2),
  transfer(3, { to: C, asset: USDC, kind: "erc20", amount: "5000000", decimals: 6, symbol: "USDC" }),
];
const GRAPH = {
  nodes: [node(A, { display_name: "Alice" }), node(B), node(C, { labels: [{ id: 1, text: "Carol Exchange", category: "cex", source: "user" }] })],
  edges: [edge(A, B), edge(A, C, USDC)],
};

vi.mock("../graph/useGraphData", () => ({ useGraphData: () => ({ data: GRAPH }) }));
vi.mock("./useDataTransfers", async (orig) => ({
  ...(await orig<typeof import("./useDataTransfers")>()),
  useDataTransfers: () => ({ rows: ROWS, loading: false, done: true, capped: false, loadMore: () => {}, error: null }),
}));

/** The tab inside a query client (its snapshot refresh queries one). */
const render = (ui: React.ReactElement) =>
  rtlRender(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })}>{ui}</QueryClientProvider>);
const hiddenKeys = () => Object.keys(useGraph.getState().hiddenTransfers).sort();
const sidebar = () => screen.getByRole("search");

beforeEach(() => {
  useGraph.getState().reset();
  useDataFilter.getState().reset();
});

test("hide shown hides exactly the filtered rows in one undo step", () => {
  render(<DataTab />);
  expect(screen.getByText("3 / 3 transfers")).toBeInTheDocument();
  // Narrow to the ETH rows by Alice's name, sending.
  fireEvent.change(within(sidebar()).getByRole("textbox", { name: "Address or name" }), { target: { value: "alice" } });
  fireEvent.change(within(sidebar()).getByRole("combobox", { name: "Direction" }), { target: { value: "from" } });
  fireEvent.change(within(sidebar()).getByRole("combobox", { name: "Asset" }), { target: { value: "eth" } });
  expect(screen.getByText("2 / 3 transfers")).toBeInTheDocument();
  expect(screen.getAllByTestId("data-row")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Unhide shown (0)" })).toBeDisabled();

  const g = useGraph.getState();
  const before = g._past.length;
  fireEvent.click(screen.getByRole("button", { name: "Hide shown (2)" }));
  expect(hiddenKeys()).toEqual([transferKey(ROWS[0]!), transferKey(ROWS[1]!)].sort());
  expect(useGraph.getState()._past.length).toBe(before + 1);
  expect(screen.getByRole("button", { name: "Hide shown (0)" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Unhide shown (2)" })).toBeEnabled();

  // Hiding the shown rows with "show hidden" off empties the list; one undo brings both back.
  fireEvent.click(within(sidebar()).getByRole("switch", { name: "Show hidden" }));
  expect(screen.queryAllByTestId("data-row")).toHaveLength(0);
  useGraph.getState().undo();
  expect(hiddenKeys()).toEqual([]);
});

test("unhide shown restores them", () => {
  render(<DataTab />);
  fireEvent.click(screen.getByRole("button", { name: "Hide shown (3)" }));
  expect(hiddenKeys()).toHaveLength(3);
  // Only the USDC row (to Carol, by her label) is unhidden.
  fireEvent.change(within(sidebar()).getByRole("textbox", { name: "Address or name" }), { target: { value: "carol" } });
  expect(screen.getByText("1 / 3 transfers")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Hide shown (0)" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Unhide shown (1)" }));
  expect(hiddenKeys()).toEqual([transferKey(ROWS[0]!), transferKey(ROWS[1]!)].sort());
  expect(screen.getByRole("button", { name: "Unhide shown (0)" })).toBeDisabled();

  // The reset link clears the filter: every row is shown again.
  fireEvent.click(within(sidebar()).getByRole("button", { name: "Reset" }));
  expect(screen.getByText("3 / 3 transfers")).toBeInTheDocument();
  expect(within(sidebar()).queryByRole("button", { name: "Reset" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Unhide shown (2)" }));
  expect(hiddenKeys()).toEqual([]);
});

test("the sidebar has no caption text", () => {
  render(<DataTab />);
  // The amount bounds appear once one asset is chosen; an invalid bound is flagged and ignored.
  expect(within(sidebar()).queryByRole("textbox", { name: "Min amount" })).toBeNull();
  fireEvent.change(within(sidebar()).getByRole("combobox", { name: "Asset" }), { target: { value: USDC } });
  const min = within(sidebar()).getByRole("textbox", { name: "Min amount" });
  fireEvent.change(min, { target: { value: "1.2.3" } });
  expect(min).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByText("1 / 3 transfers")).toBeInTheDocument();
  fireEvent.change(within(sidebar()).getByRole("textbox", { name: "Max amount" }), { target: { value: "4.99" } });
  expect(screen.getByText("0 / 3 transfers")).toBeInTheDocument();

  // Every piece of text in the sidebar belongs to a control: no headings, hints or captions.
  const root = sidebar();
  expect(root.querySelectorAll("p, small, h1, h2, h3, h4, legend")).toHaveLength(0);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const loose: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.textContent!.trim() && !n.parentElement!.closest("button, label, option, optgroup, select")) loose.push(n.textContent!);
  }
  expect(loose).toEqual([]);
});
