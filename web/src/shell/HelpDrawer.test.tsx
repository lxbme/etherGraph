import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { formatCombo, SHORTCUTS } from "../graph/shortcuts";
import { useLocale } from "../i18n";
import { useUi } from "../panels/uiStore";
import { HelpDrawer } from "./HelpDrawer";
import { setReplayTourHandler } from "./tourBus";
import { TopBar } from "./TopBar";
import { useQuota } from "./statusStore";

const EN_TITLES = ["Reading the graph", "Expanding safely", "Transaction view", "Keyboard shortcuts", "Data & quotas"];

function Host() {
  return (
    <>
      <TopBar search={<span />} filter={<span />} />
      <HelpDrawer />
    </>
  );
}

beforeEach(() => {
  useLocale.getState().setLocale("en");
  useUi.setState({ helpOpen: false });
  useQuota.setState({ quota: null });
});
afterEach(() => {
  setReplayTourHandler(null);
  vi.restoreAllMocks();
});

test("the ? button opens the drawer with five sections; Escape closes it and focus returns to the button", async () => {
  const user = userEvent.setup();
  render(<Host />);
  expect(screen.queryByRole("dialog", { name: "Help" })).toBeNull();
  const button = screen.getByRole("button", { name: "Help" });
  await user.click(button);
  const drawer = screen.getByRole("dialog", { name: "Help" });
  expect(drawer).toHaveAttribute("aria-modal", "true");
  expect(drawer).toContainElement(document.activeElement as HTMLElement);
  expect(within(drawer).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(EN_TITLES);
  expect(within(drawer).getByTestId("legend-full")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Help" })).toBeNull();
  expect(button).toHaveFocus();
});

test("the close button closes the drawer; Tab stays inside it", async () => {
  const user = userEvent.setup();
  render(<Host />);
  await user.click(screen.getByRole("button", { name: "Help" }));
  const drawer = screen.getByRole("dialog", { name: "Help" });
  for (let i = 0; i < 6; i++) {
    await user.tab();
    expect(drawer).toContainElement(document.activeElement as HTMLElement);
  }
  await user.tab({ shift: true });
  expect(drawer).toContainElement(document.activeElement as HTMLElement);
  await user.click(within(drawer).getByRole("button", { name: "Close help" }));
  expect(screen.queryByRole("dialog", { name: "Help" })).toBeNull();
});

test("the shortcut table has one row per SHORTCUTS entry with the same keys", () => {
  useUi.setState({ helpOpen: true });
  render(<HelpDrawer />);
  const table = screen.getByRole("table", { name: "Keyboard shortcuts" });
  const rows = within(table).getAllByRole("row").slice(1); // header row first
  expect(rows).toHaveLength(SHORTCUTS.length);
  SHORTCUTS.forEach((s, i) => {
    const keys = [...rows[i]!.querySelectorAll("kbd")].map((k) => k.textContent);
    expect(keys).toEqual(s.keys.map((k) => formatCombo(k)));
  });
  // jsdom is not macOS: Mod reads Ctrl.
  const undo = rows[SHORTCUTS.findIndex((s) => s.id === "undo")]!;
  expect(within(undo).getByText("Undo")).toBeInTheDocument();
  expect(within(undo).getByText("Ctrl+Z")).toBeInTheDocument();
});

test("on macOS the table shows ⌘ for Mod", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  useUi.setState({ helpOpen: true });
  render(<HelpDrawer />);
  const table = screen.getByRole("table", { name: "Keyboard shortcuts" });
  expect(within(table).getByText("⌘+Z")).toBeInTheDocument();
  expect(within(table).getByText("Shift+⌘+Z")).toBeInTheDocument();
});

test("switching to zh shows the section titles in Chinese", () => {
  useUi.setState({ helpOpen: true });
  render(<HelpDrawer />);
  act(() => useLocale.getState().setLocale("zh"));
  const drawer = screen.getByRole("dialog", { name: "帮助" });
  const titles = within(drawer).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
  expect(titles).toHaveLength(5);
  expect(titles).toContain("键盘快捷键");
  for (const en of EN_TITLES) expect(titles).not.toContain(en);
});

test("Replay tour closes the drawer and asks the tour to start", async () => {
  const user = userEvent.setup();
  const start = vi.fn();
  setReplayTourHandler(start);
  useUi.setState({ helpOpen: true });
  render(<HelpDrawer />);
  await user.click(screen.getByRole("button", { name: "Replay tour" }));
  expect(start).toHaveBeenCalledTimes(1);
  expect(useUi.getState().helpOpen).toBe(false);
});

test("the daily quota is the server's limit once known, else the free-tier 100,000", () => {
  useUi.setState({ helpOpen: true });
  render(<HelpDrawer />);
  const drawer = screen.getByRole("dialog", { name: "Help" });
  expect(drawer).toHaveTextContent("Daily quota: 100,000 calls.");
  act(() => useQuota.getState().setQuota({ used: 5, limit: 250000, paused: false, reset_at: "2026-10-19T00:00:00Z" }));
  expect(drawer).toHaveTextContent("Daily quota: 250,000 calls.");
});

test("Hot is explained next to Heavy, in both languages", () => {
  useUi.setState({ helpOpen: true });
  render(<HelpDrawer />);
  expect(screen.getByRole("dialog", { name: "Help" })).toHaveTextContent("Hot: an address labelled Exchange or DeFi, or with very many neighbours.");
  act(() => useLocale.getState().setLocale("zh"));
  expect(screen.getByRole("dialog", { name: "帮助" })).toHaveTextContent("热门：带有交易所或 DeFi 标签、或邻居非常多的地址。");
});
