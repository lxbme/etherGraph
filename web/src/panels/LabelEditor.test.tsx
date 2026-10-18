import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../api/endpoints";
import { ApiError } from "../api/errors";
import type { LabelDto } from "../api/generated/LabelDto";
import { clearToasts, Toasts } from "../shell/Toasts";
import { CATEGORIES, LabelEditor } from "./LabelEditor";

const addr = (n: number) => "0x" + n.toString(16).padStart(2, "0").repeat(20);
const saved: LabelDto = { id: 1, text: "team", category: "fund", source: "user" };

function mount(addresses: string[], onClose = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <LabelEditor addresses={addresses} onClose={onClose} />
      <Toasts />
    </QueryClientProvider>,
  );
  return onClose;
}

function submit(text: string, category = "fund") {
  fireEvent.change(screen.getByLabelText("Label text"), { target: { value: text } });
  fireEvent.change(screen.getByLabelText("Category"), { target: { value: category } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
}

beforeEach(() => act(() => clearToasts()));
afterEach(() => vi.restoreAllMocks());

test("offers all thirteen categories in UI order", () => {
  mount([addr(0xaa)]);
  const options = screen.getAllByRole("option").map((o) => o.textContent);
  expect(options).toEqual([
    "CEX", "DEX", "DeFi", "Bridge", "Mixer", "Scam / phishing", "Sanctioned", "Hacker / exploiter",
    "MEV bot", "Market maker / fund", "NFT marketplace", "Staking / validator", "Other",
  ]);
  expect(CATEGORIES).toHaveLength(13);
});

test("three addresses: one POST each with the same text and category, then one toast with the count", async () => {
  const add = vi.spyOn(api, "addLabel").mockResolvedValue(saved);
  const addrs = [addr(1), addr(2), addr(3)];
  const onClose = mount(addrs);
  submit(" team ");
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(add).toHaveBeenCalledTimes(3);
  expect(add.mock.calls.map((c) => c[0])).toEqual(addrs.map((address) => ({ address, text: "team", category: "fund" })));
  expect(screen.getAllByText("Added the label to 3 addresses")).toHaveLength(1);
});

test("at most four requests are in flight at once", async () => {
  let inFlight = 0;
  let peak = 0;
  const release: (() => void)[] = [];
  vi.spyOn(api, "addLabel").mockImplementation(() => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    return new Promise((r) => release.push(() => { inFlight--; r(saved); }));
  });
  const onClose = mount(Array.from({ length: 9 }, (_, i) => addr(i + 1)));
  submit("team");
  for (let done = 0; done < 9; ) {
    await waitFor(() => expect(release.length).toBeGreaterThan(0));
    const batch = release.splice(0);
    done += batch.length;
    await act(async () => batch.forEach((f) => f()));
  }
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(peak).toBe(4);
});

test("a failure shows the first error and no success toast; a retry posts only the addresses that failed", async () => {
  const add = vi.spyOn(api, "addLabel").mockImplementation(async (l) => {
    if (l.address === addr(2)) throw new ApiError("invalid_input", 400, "bad address two");
    if (l.address === addr(3)) throw new ApiError("invalid_input", 400, "bad address three");
    return saved;
  });
  const onClose = mount([addr(1), addr(2), addr(3)]);
  submit("team");
  expect(await screen.findByRole("alert")).toHaveTextContent("bad address two");
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.queryByText(/Added the label/)).toBeNull();

  add.mockClear();
  add.mockResolvedValue(saved);
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(add.mock.calls.map((c) => c[0].address)).toEqual([addr(2), addr(3)]);
  expect(screen.getByText("Added the label to 3 addresses")).toBeInTheDocument();
});

test("after a partly failed save, changing the text writes the new text to every address", async () => {
  const add = vi.spyOn(api, "addLabel").mockImplementation(async (l) => {
    if (l.address === addr(2)) throw new ApiError("invalid_input", 400, "bad");
    return saved;
  });
  const onClose = mount([addr(1), addr(2)]);
  submit("first");
  expect(await screen.findByRole("alert")).toBeInTheDocument();
  add.mockClear();
  add.mockResolvedValue(saved);
  submit("second");
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(add.mock.calls.map((c) => [c[0].address, c[0].text])).toEqual([[addr(1), "second"], [addr(2), "second"]]);
});
