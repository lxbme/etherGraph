import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { api } from "../api/endpoints";
import { queryClient } from "../api/queryClient";
import { AuthGate } from "./AuthGate";
import { page, useAuth } from "./useMe";

const ME = {
  address: "0xa0cf798816d4b9b9866b5330eea46a18382f251e",
  is_admin: false,
  quota: { used: 1, limit: 5000, reset_at: "2026-10-20T00:00:00Z" },
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const unauthorized = (reason = "no_session") => json(401, { error: { code: "unauthorized", message: reason } });

/** `fetch` answering by path; anything else is a network failure. */
function stubApi(routes: Record<string, () => Response>) {
  const f = vi.fn(async (url: string) => {
    const route = routes[url.split("?")[0]!];
    if (!route) throw new TypeError("no route");
    return route();
  });
  vi.stubGlobal("fetch", f);
  return f;
}

function renderGate() {
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <div>the shell</div>
      </AuthGate>
    </QueryClientProvider>,
  );
}

beforeEach(() => useAuth.setState({ status: "loading", me: null, reason: null }));
afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

test("without a session the login page is shown, not the shell", async () => {
  stubApi({ "/api/auth/me": () => unauthorized() });
  renderGate();
  expect(await screen.findByRole("button", { name: "Connect wallet" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "etherGraph" })).toBeInTheDocument();
  expect(screen.queryByText("the shell")).not.toBeInTheDocument();
  // A first visit is not an ended session: no reason is shown.
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("with a session the shell is shown", async () => {
  stubApi({ "/api/auth/me": () => json(200, ME) });
  renderGate();
  expect(await screen.findByText("the shell")).toBeInTheDocument();
  expect(useAuth.getState().me).toEqual(ME);
  expect(screen.queryByRole("button", { name: "Connect wallet" })).not.toBeInTheDocument();
});

test("a 401 mid-session clears the query cache and returns to the login page", async () => {
  let session = true;
  stubApi({
    "/api/auth/me": () => (session ? json(200, ME) : unauthorized()),
    "/api/status": () => unauthorized(),
  });
  renderGate();
  await screen.findByText("the shell");
  queryClient.setQueryData(["labels", ME.address], [{ id: 1 }]);
  session = false;
  await act(async () => {
    await api.status().catch(() => {});
  });
  expect(await screen.findByRole("button", { name: "Connect wallet" })).toBeInTheDocument();
  expect(screen.queryByText("the shell")).not.toBeInTheDocument();
  expect(queryClient.getQueryData(["labels", ME.address])).toBeUndefined();
  expect(screen.getByRole("alert")).toHaveTextContent("Your session has ended. Sign in again.");
});

test("a login refused for a non-whitelisted address says so", async () => {
  stubApi({ "/api/auth/me": () => unauthorized() });
  renderGate();
  await screen.findByRole("button", { name: "Connect wallet" });
  act(() => useAuth.setState({ reason: "not_whitelisted" }));
  expect(screen.getByRole("alert")).toHaveTextContent("This address is not on the whitelist yet");
});

test("an unreachable server shows the login page with the reason", async () => {
  stubApi({});
  renderGate();
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Cannot reach the server"));
  expect(screen.queryByText("the shell")).not.toBeInTheDocument();
});

test("coming back to the tab checks who is signed in: another address restarts the page", async () => {
  const restart = vi.spyOn(page, "restart").mockImplementation(() => {});
  let address = ME.address;
  stubApi({ "/api/auth/me": () => json(200, { ...ME, address }) });
  renderGate();
  await screen.findByText("the shell");
  address = "0xb0b0000000000000000000000000000000000002";
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  await waitFor(() => expect(restart).toHaveBeenCalledTimes(1));
  restart.mockRestore();
});
