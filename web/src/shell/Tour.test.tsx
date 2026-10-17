import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocale } from "../i18n";
import { useUi } from "../panels/uiStore";
import { HelpDrawer } from "./HelpDrawer";
import { TOUR_DONE_KEY, Tour, useTour } from "./Tour";
import { setReplayTourHandler } from "./tourBus";
import { TopBar } from "./TopBar";
import { Legend } from "../views/Legend";

/** jsdom lays nothing out: give a target a box and an offsetParent so it counts as visible. */
function show(el: Element) {
  Object.defineProperty(el, "offsetParent", { configurable: true, value: document.body });
  el.getBoundingClientRect = () => ({ x: 10, y: 10, left: 10, top: 10, right: 110, bottom: 40, width: 100, height: 30, toJSON: () => ({}) });
}

function Targets({ legend = true }: { legend?: boolean }) {
  return (
    <>
      <div data-tour="search" ref={(el) => { if (el) show(el); }} />
      {legend && <div data-tour="legend" ref={(el) => { if (el) show(el); }} />}
      <button data-tour="help" ref={(el) => { if (el) show(el); }}>?</button>
    </>
  );
}

beforeEach(() => {
  localStorage.clear();
  useLocale.getState().setLocale("en");
  useTour.setState({ step: null });
  useUi.setState({ helpOpen: false });
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  setReplayTourHandler(null);
  vi.restoreAllMocks();
});

async function begin() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
}

test("first run shows step 1; Next, Next, Done writes the flag and a remount stays quiet", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const { unmount } = render(<><Targets /><Tour /></>);
  expect(screen.queryByRole("dialog")).toBeNull();
  await begin();
  expect(screen.getByRole("dialog", { name: "Search an address" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByRole("dialog", { name: "Legend" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByRole("dialog", { name: "Help" })).toBeInTheDocument();
  expect(localStorage.getItem(TOUR_DONE_KEY)).toBeNull();
  await user.click(screen.getByRole("button", { name: "Done" }));
  expect(localStorage.getItem(TOUR_DONE_KEY)).toBe("1");
  expect(screen.queryByRole("dialog")).toBeNull();
  unmount();
  render(<><Targets /><Tour /></>);
  await begin();
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("Skip and Escape write the flag", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<><Targets /><Tour /></>);
  await begin();
  await user.click(screen.getByRole("button", { name: "Skip" }));
  expect(localStorage.getItem(TOUR_DONE_KEY)).toBe("1");
  expect(screen.queryByRole("dialog")).toBeNull();
  localStorage.clear();
  act(() => useTour.getState().start());
  await user.keyboard("{Escape}");
  expect(localStorage.getItem(TOUR_DONE_KEY)).toBe("1");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("an empty canvas's header-only legend is step 2", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<><Targets legend={false} /><Legend groups={[]} collapsedKey="eg.test.legend" /><Tour /></>);
  show(document.querySelector('[data-tour="legend"]')!);
  await begin();
  await user.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByRole("dialog", { name: "Legend" })).toBeInTheDocument();
});

test("a missing legend is skipped: Next on step 1 lands on the help step", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(<><Targets legend={false} /><Tour /></>);
  await begin();
  await user.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByRole("dialog", { name: "Help" })).toBeInTheDocument();
});

test("with no target at all the tour ends without writing the flag", async () => {
  render(<Tour />);
  await begin();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(useTour.getState().step).toBeNull();
  expect(localStorage.getItem(TOUR_DONE_KEY)).toBeNull();
});

test("Replay tour in the help drawer restarts from step 1", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  localStorage.setItem(TOUR_DONE_KEY, "1");
  render(<><Targets /><Tour /><TopBar search={<span />} filter={<span />} /><HelpDrawer /></>);
  await begin();
  expect(screen.queryByRole("dialog", { name: "Search an address" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Help" }));
  await user.click(screen.getByRole("button", { name: "Replay tour" }));
  expect(screen.getByRole("dialog", { name: "Search an address" })).toBeInTheDocument();
});

test("a throwing localStorage does not stop the tour or raise", async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("denied");
  });
  render(<><Targets /><Tour /></>);
  await begin();
  expect(screen.getByRole("dialog", { name: "Search an address" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Skip" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
