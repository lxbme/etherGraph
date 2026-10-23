import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getAccount, signMessage } from "wagmi/actions";
import { api } from "../api/endpoints";
import type { Event } from "../api/generated/Event";
import type { LocalDataDto } from "../api/generated/LocalDataDto";
import type { StatusDto } from "../api/generated/StatusDto";
import { queryClient } from "../api/queryClient";
import { subscribeEvents } from "../api/sse";
import { useEvents } from "../api/useEvents";
import { useAuth } from "../auth/useMe";
import { ADMIN_CHECKSUMMED, LOCAL_DATA, actionMessage, adminMe, json, localSource, stubAdminApi } from "./adminApi.testutil";
import { ActionConfirmDialog } from "./AdminView";
import { useAdminMode } from "./adminMode";
import { LocalDataPanel } from "./LocalDataPanel";
import { useActionConfirm } from "./useAdminAction";

vi.mock("wagmi/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wagmi/actions")>()),
  getAccount: vi.fn(),
  signMessage: vi.fn(),
  watchAccount: vi.fn(() => () => {}),
}));
vi.mock("../api/sse", () => ({ subscribeEvents: vi.fn() }));

const STATUS: StatusDto = {
  quota_used: 0, quota_limit: 100, paused: false, server_paused: false, reset_at: "2026-10-24T00:00:00Z", queue_len: 0,
  rate: 5, jobs_active: 0, queued_calls: 0, calls: 0, retries: 0, errors: {}, degraded: null,
};

let emit: (e: Event) => void;
/** Delivers one event from the stream; the query cache tells its observers on the next tick. */
const send = (e: Event) =>
  act(async () => {
    emit(e);
    await new Promise((r) => setTimeout(r, 0));
  });

/** The panel with the app's event subscription, as it runs under the admin page. */
function Harness() {
  useEvents();
  return (
    <>
      <LocalDataPanel />
      <ActionConfirmDialog />
    </>
  );
}
const renderPanel = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );

/** The given sources replaced in LOCAL_DATA. */
const withSources = (over: Record<string, Partial<LocalDataDto["sources"][number]>>, extra: Partial<LocalDataDto> = {}): LocalDataDto => ({
  ...LOCAL_DATA,
  ...extra,
  sources: LOCAL_DATA.sources.map((s) => (over[s.source] ? { ...s, ...over[s.source] } : s)),
});

/** The table row of a source: its category and source name, both shown in its first cell. */
async function row(category: string, name: string): Promise<HTMLTableRowElement> {
  await screen.findAllByText(category);
  const found = (screen.getAllByRole("row") as HTMLTableRowElement[])
    .find((r) => r.cells[0]?.textContent === `${category}${name}`);
  if (!found) throw new Error(`no row for ${category} / ${name}`);
  return found;
}
/** The detail row right under a source's row. */
const detailOf = (r: HTMLElement) => r.nextElementSibling as HTMLElement;

async function signConfirm(expectedLine: string) {
  const dialog = await screen.findByRole("dialog", { name: "Sign this change" });
  expect(dialog.querySelector("pre")?.textContent).toBe(actionMessage(expectedLine));
  await userEvent.click(within(dialog).getByRole("button", { name: "Sign and apply" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

const RUNNING = withSources(
  { tokens_coingecko: { state: "running" } },
  { running: "tokens_coingecko" },
);

beforeEach(() => {
  useAuth.setState({ status: "authenticated", me: adminMe(), reason: null });
  useAdminMode.setState({ status: "on", expiresAt: "2099-01-01T00:00:00.000Z", ended: false, error: null });
  vi.mocked(getAccount).mockReturnValue({ address: ADMIN_CHECKSUMMED } as never);
  vi.mocked(signMessage).mockResolvedValue("0xsig");
  vi.mocked(subscribeEvents).mockImplementation((onEvent) => {
    emit = onEvent;
    return () => {};
  });
  vi.spyOn(api, "status").mockResolvedValue(STATUS);
  vi.spyOn(api, "jobs").mockResolvedValue([]);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(signMessage).mockReset();
  useActionConfirm.setState({ current: null, requesting: false });
  queryClient.clear();
});

test("renders each source with version, imported time, rows and an upstream tag", async () => {
  stubAdminApi();
  renderPanel();
  expect(await screen.findByRole("heading", { name: "Local data" })).toBeInTheDocument();
  expect(await screen.findByText("Upstream checked 2026-10-23 09:12:00 UTC")).toBeInTheDocument();

  const labels = await row("Address labels", "eth-labels");
  expect(labels.cells[1]).toHaveTextContent("—");
  expect(labels.cells[2]).toHaveTextContent("2026-10-18 12:20:00 UTC");
  expect(labels.cells[3]).toHaveTextContent("112,384");
  expect(within(labels.cells[4]!).getByText("Update available")).toHaveClass("tag", "tag--warn");
  expect(within(labels).getByRole("button", { name: "Update" })).toBeEnabled();

  const uniswap = await row("Token lists", "Uniswap default");
  expect(uniswap.cells[1]).toHaveTextContent("22.27.0");
  expect(uniswap.cells[3]).toHaveTextContent("1,791");
  expect(within(uniswap.cells[4]!).getByText("Up to date")).toHaveClass("tag", "tag--ok");

  await row("Token lists", "CoinGecko");
  const unchecked = within((await row("Token lists", "eth-labels")).cells[4]!).getByText("Not checked");
  expect(unchecked).toHaveClass("tag", "tag--neutral");
  expect(unchecked).toHaveAttribute("title", "HEAD timed out");

  const sourcify = await row("Function signatures", "Sourcify");
  expect(within(sourcify.cells[4]!).getByText("11 files · 570 MB")).toHaveClass("tag", "tag--neutral");
});

test("numbers are right-aligned with tabular figures and versions are monospace", async () => {
  stubAdminApi();
  renderPanel();
  const uniswap = await row("Token lists", "Uniswap default");
  const table = uniswap.closest("table")!;
  expect(table).toHaveClass("table", "local-data");
  expect([...table.querySelectorAll("col")].map((c) => c.style.width)).toEqual(["26%", "13%", "15%", "11%", "21%", "14%"]);
  // Version: monospace, left-aligned (no right-aligning class).
  expect(uniswap.cells[1]).toHaveClass("num");
  expect(uniswap.cells[1]).not.toHaveClass("table__num");
  // Imported and rows: right-aligned, tabular figures; their headers too.
  for (const i of [2, 3]) {
    expect(uniswap.cells[i]).toHaveClass("table__num", "num");
    expect(table.querySelectorAll("th")[i]).toHaveClass("table__num");
  }
  // Actions: right-aligned, buttons of one width.
  expect(uniswap.cells[5]).toHaveClass("table__num");
  expect(within(uniswap).getByRole("button", { name: "Update" })).toHaveClass("local-data__action");
});

test("a running row shows a detail row with progress from LocalDataProgress and a cancel button; other update buttons are disabled with the busy title", async () => {
  stubAdminApi({ "GET /api/admin/local-data": () => json(200, RUNNING) });
  renderPanel();
  const gecko = await row("Token lists", "CoinGecko");
  expect(within(gecko.cells[4]!).getByText("Importing")).toHaveClass("tag");
  expect(within(gecko).getByRole("button", { name: "Cancel" })).toBeEnabled();
  expect(within(gecko).queryByRole("button", { name: "Update" })).toBeNull();
  for (const [cat, name] of [["Address labels", "eth-labels"], ["Token lists", "Uniswap default"]] as const) {
    const update = within(await row(cat, name)).getByRole("button", { name: "Update" });
    expect(update).toBeDisabled();
    expect(update).toHaveAttribute("title", "Another dataset is updating");
  }
  const download = within(await row("Function signatures", "Sourcify")).getByRole("button", { name: "Download and import" });
  expect(download).toBeDisabled();
  expect(download).toHaveAttribute("title", "Another dataset is updating");

  await send({ type: "LocalDataProgress", source: "tokens_coingecko", phase: "download", bytes: 1_400_000, total_bytes: 3_500_000, rows: 0, files_done: null, files_total: null });
  const detail = detailOf(gecko);
  expect(detail).toHaveClass("local-data__detail");
  expect(detail.querySelector("td")).toHaveAttribute("colspan", "6");
  expect(within(detail).getByText("Downloading · 1612.0.0")).toBeInTheDocument();
  expect(within(detail).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
  expect(within(detail).getByText("1.4 MB / 3.5 MB")).toHaveClass("num");

  await send({ type: "LocalDataProgress", source: "tokens_coingecko", phase: "import", bytes: 3_500_000, total_bytes: 3_500_000, rows: 2240, files_done: null, files_total: null });
  expect(within(detail).getByText("Importing · 1612.0.0")).toBeInTheDocument();
  expect(within(detail).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  expect(within(detail).getByText("2,240")).toBeInTheDocument();
});

test("a progress event for a row the list does not show as running marks it running", async () => {
  stubAdminApi();
  renderPanel();
  const labels = await row("Address labels", "eth-labels");
  await send({ type: "LocalDataProgress", source: "eth_labels", phase: "download", bytes: 10, total_bytes: null, rows: 0, files_done: null, files_total: null });
  expect(within(labels).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  expect(within(detailOf(labels)).getByText("10 B")).toBeInTheDocument();
});

test("a failed row shows the error, 本地数据未改动 and retry", async () => {
  stubAdminApi({
    "GET /api/admin/local-data": () =>
      json(
        200,
        withSources({
          tokens_eth_labels: { state: "failed", error: "download timed out (raw.githubusercontent.com, 60 s)", error_at: "2026-10-23T09:14:00.000Z" },
          eth_labels: { state: "failed", error: "interrupted", error_at: "2026-10-23T09:00:00.000Z" },
        }),
      ),
  });
  renderPanel();
  const tokens = await row("Token lists", "eth-labels");
  expect(within(tokens.cells[4]!).getByText("Update failed")).toHaveClass("tag", "tag--neg");
  expect(within(tokens).getByRole("button", { name: "Retry" })).toBeEnabled();
  const detail = detailOf(tokens);
  expect(within(detail).getByText("2026-10-23 09:14:00 UTC download timed out (raw.githubusercontent.com, 60 s)")).toHaveClass("local-data__error");
  expect(within(detail).getByText("· Local data unchanged")).toHaveClass("admin__muted");

  const labels = await row("Address labels", "eth-labels");
  expect(within(detailOf(labels)).getByText("2026-10-23 09:00:00 UTC Interrupted by a server restart")).toBeInTheDocument();
});

test("not-imported Sourcify shows download-and-import and the switch is disabled with its reason", async () => {
  stubAdminApi();
  renderPanel();
  const sourcify = await row("Function signatures", "Sourcify");
  expect(sourcify.cells[1]).toHaveTextContent("—");
  expect(within(sourcify).getByRole("button", { name: "Download and import" })).toHaveClass("btn--primary");
  const toggle = screen.getByRole("switch", { name: "Guess names from signatures" });
  expect(toggle).toBeDisabled();
  expect(toggle).not.toBeChecked();
  expect(screen.getByText("Import function signatures first")).toBeInTheDocument();
});

test("a partly imported Sourcify shows partial n/total as its version", async () => {
  stubAdminApi({
    "GET /api/admin/local-data": () =>
      json(
        200,
        withSources({
          signatures_sourcify: {
            rows: 512_000,
            imported_at: "2026-10-22T10:00:00.000Z",
            partial: { done: 4, total: 11 },
            upstream: { status: "update", version: null, files: 11, bytes: 570_000_000, error: null },
          },
        }),
      ),
  });
  renderPanel();
  const sourcify = await row("Function signatures", "Sourcify");
  expect(sourcify.cells[1]).toHaveTextContent("Partial 4/11");
  expect(within(sourcify.cells[4]!).getByText("Update available")).toBeInTheDocument();
  // Some signatures: the switch can be turned on, with no reason shown.
  expect(screen.getByRole("switch", { name: "Guess names from signatures" })).toBeEnabled();
  expect(screen.queryByText("Import function signatures first")).toBeNull();
});

test("update / cancel / toggle call useAdminAction.run with UpdateLocalData / CancelLocalData / SetSignatureGuess", async () => {
  const signatures = localSource("signatures_sourcify", { rows: 900_000 });
  const api = stubAdminApi({ "GET /api/admin/local-data": () => json(200, withSources({ signatures_sourcify: signatures })) });
  renderPanel();

  await userEvent.click(within(await row("Address labels", "eth-labels")).getByRole("button", { name: "Update" }));
  // Applied: the server now lists the update as running.
  api.route("GET /api/admin/local-data", () => json(200, withSources({ signatures_sourcify: signatures, eth_labels: { state: "running" } }, { running: "eth_labels" })));
  await signConfirm("Server line for UpdateLocalData");

  const labels = await row("Address labels", "eth-labels");
  await userEvent.click(await within(labels).findByRole("button", { name: "Cancel" }));
  await signConfirm("Server line for CancelLocalData");

  const toggle = screen.getByRole("switch", { name: "Guess names from signatures" });
  expect(toggle).toBeEnabled();
  await userEvent.click(toggle);
  await signConfirm("Server line for SetSignatureGuess");

  expect(api.submitted()).toEqual([
    { action: { type: "UpdateLocalData", source: "eth_labels" }, nonce: "n1", signature: "0xsig" },
    { action: { type: "CancelLocalData", source: "eth_labels" }, nonce: "n1", signature: "0xsig" },
    { action: { type: "SetSignatureGuess", enabled: true }, nonce: "n1", signature: "0xsig" },
  ]);
});

test("check for updates asks the upstreams now", async () => {
  const api = stubAdminApi({
    "POST /api/admin/local-data/check": () => json(200, { ...LOCAL_DATA, checked_at: "2026-10-23T10:00:00.000Z" }),
  });
  renderPanel();
  await userEvent.click(await screen.findByRole("button", { name: "Check for updates" }));
  expect(await screen.findByText("Upstream checked 2026-10-23 10:00:00 UTC")).toBeInTheDocument();
  expect(api.calls.filter((c) => c.path === "/api/admin/local-data/check")).toHaveLength(1);
});

test("LocalDataDone refetches", async () => {
  const api = stubAdminApi({ "GET /api/admin/local-data": () => json(200, RUNNING) });
  renderPanel();
  const gecko = await row("Token lists", "CoinGecko");
  await send({ type: "LocalDataProgress", source: "tokens_coingecko", phase: "import", bytes: 5, total_bytes: 5, rows: 6071, files_done: null, files_total: null });
  expect(within(detailOf(gecko)).getByText("6,071")).toBeInTheDocument();
  const fetches = () => api.calls.filter((c) => c.method === "GET" && c.path === "/api/admin/local-data").length;
  expect(fetches()).toBe(1);

  api.route("GET /api/admin/local-data", () =>
    json(200, withSources({ tokens_coingecko: { version: "1612.0.0", rows: 6071, upstream: { status: "up_to_date", version: "1612.0.0", files: null, bytes: null, error: null } } })),
  );
  await send({ type: "LocalDataDone", source: "tokens_coingecko", outcome: "succeeded", error: null });
  await waitFor(() => expect(fetches()).toBe(2));
  const done = await row("Token lists", "CoinGecko");
  await waitFor(() => expect(within(done.cells[4]!).getByText("Up to date")).toBeInTheDocument());
  expect(done.cells[3]).toHaveTextContent("6,071");
  expect(within(done).getByRole("button", { name: "Update" })).toBeEnabled();
  expect(screen.queryByRole("progressbar")).toBeNull();
});
