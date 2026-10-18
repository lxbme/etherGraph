import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { getAccount, signMessage } from "wagmi/actions";
import type { AdminAction } from "../api/generated/AdminAction";
import { queryClient } from "../api/queryClient";
import { useAuth } from "../auth/useMe";
import { ADMIN, ADMIN_CHECKSUMMED, USER, actionMessage, adminMe, refused, stubAdminApi } from "./adminApi.testutil";
import { ActionConfirmDialog } from "./AdminView";
import { useAdminMode } from "./adminMode";
import { useAdminAction, useActionConfirm } from "./useAdminAction";

vi.mock("wagmi/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wagmi/actions")>()),
  getAccount: vi.fn(),
  signMessage: vi.fn(),
  watchAccount: vi.fn(() => () => {}),
}));

const ADD: AdminAction = { type: "WhitelistAdd", address: USER };

function Harness({ action }: { action: AdminAction }) {
  const { run, busy } = useAdminAction();
  const [result, setResult] = useState("");
  return (
    <QueryClientProvider client={queryClient}>
      <button disabled={busy} onClick={() => void run(action).then((r) => setResult(r ? "applied" : "nothing"))}>
        go
      </button>
      <output>{result}</output>
      <ActionConfirmDialog />
    </QueryClientProvider>
  );
}

async function openConfirm(action: AdminAction = ADD) {
  render(<Harness action={action} />);
  await userEvent.click(screen.getByRole("button", { name: "go" }));
  return screen.findByRole("dialog", { name: "Sign this change" });
}

beforeEach(() => {
  useAuth.setState({ status: "authenticated", me: adminMe(), reason: null });
  useAdminMode.setState({ status: "on", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), ended: false, error: null });
  vi.mocked(getAccount).mockReturnValue({ address: ADMIN_CHECKSUMMED } as never);
  vi.mocked(signMessage).mockResolvedValue("0xsig");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(signMessage).mockReset();
  useActionConfirm.setState({ current: null, requesting: false });
  queryClient.clear();
});

test("shows the server's message verbatim before signing, then signs it and submits the same action", async () => {
  const api = stubAdminApi();
  const dialog = await openConfirm();

  expect(api.calls.find((c) => c.path === "/api/admin/actions/nonce")?.body).toEqual({ action: ADD });
  expect(dialog.querySelector("pre")?.textContent).toBe(actionMessage("Server line for WhitelistAdd"));
  expect(signMessage).not.toHaveBeenCalled();
  expect(api.submitted()).toEqual([]);

  await userEvent.click(within(dialog).getByRole("button", { name: "Sign and apply" }));
  expect(await screen.findByText("applied")).toBeInTheDocument();
  expect(signMessage).toHaveBeenCalledTimes(1);
  expect(vi.mocked(signMessage).mock.calls[0]![1]).toEqual({
    message: actionMessage("Server line for WhitelistAdd"),
    account: ADMIN_CHECKSUMMED,
  });
  expect(api.submitted()).toEqual([{ action: ADD, nonce: "n1", signature: "0xsig" }]);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("cancelling the confirm dialog signs and submits nothing", async () => {
  const api = stubAdminApi();
  const dialog = await openConfirm();
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

  expect(await screen.findByText("nothing")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(signMessage).not.toHaveBeenCalled();
  expect(api.submitted()).toEqual([]);
});

test("refusing the signature in the wallet submits nothing", async () => {
  const api = stubAdminApi();
  vi.mocked(signMessage).mockRejectedValue(Object.assign(new Error("User rejected the request."), { name: "UserRejectedRequestError", code: 4001 }));
  const dialog = await openConfirm();
  await userEvent.click(within(dialog).getByRole("button", { name: "Sign and apply" }));

  expect(await screen.findByText("nothing")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.submitted()).toEqual([]);
});

test("a wallet connected with another address cannot sign: nothing is submitted", async () => {
  const api = stubAdminApi();
  vi.mocked(getAccount).mockReturnValue({ address: USER } as never);
  const dialog = await openConfirm();
  await userEvent.click(within(dialog).getByRole("button", { name: "Sign and apply" }));

  expect(await within(dialog).findByRole("alert")).toHaveTextContent(`Connect the wallet of ${ADMIN} to sign.`);
  expect(signMessage).not.toHaveBeenCalled();
  expect(api.submitted()).toEqual([]);
});

test("a refused action shows the server's reason", async () => {
  stubAdminApi({ "POST /api/admin/actions": () => refused("stale_action") });
  const dialog = await openConfirm();
  await userEvent.click(within(dialog).getByRole("button", { name: "Sign and apply" }));

  expect(await within(dialog).findByRole("alert")).toHaveTextContent("The values changed after this message was written");
  expect(within(dialog).queryByRole("button", { name: "Sign and apply" })).toBeNull();
  await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(await screen.findByText("nothing")).toBeInTheDocument();
});

test("admin mode ending while an action is submitted returns to the enter step", async () => {
  stubAdminApi({ "POST /api/admin/actions": () => refused("no_admin_session") });
  const dialog = await openConfirm();
  await userEvent.click(within(dialog).getByRole("button", { name: "Sign and apply" }));

  expect(await screen.findByText("nothing")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(useAdminMode.getState()).toMatchObject({ status: "off", ended: true });
  // The user session is untouched: only no_session ends it.
  expect(useAuth.getState().status).toBe("authenticated");
});

test("admin mode already over when the nonce is requested: no dialog, back to the enter step", async () => {
  const api = stubAdminApi({ "POST /api/admin/actions/nonce": () => refused("no_admin_session") });
  render(<Harness action={ADD} />);
  await userEvent.click(screen.getByRole("button", { name: "go" }));

  expect(await screen.findByText("nothing")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(useAdminMode.getState().status).toBe("off");
  expect(api.submitted()).toEqual([]);
});

test("the controls stay busy while a confirm is open", async () => {
  stubAdminApi();
  await openConfirm();
  expect(screen.getByRole("button", { name: "go" })).toBeDisabled();
  await waitFor(() => expect(useActionConfirm.getState().current?.nonce).toBe("n1"));
});

describe("cancelling while the wallet is asked to sign", () => {
  /** signMessage held until the test settles it. */
  function heldSignature() {
    let resolve!: (s: `0x${string}`) => void;
    let reject!: (e: unknown) => void;
    vi.mocked(signMessage).mockReturnValue(new Promise((res, rej) => ((resolve = res), (reject = rej))));
    return { resolve: (s: `0x${string}`) => resolve(s), reject: (e: unknown) => reject(e) };
  }

  test.each([
    ["the Cancel button", () => userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }))],
    ["Escape", async () => void fireEvent.keyDown(document, { key: "Escape" })],
  ])("%s closes the dialog; a signature arriving later is dropped", async (_, cancel) => {
    const api = stubAdminApi();
    const held = heldSignature();
    const dialog = await openConfirm();
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign and apply" }));
    expect(within(dialog).getByText("Waiting for your wallet…")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
    await cancel();

    expect(await screen.findByText("nothing")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    held.resolve("0xlate");
    await new Promise((r) => setTimeout(r, 20));
    expect(api.submitted()).toEqual([]);
  });

  test("a refusal arriving after cancel does not touch the next action's dialog", async () => {
    stubAdminApi();
    const held = heldSignature();
    const dialog = await openConfirm();
    await userEvent.click(within(dialog).getByRole("button", { name: "Sign and apply" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await screen.findByText("nothing");
    // The next action's dialog is open when the wallet finally refuses the first one.
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    const next = await screen.findByRole("dialog", { name: "Sign this change" });
    held.reject(Object.assign(new Error("User rejected the request."), { code: 4001 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(next).toBeInTheDocument();
    expect(useActionConfirm.getState().current?.phase).toBe("confirm");
  });
});
