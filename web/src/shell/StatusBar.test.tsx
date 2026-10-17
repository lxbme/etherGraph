import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/endpoints";
import { ApiError } from "../api/errors";
import { qk } from "../api/queryClient";
import { statusQuery } from "../api/statusQuery";
import type { JobDto } from "../api/generated/JobDto";
import type { StatusDto } from "../api/generated/StatusDto";
import { StatusBar } from "./StatusBar";
import { Toasts } from "./Toasts";
import { TopBar } from "./TopBar";
import { useJobProgress, useQuota, type JobProgressEvent } from "./statusStore";

vi.mock("../api/endpoints", () => ({
  api: { status: vi.fn(), jobs: vi.fn(), recentJobs: vi.fn(), cancelJob: vi.fn() },
}));
const m = vi.mocked(api);
const ADDR = "0x3f2a" + "0".repeat(32) + "91c0";

const job = (over: Partial<JobDto> = {}): JobDto => ({
  id: 1, key: "k", kind: "sync_address", status: "running", priority: "interactive",
  params: { address: ADDR, direction: "older" }, progress: null, attempts: 1, error: null,
  created_at: "2026-10-17T00:00:00Z", updated_at: "2026-10-17T00:00:00Z", ...over,
});
const status = (over: Partial<StatusDto> = {}): StatusDto => ({
  quota_used: 10, quota_limit: 100, paused: false, reset_at: "2026-10-18T00:00:00Z", queue_len: 7,
  rate: 5, jobs_active: 0, calls: 0, retries: 0, errors: {}, degraded: null, ...over,
});
const prog = (over: Partial<JobProgressEvent> = {}): JobProgressEvent => ({
  type: "JobProgress", job_id: 1, kind: "sync_address", fetched: 3000, cursor_block: null, status: "running", error: null, ...over,
});

function wrap(ui: React.ReactElement, qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  useQuota.setState({ quota: null, degraded: null });
  useJobProgress.setState({ byId: {}, lastId: null });
  m.status.mockResolvedValue(status());
  m.jobs.mockResolvedValue([]);
  m.recentJobs.mockResolvedValue([]);
  m.cancelJob.mockResolvedValue(undefined);
});

describe("quota pill", () => {
  const setQ = (used: number, paused = false) =>
    useQuota.setState({ quota: { used, limit: 100, paused, reset_at: "2026-10-18T00:00:00Z" } });

  test("turns warning at 80% and error when paused", () => {
    setQ(79);
    const { rerender } = render(<TopBar search={<i />} filter={<i />} />);
    const pill = () => screen.getByText(/Quota/);
    expect(pill()).toHaveTextContent("Quota 79/100");
    expect(pill()).toHaveClass("chip", "num");
    expect(pill()).not.toHaveClass("chip--warn");
    setQ(80);
    rerender(<TopBar search={<i />} filter={<i />} />);
    expect(pill()).toHaveClass("chip--warn");
    setQ(100, true);
    rerender(<TopBar search={<i />} filter={<i />} />);
    expect(pill()).toHaveClass("chip--error");
    expect(pill()).not.toHaveClass("chip--warn");
    expect(pill()).toHaveAttribute("title", expect.stringContaining("2026-10-1"));
  });
});

describe("status bar", () => {
  test("job progress text for sync_address, queue length and active count", async () => {
    m.jobs.mockResolvedValue([job()]);
    useJobProgress.getState().upsert(prog());
    wrap(<StatusBar />);
    expect(await screen.findByText("Queue 7")).toBeInTheDocument();
    expect(await screen.findByText("Sync 0x3f2a…91c0 (older) · 3,000 fetched")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Jobs 1" })).toBeInTheDocument();
  });

  test("non-sync progress shows kind and status; latest upsert wins", async () => {
    useJobProgress.getState().upsert(prog());
    useJobProgress.getState().upsert(prog({ job_id: 2, kind: "token_meta", status: "pending" }));
    wrap(<StatusBar />);
    expect(await screen.findByText("Token info · Pending")).toBeInTheDocument();
  });
});

describe("jobs popover", () => {
  test("cancel button calls api and refreshes the list", async () => {
    m.jobs.mockResolvedValueOnce([job()]).mockResolvedValue([]);
    wrap(<StatusBar />);
    await userEvent.click(screen.getByRole("button", { name: /^Jobs/ }));
    const dlg = await screen.findByRole("dialog", { name: "Jobs" });
    const row = await within(dlg).findByText("Sync");
    expect(row).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("button", { name: "Cancel" }));
    expect(m.cancelJob).toHaveBeenCalledWith(1);
    await waitFor(() => expect(within(dlg).queryByRole("button", { name: "Cancel" })).toBeNull());
  });

  test("cancelling a job that already finished says so instead of showing an error", async () => {
    m.jobs.mockResolvedValueOnce([job()]).mockResolvedValue([]);
    m.cancelJob.mockRejectedValue(new ApiError("not_found", 404, "job not found or already finished"));
    wrap(
      <>
        <StatusBar />
        <Toasts />
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: /^Jobs/ }));
    const dlg = await screen.findByRole("dialog", { name: "Jobs" });
    await userEvent.click(await within(dlg).findByRole("button", { name: "Cancel" }));
    const t = await screen.findByText("The job has already finished, nothing to cancel");
    expect(t.closest(".toast")).toHaveClass("toast--info");
    expect(screen.queryByText("Not found")).toBeNull();
    await waitFor(() => expect(within(dlg).queryByRole("button", { name: "Cancel" })).toBeNull());
  });

  test("recent failed jobs show error with full text in title; Escape closes", async () => {
    const long = "boom ".repeat(40).trim();
    m.recentJobs.mockResolvedValue([
      job({ id: 5, kind: "fetch_tx", status: "failed", params: { hash: "0x" + "ab".repeat(32) }, attempts: 3, error: long }),
      job({ id: 6, status: "done" }),
    ]);
    wrap(<StatusBar />);
    await userEvent.click(screen.getByRole("button", { name: /^Jobs/ }));
    const err = await screen.findByTitle(long);
    expect(err.textContent!.length).toBeLessThan(long.length);
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("0xabab…abab")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Jobs" })).toBeNull();
  });
});

describe("status loading", () => {
  test("a concurrent fetchQuery and the StatusBar share one in-flight request and one quota write", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    wrap(<StatusBar />, qc);
    await qc.fetchQuery(statusQuery);
    expect(m.status).toHaveBeenCalledTimes(1);
    expect(useQuota.getState().quota?.used).toBe(10);
  });

  test("remounting does not reapply cached status over a newer quota", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const first = wrap(<StatusBar />, qc);
    await screen.findByText("Queue 7");
    first.unmount();
    const newer = { used: 99, limit: 100, paused: false, reset_at: "2026-10-18T00:00:00Z" };
    useQuota.setState({ quota: newer });
    m.status.mockReturnValue(new Promise(() => {}));
    wrap(<StatusBar />, qc);
    expect(await screen.findByText("Queue 7")).toBeInTheDocument();
    expect(useQuota.getState().quota).toEqual(newer);
  });

  test("a job created after mount gets its target once the list refetches", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    wrap(<StatusBar />, qc);
    await waitFor(() => expect(m.jobs).toHaveBeenCalledTimes(1));
    m.jobs.mockResolvedValue([job({ id: 9 })]);
    useJobProgress.getState().upsert(prog({ job_id: 9 }));
    expect(await screen.findByText("Sync · 3,000 fetched")).toBeInTheDocument();
    await qc.invalidateQueries({ queryKey: qk.jobs() });
    expect(await screen.findByText("Sync 0x3f2a…91c0 (older) · 3,000 fetched")).toBeInTheDocument();
  });
});
