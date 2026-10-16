import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { api } from "../api/endpoints";
import type { AddressProfileDto } from "../api/generated/AddressProfileDto";
import { useGraph } from "../graph/store";
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

function renderDetail(onNavigate?: (a: string) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(api, "address").mockResolvedValue(profile);
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
