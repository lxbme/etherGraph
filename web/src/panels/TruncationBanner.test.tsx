import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api/endpoints";
import type { SyncStatusDto } from "../api/generated/SyncStatusDto";
import { useLocale } from "../i18n";
import { TruncationBanner } from "./TruncationBanner";

const A = "0x" + "aa".repeat(20);
const row = (o: Partial<SyncStatusDto>): SyncStatusDto => ({
  kind: "native", from_block: 100, to_block: 200, truncated: false, state: "ok", last_synced_at: null, oldest_ts: null, ...o,
});

function mount(coverage: SyncStatusDto[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TruncationBanner address={A} coverage={coverage} />
    </QueryClientProvider>,
  );
}

beforeEach(() => act(() => useLocale.getState().setLocale("zh")));
afterEach(() => {
  act(() => useLocale.getState().setLocale("en"));
  vi.restoreAllMocks();
});

test("renders nothing when no row is truncated", () => {
  mount([row({}), row({ kind: "erc20" })]);
  expect(screen.queryByRole("status")).toBeNull();
});

test("names each truncated kind with its oldest date", () => {
  mount([
    row({ kind: "native" }),
    row({ kind: "erc20", truncated: true, oldest_ts: "2022-03-31T05:00:00Z" }),
    row({ kind: "internal", truncated: true, oldest_ts: "2022-03-30T00:00:00Z" }),
  ]);
  const text = screen.getByRole("status").textContent!;
  expect(text).toContain("ERC20 只同步到 2022-03-31");
  expect(text).toContain("只同步到 2022-03-30");
  expect(text).not.toContain("普通转账");
  expect(text).toContain("更早的记录未同步");
});

test("falls back to the block without a date", () => {
  mount([row({ kind: "erc20", truncated: true, oldest_ts: null, from_block: 14491353 })]);
  const text = screen.getByRole("status").textContent!;
  expect(text).toContain("区块 14491353");
  expect(text).not.toContain("Invalid");
});

test("fetch older posts an older sync", async () => {
  const sync = vi.spyOn(api, "sync").mockReturnValue(new Promise(() => {}));
  mount([row({ kind: "erc20", truncated: true, oldest_ts: "2022-03-31T05:00:00Z" })]);
  fireEvent.click(screen.getByRole("button", { name: "补全" }));
  await waitFor(() => expect(sync).toHaveBeenCalledWith({ addresses: [A], direction: "older" }));
  const busy = await screen.findByRole("button", { name: "补全中…" });
  expect(busy).toBeDisabled();
});
