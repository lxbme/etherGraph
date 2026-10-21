import { fireEvent, render, screen, within } from "@testing-library/react";
import type { TransferDto } from "../api/generated/TransferDto";
import { hiddenFromTransfer } from "../graph/hiddenTransfers";
import { useGraph } from "../graph/store";
import { useTabs } from "../shell/tabs";
import { DATA_ROW_HEIGHT, DataTable } from "./DataTable";

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);

const transfer = (i: number, over: Partial<TransferDto> = {}): TransferDto => ({
  tx_hash: "0x" + i.toString(16).padStart(64, "0"), sub_id: "0", kind: "native", block_number: 1,
  ts: "2024-01-01T00:00:00Z", from: A, to: B, asset: null, amount: "1500000000000000000", token_id: null, decimals: 18,
  symbol: null, trust: { level: "listed", impersonates: null, reason: null }, ...over,
});

beforeEach(() => {
  useGraph.getState().reset();
  useTabs.getState().closeAllTx();
});
afterEach(() => vi.restoreAllMocks());

test("the eye button hides a shown transfer and shows a hidden one", () => {
  // A checksummed hash and addresses: the stored record is lowercased.
  const row = transfer(1, { tx_hash: "0x" + "AB".repeat(32), from: "0x" + "AA".repeat(20) });
  const other = transfer(2);
  const spy = vi.spyOn(useGraph.getState(), "setTransfersHidden");
  render(<DataTable rows={[row, other]} names={new Map([[B, "bob.eth"]])} />);
  expect(screen.getByRole("columnheader", { name: "Visible" })).toBeInTheDocument();
  expect(screen.queryByRole("checkbox")).toBeNull();
  const [first, second] = screen.getAllByTestId("data-row");
  expect(within(first!).getByTitle(B)).toHaveTextContent("bob.eth");
  expect(within(first!).getByTitle(row.from)).toHaveTextContent("0xAAAA…AAAA");

  const hide = within(first!).getByRole("button", { name: "Hide" });
  expect(hide).toHaveAttribute("title", "Hide");
  fireEvent.click(hide);
  expect(spy).toHaveBeenCalledWith([hiddenFromTransfer(row)], true);
  expect(spy.mock.calls[0]![0][0]!.tx_hash).toBe("0x" + "ab".repeat(32));
  expect(first).toHaveClass("data__row--hidden");
  expect(within(first!).queryByRole("button", { name: "Hide" })).toBeNull();
  expect(within(first!).getByRole("button", { name: "Show" })).toHaveAttribute("title", "Show");
  expect(second).not.toHaveClass("data__row--hidden");

  // The same button shows it again.
  fireEvent.click(within(first!).getByRole("button", { name: "Show" }));
  expect(spy).toHaveBeenLastCalledWith([hiddenFromTransfer(row)], false);
  expect(first).not.toHaveClass("data__row--hidden");
  expect(within(first!).getByRole("button", { name: "Hide" })).toBeInTheDocument();
});

test("a hidden row keeps an enabled eye button that sets its own colour", () => {
  render(<DataTable rows={[transfer(1)]} names={new Map()} />);
  const row = screen.getByTestId("data-row");
  fireEvent.click(within(row).getByRole("button", { name: "Hide" }));
  const eye = within(row).getByRole("button", { name: "Show" });
  expect(row).toHaveClass("data__row--hidden");
  // The muting is a colour on the row (see app.css); the e2e checks the button stays opaque.
  expect(eye).toBeEnabled();
  expect(eye).toHaveClass("btn");
  expect(eye.closest(".data__row--hidden")).toBe(row);
});

test("clicking the hash opens the tx tab", () => {
  const row = transfer(7);
  render(<DataTable rows={[row]} names={new Map()} />);
  fireEvent.click(screen.getByTitle(row.tx_hash));
  expect(useTabs.getState().active).toBe(row.tx_hash);
});

test("only the visible window is rendered", () => {
  const rows = Array.from({ length: 5000 }, (_, i) => transfer(i));
  render(<DataTable rows={rows} names={new Map()} />);
  expect(screen.getAllByTestId("data-row").length).toBeLessThanOrEqual(60);
  expect(screen.getByTitle(rows[0]!.tx_hash)).toBeInTheDocument();
  // Scrolled to the end: the last rows are rendered instead.
  fireEvent.scroll(screen.getByTestId("data-scroll"), { target: { scrollTop: 4999 * DATA_ROW_HEIGHT } });
  expect(screen.getAllByTestId("data-row").length).toBeLessThanOrEqual(60);
  expect(screen.getByTitle(rows[4999]!.tx_hash)).toBeInTheDocument();
  expect(screen.queryByTitle(rows[0]!.tx_hash)).toBeNull();
});
