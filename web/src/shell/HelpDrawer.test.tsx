import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { formatCombo, SHORTCUTS } from "../graph/shortcuts";
import { useLocale } from "../i18n";
import { useUi } from "../panels/uiStore";
import { HelpDrawer } from "./HelpDrawer";
import { setReplayTourHandler } from "./tourBus";
import { TopBar } from "./TopBar";
import { useQuota } from "./statusStore";

const EN_TITLES = ["Reading the graph", "Expanding safely", "Selecting several nodes", "Identifying node types", "Labels and categories", "Transaction view", "Keyboard shortcuts", "Data & quotas"];

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

test("the ? button opens the drawer with eight sections; Escape closes it and focus returns to the button", async () => {
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
  expect(rows).toHaveLength(SHORTCUTS.length + 2); // plus the two mouse gestures
  SHORTCUTS.forEach((s, i) => {
    const keys = [...rows[i]!.querySelectorAll("kbd")].map((k) => k.textContent);
    expect(keys).toEqual(s.keys.map((k) => formatCombo(k)));
  });
  const extra = rows.slice(SHORTCUTS.length).map((r) => r.textContent);
  expect(extra[0]).toContain("Shift+drag");
  expect(extra[1]).toContain("Shift+click");
  const esc = rows[SHORTCUTS.findIndex((s) => s.id === "clearSelection")]!;
  expect(within(esc).getByText("Escape")).toBeInTheDocument();
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
  expect(titles).toHaveLength(8);
  expect(titles).toContain("框选多个节点");
  expect(titles).toContain("探明节点类型");
  expect(titles).toContain("标签与分类");
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
  expect(screen.getByRole("dialog", { name: "Help" })).toHaveTextContent("Hot: an address labelled CEX or DeFi, or with very many neighbours.");
  act(() => useLocale.getState().setLocale("zh"));
  expect(screen.getByRole("dialog", { name: "帮助" })).toHaveTextContent("热门：带有中心化交易所或 DeFi 标签、或邻居非常多的地址。");
});

test("the new sections describe selection, manual identification and label sources, and the shortcuts note allows Esc on tx tabs", () => {
  useUi.setState({ helpOpen: true });
  render(<HelpDrawer />);
  const drawer = screen.getByRole("dialog", { name: "Help" });
  expect(drawer).toHaveTextContent("Identify all");
  expect(drawer).toHaveTextContent("eg-server import-labels --format eth-labels --csv data/eth-labels/accounts.csv");
  expect(drawer).toHaveTextContent("eth-labels-xchain");
  expect(drawer).toHaveTextContent("only Esc still works (it clears a box selection)");
  const items = [...drawer.querySelectorAll("li")].map((l) => l.textContent ?? "");
  const graphBar = items.find((l) => l.startsWith("Address graph batch bar"))!;
  const txBar = items.find((l) => l.startsWith("Transaction tab batch bar"))!;
  expect(graphBar).toMatch(/pin/);
  expect(graphBar).toMatch(/hide/);
  expect(graphBar).not.toMatch(/add to graph/i);
  expect(txBar).toMatch(/add to graph/);
  expect(txBar).not.toMatch(/pin|hide|centers/);
  act(() => useLocale.getState().setLocale("zh"));
  const zh = screen.getByRole("dialog", { name: "帮助" });
  const zhTx = [...zh.querySelectorAll("li")].find((l) => l.textContent?.startsWith("交易标签页的批量操作栏"))!.textContent!;
  expect(zhTx).toContain("添加到图");
  expect(zhTx).not.toMatch(/固定|隐藏|中心/);
  expect(zh).toHaveTextContent("交易标签页中只有 Esc 仍然有效（清除框选）");
});
