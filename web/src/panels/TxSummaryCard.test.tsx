import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api/endpoints";
import type { TransferDto } from "../api/generated/TransferDto";
import type { TxFlowDto } from "../api/generated/TxFlowDto";
import { qk } from "../api/queryClient";
import { useGraph } from "../graph/store";
import { useTabs } from "../shell/tabs";
import { DetailPanel } from "./DetailPanel";
import { TransferTable } from "./TransferTable";

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const H = "0x" + "11".repeat(32);

const row: TransferDto = {
  tx_hash: H, sub_id: "0", kind: "native", block_number: 1, ts: "2024-01-01T00:00:00Z",
  from: A, to: B, asset: null, amount: "1000000000000000000", token_id: null, decimals: 18, symbol: null,
  trust: { level: "listed", impersonates: null, reason: null },
};
const flow = (): TxFlowDto => ({
  tx: {
    hash: H, block_number: 1, ts: "2024-01-01T00:00:00Z", from: A, to: B, value: "1500000000000000000",
    success: true, gas_used: "21000", fee: "21000000000000", method: "swapExactTokens", selector: "0x12345678",
  },
  detail: {} as TxFlowDto["detail"],
  call: null,
  nodes: [
    { address: A, kind: "eoa", display_name: "Alice", ens: null, contract_name: null, labels: [], partial: false, syncing: false, synced: true, hot: false, identified: true, nonce: null, balance: null },
  ],
  flows: [], events: [], completeness: "fund_flow",
});

let qc: QueryClient;
function renderAll() {
  return render(
    <QueryClientProvider client={qc}>
      <TransferTable />
      <DetailPanel />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useGraph.getState().reset();
  useGraph.getState().select({ kind: "node", address: A });
  useTabs.setState({ tabs: [{ id: "graph" }], active: "graph" });
  vi.spyOn(api, "transfers").mockResolvedValue({ items: [row], next_cursor: null });
});
afterEach(() => vi.restoreAllMocks());

test("clicking a row shows the summary card, keeps the highlight, and opens the tx tab", async () => {
  vi.spyOn(api, "tx").mockResolvedValue({ status: "ready", flow: flow(), job_id: null });
  renderAll();
  fireEvent.click(await screen.findByTestId("transfer-row"));
  const open = await screen.findByRole("button", { name: "Open transaction" });
  expect(screen.getByText("swapExactTokens")).toBeInTheDocument();
  expect(screen.getByText("Alice")).toBeInTheDocument();
  expect(useGraph.getState().highlightTransfer).toMatchObject({ from: A, to: B });
  expect(useGraph.getState().selection).toMatchObject({ kind: "tx", hash: H });
  expect(screen.getByTestId("transfer-row")).toBeInTheDocument(); // table keeps its node scope
  fireEvent.click(open);
  expect(useTabs.getState().active).toBe(H);
});

test("pending shows fetching, then the method once ready", async () => {
  const spy = vi.spyOn(api, "tx").mockResolvedValue({ status: "pending", flow: null, job_id: 7 });
  renderAll();
  fireEvent.click(await screen.findByTestId("transfer-row"));
  expect(await screen.findByText(/Fetching/)).toBeInTheDocument();
  spy.mockResolvedValue({ status: "ready", flow: flow(), job_id: null });
  await act(async () => {
    await qc.invalidateQueries({ queryKey: qk.tx(H) });
  });
  await waitFor(() => expect(screen.getByText("swapExactTokens")).toBeInTheDocument());
});

test("a failed, undecoded call: red Failed badge, the selector with an Undecoded tag", async () => {
  const f = flow();
  f.tx.success = false;
  f.tx.method = null;
  vi.spyOn(api, "tx").mockResolvedValue({ status: "ready", flow: f, job_id: null });
  renderAll();
  fireEvent.click(await screen.findByTestId("transfer-row"));
  const card = await screen.findByTestId("tx-summary");
  expect(within(card).getByText("Failed").closest(".tag")).toHaveClass("tag--neg");
  expect(within(card).getByText("0x12345678")).toBeInTheDocument();
  expect(within(card).getByText("Undecoded")).toBeInTheDocument();
});

test("a contract creation shows the created contract; a reverted one does not", async () => {
  const C = "0x" + "cc".repeat(20);
  const f = flow();
  f.tx.to = null;
  f.tx.method = null;
  f.tx.selector = null;
  f.detail = { contract_created: C } as TxFlowDto["detail"];
  const spy = vi.spyOn(api, "tx").mockResolvedValue({ status: "ready", flow: f, job_id: null });
  renderAll();
  fireEvent.click(await screen.findByTestId("transfer-row"));
  const card = await screen.findByTestId("tx-summary");
  expect(within(card).getAllByText("Contract creation")).toHaveLength(2); // title and recipient
  expect(within(card).getByText("Contract created")).toBeInTheDocument();
  expect(within(card).getByTitle(C)).toBeInTheDocument();

  spy.mockResolvedValue({ status: "ready", flow: { ...f, tx: { ...f.tx, success: false } }, job_id: null });
  await act(async () => {
    await qc.invalidateQueries({ queryKey: qk.tx(H) });
  });
  await waitFor(() => expect(within(card).queryByText("Contract created")).toBeNull());
  expect(within(card).queryByTitle(C)).toBeNull();
});

test("clicking the highlighted row again clears the highlight and the card, back to the node", async () => {
  vi.spyOn(api, "tx").mockResolvedValue({ status: "ready", flow: flow(), job_id: null });
  renderAll();
  const row = await screen.findByTestId("transfer-row");
  fireEvent.click(row);
  await screen.findByTestId("tx-summary");
  fireEvent.click(row);
  expect(useGraph.getState().highlightTransfer).toBeNull();
  expect(useGraph.getState().selection).toEqual({ kind: "node", address: A });
  expect(screen.queryByTestId("tx-summary")).toBeNull();
  // A third click starts over.
  fireEvent.click(screen.getByTestId("transfer-row"));
  expect(useGraph.getState().selection).toMatchObject({ kind: "tx", hash: H });
  expect(useGraph.getState().highlightTransfer).toMatchObject({ from: A, to: B });
});
