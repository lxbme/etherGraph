import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../api/endpoints";
import type { MeDto } from "../api/generated/MeDto";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { useAuth } from "../auth/useMe";
import { TopBar } from "./TopBar";

const ADDR = "0xa0cf798816d4b9b9866b5330eea46a18382f251e";
const me = (is_admin = false): MeDto => ({ address: ADDR, is_admin, quota: { used: 0, limit: 5000, reset_at: "2026-10-20T00:00:00Z" } });
const summary = (ens: string | null): NodeSummaryDto => ({
  address: ADDR, kind: "eoa", display_name: ens, ens, contract_name: null, labels: [],
  partial: false, syncing: false, synced: false, hot: false, identified: false, nonce: null, balance: null,
});

function renderTopBar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TopBar search={<span />} filter={<span />} workspaceMenu={<span />} />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.spyOn(api, "nodes").mockResolvedValue([summary(null)]));
afterEach(() => vi.restoreAllMocks());

test("shows the signed-in address and a logout button", async () => {
  useAuth.setState({ status: "authenticated", me: me(), reason: null });
  renderTopBar();
  const account = screen.getByText("0xa0cf…251e");
  expect(account).toHaveAttribute("title", ADDR);
  expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
  await waitFor(() => expect(api.nodes).toHaveBeenCalledWith([ADDR]));
});

test("prefers the ENS name the backend knows", async () => {
  vi.mocked(api.nodes).mockResolvedValue([summary("alice.eth")]);
  useAuth.setState({ status: "authenticated", me: me(), reason: null });
  renderTopBar();
  expect(await screen.findByText("alice.eth")).toHaveAttribute("title", ADDR);
});

test("admins get an Admin entry", () => {
  useAuth.setState({ status: "authenticated", me: me(true), reason: null });
  renderTopBar();
  expect(screen.getByRole("link", { name: "Admin" })).toHaveAttribute("href", "#/admin");
});

test("logging out ends the session on the server and returns to the login page", async () => {
  const logout = vi.spyOn(api, "logout").mockResolvedValue(undefined);
  useAuth.setState({ status: "authenticated", me: me(), reason: null });
  renderTopBar();
  await userEvent.click(screen.getByRole("button", { name: "Log out" }));
  expect(logout).toHaveBeenCalledTimes(1);
  expect(useAuth.getState()).toMatchObject({ status: "unauthenticated", me: null, reason: null });
});
