import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getAccount, signMessage } from "wagmi/actions";
import { queryClient } from "../api/queryClient";
import { useAuth } from "../auth/useMe";
import { ADMIN_CHECKSUMMED, OVERVIEW, USER, actionMessage, adminMe, json, stubAdminApi } from "./adminApi.testutil";
import { ActionConfirmDialog } from "./AdminView";
import { useAdminMode } from "./adminMode";
import { useActionConfirm } from "./useAdminAction";
import { WhitelistPanel } from "./WhitelistPanel";

vi.mock("wagmi/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wagmi/actions")>()),
  getAccount: vi.fn(),
  signMessage: vi.fn(),
  watchAccount: vi.fn(() => () => {}),
}));

const NEW = "0xC0FFEE0000000000000000000000000000000003";

function renderPanel() {
  return render(
    <QueryClientProvider client={queryClient}>
      <WhitelistPanel />
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

test("lists the whitelist", async () => {
  stubAdminApi();
  renderPanel();
  const row = (await screen.findByText(USER)).closest("tr")!;
  expect(within(row).getByText("2026-10-02 07:00:00")).toBeInTheDocument();
});

test("adding an address signs WhitelistAdd for it", async () => {
  const api = stubAdminApi();
  renderPanel();
  const add = screen.getByRole("button", { name: "Add" });
  expect(add).toBeDisabled();
  await userEvent.type(screen.getByRole("textbox", { name: "Address to add" }), NEW);
  await userEvent.click(add);
  await signConfirm("Server line for WhitelistAdd");
  expect(api.submitted()).toEqual([{ action: { type: "WhitelistAdd", address: NEW.toLowerCase() }, nonce: "n1", signature: "0xsig" }]);
  // Applied: the field is cleared for the next address.
  expect(screen.getByRole("textbox", { name: "Address to add" })).toHaveValue("");
});

test("an address that is not 40 hex digits cannot be added", async () => {
  const api = stubAdminApi();
  renderPanel();
  const input = screen.getByRole("textbox", { name: "Address to add" });
  await userEvent.type(input, "0x1234");
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  expect(api.calls.some((c) => c.path === "/api/admin/actions/nonce")).toBe(false);
});

test("removing an address signs WhitelistRemove for it", async () => {
  const api = stubAdminApi();
  renderPanel();
  await userEvent.click(await screen.findByRole("button", { name: `Remove ${USER} from the whitelist` }));
  await signConfirm("Server line for WhitelistRemove");
  expect(api.submitted()).toEqual([{ action: { type: "WhitelistRemove", address: USER }, nonce: "n1", signature: "0xsig" }]);
});

test("with open registration on, the remove control says that removing only ends sessions", async () => {
  stubAdminApi({ "GET /api/admin/overview": () => json(200, { ...OVERVIEW, open_registration: true }) });
  renderPanel();
  expect(
    await screen.findByText("Open registration is on: removing an address only ends its sessions. It can sign in again right away and is added back."),
  ).toBeInTheDocument();
});

test("with open registration off, removing also ends the address's sessions", async () => {
  stubAdminApi();
  renderPanel();
  expect(await screen.findByText("Removing an address also ends all of its sessions.")).toBeInTheDocument();
});
