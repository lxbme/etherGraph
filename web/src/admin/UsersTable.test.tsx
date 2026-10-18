import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getAccount, signMessage } from "wagmi/actions";
import { queryClient } from "../api/queryClient";
import { useAuth } from "../auth/useMe";
import { ADMIN, ADMIN_CHECKSUMMED, USER, USERS, actionMessage, adminMe, json, refused, stubAdminApi } from "./adminApi.testutil";
import { ActionConfirmDialog } from "./AdminView";
import { useAdminMode } from "./adminMode";
import { useActionConfirm } from "./useAdminAction";
import { UsersTable } from "./UsersTable";

vi.mock("wagmi/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wagmi/actions")>()),
  getAccount: vi.fn(),
  signMessage: vi.fn(),
  watchAccount: vi.fn(() => () => {}),
}));

function renderTable() {
  return render(
    <QueryClientProvider client={queryClient}>
      <UsersTable />
      <ActionConfirmDialog />
    </QueryClientProvider>,
  );
}

async function signConfirm(expectedLine: string) {
  const dialog = await screen.findByRole("dialog", { name: "Sign this change" });
  expect(dialog.querySelector("pre")?.textContent).toBe(actionMessage(expectedLine));
  await userEvent.click(within(dialog).getByRole("button", { name: "Sign and apply" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

const userRow = async (address: string) => (await screen.findByText(address)).closest("tr")!;

beforeEach(() => {
  useAuth.setState({ status: "authenticated", me: adminMe(), reason: null });
  useAdminMode.setState({ status: "on", expiresAt: "2099-01-01T00:00:00.000Z", ended: false, error: null });
  vi.mocked(getAccount).mockReturnValue({ address: ADMIN_CHECKSUMMED } as never);
  vi.mocked(signMessage).mockResolvedValue("0xsig");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(signMessage).mockReset();
  useActionConfirm.setState({ current: null, requesting: false });
  queryClient.clear();
});

test("shows each user's usage figures and effective quota", async () => {
  stubAdminApi();
  renderTable();
  const user = await userRow(USER);
  expect(within(user).getByText("900")).toBeInTheDocument();
  expect(within(user).getByText("1,000")).toBeInTheDocument();
  expect(within(user).getByText("own")).toBeInTheDocument();
  expect(within(user).getByText("3")).toBeInTheDocument();
  const admin = await userRow(ADMIN);
  expect(within(admin).getByText("admin")).toBeInTheDocument();
  expect(within(admin).getByText("default")).toBeInTheDocument();
  // The default applies already: nothing to reset.
  expect(within(admin).queryByRole("button", { name: /Use the default quota/ })).toBeNull();
});

test("editing a user's quota signs SetUserQuota with the new value", async () => {
  const api = stubAdminApi();
  renderTable();
  const row = await userRow(USER);
  await userEvent.click(within(row).getByRole("button", { name: `Edit the daily quota of ${USER}` }));
  const input = within(row).getByRole("spinbutton", { name: `Daily quota of ${USER}` });
  expect(input).toHaveValue(1000);
  await userEvent.clear(input);
  await userEvent.type(input, "2500");
  await userEvent.click(within(row).getByRole("button", { name: "Save" }));
  await signConfirm("Server line for SetUserQuota");
  expect(api.submitted()).toEqual([{ action: { type: "SetUserQuota", address: USER, calls: 2500 }, nonce: "n1", signature: "0xsig" }]);
});

test("resetting a user's quota signs SetUserQuota with no value (the default)", async () => {
  const api = stubAdminApi();
  renderTable();
  const row = await userRow(USER);
  await userEvent.click(within(row).getByRole("button", { name: `Use the default quota for ${USER}` }));
  await signConfirm("Server line for SetUserQuota");
  expect(api.submitted()).toEqual([{ action: { type: "SetUserQuota", address: USER, calls: null }, nonce: "n1", signature: "0xsig" }]);
});

test("ending a user's sessions signs RevokeSessions", async () => {
  const api = stubAdminApi();
  renderTable();
  const row = await userRow(USER);
  await userEvent.click(within(row).getByRole("button", { name: `End all sessions of ${USER}` }));
  await signConfirm("Server line for RevokeSessions");
  expect(api.submitted()).toEqual([{ action: { type: "RevokeSessions", address: USER }, nonce: "n1", signature: "0xsig" }]);
});

test("a user the server does not know is reported in the dialog", async () => {
  stubAdminApi({ "POST /api/admin/actions": () => refused("no user 0xb0b0", 404) });
  renderTable();
  const row = await userRow(USER);
  await userEvent.click(within(row).getByRole("button", { name: `End all sessions of ${USER}` }));
  const dialog = await screen.findByRole("dialog", { name: "Sign this change" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Sign and apply" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Not found");
});

test("saving the quota a user already has is not offered (no override equal to the default is pinned)", async () => {
  const api = stubAdminApi();
  renderTable();
  const user = await userRow(USER);
  await userEvent.click(within(user).getByRole("button", { name: `Edit the daily quota of ${USER}` }));
  const own = within(user).getByRole("spinbutton", { name: `Daily quota of ${USER}` });
  expect(own).toHaveValue(1000);
  expect(within(user).getByRole("button", { name: "Save" })).toBeDisabled();
  await userEvent.clear(own);
  await userEvent.type(own, "1001");
  expect(within(user).getByRole("button", { name: "Save" })).toBeEnabled();

  const admin = await userRow(ADMIN);
  await userEvent.click(within(admin).getByRole("button", { name: `Edit the daily quota of ${ADMIN}` }));
  const def = within(admin).getByRole("spinbutton", { name: `Daily quota of ${ADMIN}` });
  // On the default (5,000): saving 5,000 would pin an own quota equal to it.
  await waitFor(() => expect(within(admin).getByRole("button", { name: "Save" })).toBeDisabled());
  await userEvent.clear(def);
  await userEvent.type(def, "4000");
  expect(within(admin).getByRole("button", { name: "Save" })).toBeEnabled();
  expect(api.calls.some((c) => c.path === "/api/admin/actions/nonce")).toBe(false);
});

test("a row whose own quota is set and reset re-renders without a hook-order error", async () => {
  const errors = vi.spyOn(console, "error");
  let override: number | null = null;
  stubAdminApi({
    "GET /api/admin/users": () =>
      json(200, [{ ...USERS[1]!, quota_override: override, quota_limit: override ?? 5000 }]),
  });
  renderTable();
  const row = await userRow(USER);
  expect(within(row).getByText("default")).toBeInTheDocument();
  for (const next of [2500, null, 700]) {
    override = next;
    await act(() => queryClient.refetchQueries({ queryKey: ["admin", "users"] }));
    expect(await within(await userRow(USER)).findByText(next === null ? "default" : "own")).toBeInTheDocument();
  }
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});
