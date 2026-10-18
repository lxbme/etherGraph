import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getAccount, signMessage } from "wagmi/actions";
import { queryClient } from "../api/queryClient";
import { useAuth } from "../auth/useMe";
import { download } from "../lib/download";
import { ADMIN, ADMIN_CHECKSUMMED, actionMessage, adminMe, auditRow, json, stubAdminApi } from "./adminApi.testutil";
import { ActionConfirmDialog } from "./AdminView";
import { useAdminMode } from "./adminMode";
import { AuditLog } from "./AuditLog";
import { useActionConfirm } from "./useAdminAction";

vi.mock("wagmi/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wagmi/actions")>()),
  getAccount: vi.fn(),
  signMessage: vi.fn(),
  watchAccount: vi.fn(() => () => {}),
}));
vi.mock("../lib/download", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/download")>()),
  download: vi.fn(),
}));

function renderLog() {
  return render(
    <QueryClientProvider client={queryClient}>
      <AuditLog />
      <ActionConfirmDialog />
    </QueryClientProvider>,
  );
}

/** The log's table (the action names also appear in the filter's options). */
const table = () => screen.findByRole("table");
const auditCalls = (api: ReturnType<typeof stubAdminApi>) => api.calls.filter((c) => c.path === "/api/admin/audit");

beforeEach(() => {
  useAuth.setState({ status: "authenticated", me: adminMe(), reason: null });
  useAdminMode.setState({ status: "on", expiresAt: "2099-01-01T00:00:00.000Z", ended: false, error: null });
  vi.mocked(getAccount).mockReturnValue({ address: ADMIN_CHECKSUMMED } as never);
  vi.mocked(signMessage).mockResolvedValue("0xsig");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(signMessage).mockReset();
  vi.mocked(download).mockReset();
  useActionConfirm.setState({ current: null, requesting: false });
  queryClient.clear();
});

test("shows the newest entries with their outcome", async () => {
  stubAdminApi({ "GET /api/admin/audit": () => json(200, { rows: [auditRow(2, { outcome: "denied" }), auditRow(1, { action: "login" })], next_cursor: null }) });
  renderLog();
  const rows = await screen.findAllByRole("row");
  // The header row, then the two entries newest first.
  expect(within(rows[1]!).getByText("whitelist_add")).toBeInTheDocument();
  expect(within(rows[1]!).getByText("denied")).toBeInTheDocument();
  expect(within(rows[2]!).getByText("login")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Load older entries" })).toBeNull();
});

test("filters by actor, action and UTC time range", async () => {
  const api = stubAdminApi();
  renderLog();
  await within(await table()).findByText("login");
  await userEvent.type(screen.getByRole("textbox", { name: "Actor" }), ADMIN);
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Action" }), "set_user_quota");
  fireEvent.change(screen.getByLabelText("From (UTC)"), { target: { value: "2026-10-01T00:00" } });
  fireEvent.change(screen.getByLabelText("To (UTC)"), { target: { value: "2026-10-19T12:30" } });
  await userEvent.click(screen.getByRole("button", { name: "Apply" }));

  await waitFor(() => expect(auditCalls(api).length).toBe(2));
  const q = auditCalls(api)[1]!.query;
  expect(q.get("actor")).toBe(ADMIN);
  expect(q.get("action")).toBe("set_user_quota");
  expect(q.get("from")).toBe("2026-10-01T00:00:00.000Z");
  expect(q.get("to")).toBe("2026-10-19T12:30:00.000Z");
  expect(q.get("cursor")).toBeNull();
});

test("pages to older entries with the cursor", async () => {
  const api = stubAdminApi({
    "GET /api/admin/audit": (c) =>
      c.query.get("cursor") === "50"
        ? json(200, { rows: [auditRow(49, { action: "logout" })], next_cursor: null })
        : json(200, { rows: [auditRow(50)], next_cursor: 50 }),
  });
  renderLog();
  await userEvent.click(await screen.findByRole("button", { name: "Load older entries" }));
  expect(await within(await table()).findByText("logout")).toBeInTheDocument();
  expect(within(await table()).getByText("whitelist_add")).toBeInTheDocument();
  expect(auditCalls(api).map((c) => c.query.get("cursor"))).toEqual([null, "50"]);
});

test("exporting signs ExportAudit for the time range and downloads the rows as JSON", async () => {
  const rows = [auditRow(2), auditRow(1)];
  const api = stubAdminApi({ "POST /api/admin/actions": () => json(200, { before: null, after: { rows: 2 }, rows }) });
  renderLog();
  await within(await table()).findByText("login");
  fireEvent.change(screen.getByLabelText("From (UTC)"), { target: { value: "2026-10-01T00:00" } });
  await userEvent.click(screen.getByRole("button", { name: "Apply" }));
  await userEvent.click(screen.getByRole("button", { name: "Export to a file" }));

  const dialog = await screen.findByRole("dialog", { name: "Sign this change" });
  expect(dialog.querySelector("pre")?.textContent).toBe(actionMessage("Server line for ExportAudit"));
  await userEvent.click(within(dialog).getByRole("button", { name: "Sign and apply" }));

  await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
  expect(api.submitted()).toEqual([
    { action: { type: "ExportAudit", from: "2026-10-01T00:00:00.000Z", to: null }, nonce: "n1", signature: "0xsig" },
  ]);
  const [blob, name] = vi.mocked(download).mock.calls[0]!;
  expect(name).toMatch(/^ethergraph-audit-\d{8}-\d{6}\.json$/);
  expect(blob.type).toBe("application/json");
  const file = JSON.parse(await blob.text()) as { from: string | null; to: string | null; rows: unknown[] };
  expect(file).toMatchObject({ from: "2026-10-01T00:00:00.000Z", to: null, rows });
});

test("a cancelled export downloads nothing", async () => {
  const api = stubAdminApi();
  renderLog();
  await userEvent.click(await screen.findByRole("button", { name: "Export to a file" }));
  const dialog = await screen.findByRole("dialog", { name: "Sign this change" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(download).not.toHaveBeenCalled();
  expect(api.submitted()).toEqual([]);
});
