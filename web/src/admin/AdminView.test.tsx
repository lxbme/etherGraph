import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getAccount, signMessage } from "wagmi/actions";
import type { SiweFieldsDto } from "../api/generated/SiweFieldsDto";
import { queryClient } from "../api/queryClient";
import { siweMessage } from "../auth/siweAdapter";
import { useAuth } from "../auth/useMe";
import { useAdminRoute } from "../shell/hashRoute";
import { ADMIN, ADMIN_CHECKSUMMED, OVERVIEW, actionMessage, adminMe, json, refused, stubAdminApi } from "./adminApi.testutil";
import { Toasts, clearToasts } from "../shell/Toasts";
import { AdminPage } from "./AdminView";
import { useAdminMode } from "./adminMode";
import { useActionConfirm } from "./useAdminAction";

vi.mock("wagmi/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wagmi/actions")>()),
  getAccount: vi.fn(),
  signMessage: vi.fn(),
  watchAccount: vi.fn(() => () => {}),
}));

const FIELDS: SiweFieldsDto = {
  domain: "127.0.0.1:8080",
  address: ADMIN,
  statement: "Enter etherGraph admin mode",
  uri: "http://127.0.0.1:8080",
  version: "1",
  chain_id: 1,
  nonce: "adminnonce1",
  issued_at: "2026-10-19T10:00:00.000Z",
  expiration_time: "2026-10-19T10:05:00.000Z",
};

function renderAdmin() {
  return render(
    <QueryClientProvider client={queryClient}>
      <AdminPage />
      <Toasts />
    </QueryClientProvider>,
  );
}

/** Signs the message of an action control and returns the submitted action. */
async function signConfirm() {
  const dialog = await screen.findByRole("dialog", { name: "Sign this change" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Sign and apply" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

beforeEach(() => {
  useAuth.setState({ status: "authenticated", me: adminMe(), reason: null });
  useAdminMode.setState({ status: "checking", expiresAt: null, ended: false, error: null });
  vi.mocked(getAccount).mockReturnValue({ address: ADMIN_CHECKSUMMED } as never);
  vi.mocked(signMessage).mockResolvedValue("0xsig");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(signMessage).mockReset();
  useActionConfirm.setState({ current: null, requesting: false });
  useAdminRoute.setState({ open: false });
  queryClient.clear();
  clearToasts();
});

test("a user who is not an admin finds nothing here, and no admin API is called", async () => {
  useAuth.setState({ status: "authenticated", me: adminMe(false), reason: null });
  const api = stubAdminApi();
  renderAdmin();
  expect(screen.getByRole("heading", { name: "Not found" })).toBeInTheDocument();
  // Nothing says there is an admin page here.
  expect(screen.queryByRole("heading", { name: "Admin" })).toBeNull();
  expect(screen.queryByText("Admin")).toBeNull();
  expect(screen.queryByRole("button", { name: "Enter admin mode" })).toBeNull();
  expect(api.calls.filter((c) => c.path.startsWith("/api/admin"))).toEqual([]);
});

test("without admin mode the admin signs the server's admin-mode message to enter it", async () => {
  let active = false;
  const api = stubAdminApi({
    "GET /api/admin/session": () => (active ? json(200, { address: ADMIN, expires_at: "2099-01-01T00:00:00.000Z" }) : refused("no_admin_session")),
    "GET /api/admin/session/nonce": () => json(200, FIELDS),
    "POST /api/admin/session": () => {
      active = true;
      return json(200, { address: ADMIN, expires_at: "2099-01-01T00:00:00.000Z" });
    },
  });
  renderAdmin();
  await userEvent.click(await screen.findByRole("button", { name: "Enter admin mode" }));

  expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
  const message = siweMessage(FIELDS, ADMIN);
  expect(message).toContain("Enter etherGraph admin mode");
  expect(vi.mocked(signMessage).mock.calls[0]![1]).toEqual({ message, account: ADMIN_CHECKSUMMED });
  expect(api.calls.find((c) => c.method === "POST" && c.path === "/api/admin/session")?.body).toEqual({ message, signature: "0xsig" });
  // The user session is not touched by any of this.
  expect(useAuth.getState().status).toBe("authenticated");
});

test("a refused admin-mode signature stays on the enter step with the reason", async () => {
  stubAdminApi({
    "GET /api/admin/session": () => refused("no_admin_session"),
    "GET /api/admin/session/nonce": () => json(200, FIELDS),
    "POST /api/admin/session": () => refused("bad_signature"),
  });
  renderAdmin();
  await userEvent.click(await screen.findByRole("button", { name: "Enter admin mode" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("The signature does not match your address.");
  expect(screen.getByRole("button", { name: "Enter admin mode" })).toBeInTheDocument();
});

test("without a connected wallet the enter step offers to connect one", async () => {
  vi.mocked(getAccount).mockReturnValue({ address: undefined } as never);
  stubAdminApi({ "GET /api/admin/session": () => refused("no_admin_session") });
  renderAdmin();
  expect(await screen.findByText(`Connect the wallet of ${ADMIN} to sign.`)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Enter admin mode" })).toBeDisabled();
});

test("admin mode ending (401 no_admin_session on a read) returns to the enter step", async () => {
  let expired = false;
  stubAdminApi({
    "GET /api/admin/session": () => (expired ? refused("no_admin_session") : json(200, { address: ADMIN, expires_at: "2099-01-01T00:00:00.000Z" })),
    "GET /api/admin/users": () => (expired ? refused("no_admin_session") : json(200, [])),
  });
  renderAdmin();
  await screen.findByRole("heading", { name: "Overview" });
  expired = true;
  await queryClient.refetchQueries({ queryKey: ["admin", "users"] });

  expect(await screen.findByRole("button", { name: "Enter admin mode" })).toBeInTheDocument();
  expect(screen.getByText("Admin mode has ended. Sign again to continue.")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Overview" })).toBeNull();
  expect(useAuth.getState().status).toBe("authenticated");
});

test("admin mode reaching its expiry time returns to the enter step", async () => {
  stubAdminApi({
    "GET /api/admin/session": () => json(200, { address: ADMIN, expires_at: new Date(Date.now() + 300).toISOString() }),
  });
  renderAdmin();
  await screen.findByRole("heading", { name: "Overview" });
  expect(await screen.findByRole("button", { name: "Enter admin mode" }, { timeout: 3000 })).toBeInTheDocument();
});

test("leaving admin mode ends it on the server", async () => {
  const api = stubAdminApi({ "DELETE /api/admin/session": () => new Response(null, { status: 204 }) });
  renderAdmin();
  await screen.findByRole("heading", { name: "Overview" });
  await userEvent.click(screen.getByRole("button", { name: "Leave admin mode" }));
  expect(await screen.findByRole("button", { name: "Enter admin mode" })).toBeInTheDocument();
  expect(api.calls.some((c) => c.method === "DELETE" && c.path === "/api/admin/session")).toBe(true);
});

test("a failed leave says so and keeps what the server says (still in admin mode)", async () => {
  const api = stubAdminApi({ "DELETE /api/admin/session": () => json(500, { error: { code: "internal", message: "db down" } }) });
  renderAdmin();
  await screen.findByRole("heading", { name: "Overview" });
  await userEvent.click(screen.getByRole("button", { name: "Leave admin mode" }));

  expect(await screen.findByText("Internal server error")).toBeInTheDocument();
  await waitFor(() => expect(api.calls.filter((c) => c.method === "GET" && c.path === "/api/admin/session")).toHaveLength(2));
  expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
  expect(useAdminMode.getState().status).toBe("on");
  expect(screen.queryByRole("button", { name: "Enter admin mode" })).toBeNull();
});

test("the overview shows server usage and the settings", async () => {
  stubAdminApi();
  renderAdmin();
  const overview = (await screen.findByRole("heading", { name: "Overview" })).closest("section")!;
  expect(await within(overview).findByText("1,234 / 100,000")).toBeInTheDocument();
  expect(within(overview).getByRole("switch", { name: "Open registration" })).not.toBeChecked();
  expect(within(overview).getByRole("spinbutton", { name: "Default daily quota" })).toHaveValue(5000);
});

test("the open-registration switch signs SetOpenRegistration", async () => {
  const api = stubAdminApi();
  renderAdmin();
  await userEvent.click(await screen.findByRole("switch", { name: "Open registration" }));
  const dialog = await screen.findByRole("dialog", { name: "Sign this change" });
  expect(dialog.querySelector("pre")?.textContent).toBe(actionMessage("Server line for SetOpenRegistration"));
  await signConfirm();
  expect(api.submitted()).toEqual([{ action: { type: "SetOpenRegistration", open: true }, nonce: "n1", signature: "0xsig" }]);
});

test("changing the default quota signs SetDefaultQuota", async () => {
  const api = stubAdminApi();
  renderAdmin();
  const input = await screen.findByRole("spinbutton", { name: "Default daily quota" });
  await waitFor(() => expect(input).toHaveValue(OVERVIEW.default_quota));
  await userEvent.clear(input);
  await userEvent.type(input, "6000");
  await userEvent.click(screen.getByRole("button", { name: "Change default quota" }));
  await signConfirm();
  expect(api.submitted()).toEqual([{ action: { type: "SetDefaultQuota", calls: 6000 }, nonce: "n1", signature: "0xsig" }]);
});

test("the back button leaves the admin page", async () => {
  stubAdminApi();
  useAdminRoute.setState({ open: true });
  renderAdmin();
  await userEvent.click(screen.getByRole("button", { name: "Back to the graph" }));
  expect(useAdminRoute.getState().open).toBe(false);
});
