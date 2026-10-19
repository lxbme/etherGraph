import { act, fireEvent, render, screen } from "@testing-library/react";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { api } from "../api/endpoints";
import { useShortcuts } from "../graph/useShortcuts";
import { useTabs } from "../shell/tabs";
import { useGraph } from "../graph/store";
import { ContextMenu } from "./ContextMenu";
import { useUi } from "./uiStore";

const A = "0x" + "aa".repeat(20);
const node = (partial: boolean, kind: NodeSummaryDto["kind"] = "eoa"): NodeSummaryDto => ({
  address: A, kind, display_name: null, ens: null, contract_name: null, labels: [],
  partial, syncing: false, synced: true, hot: false, identified: true, nonce: null, balance: null,
});
const data: GraphResponseDto = { nodes: [], edges: [], omitted: {}, coverage: {} };
const menu = (
  partial: boolean,
  kind: NodeSummaryDto["kind"] = "eoa",
  onExpand = () => {},
  onBrowse = () => {},
  onExpandSelf = () => {},
) => (
  <ContextMenu
    x={1} y={2} node={node(partial, kind)} data={data}
    onExpand={onExpand} onBrowse={onBrowse} onExpandSelf={onExpandSelf} onClose={() => {}}
  />
);

beforeEach(() => {
  useGraph.getState().reset();
  useUi.setState({ labelEditorFor: null });
  useTabs.setState({ tabs: [{ id: "graph" }], active: "graph" });
});
afterEach(() => vi.restoreAllMocks());

test("'older' item only appears for partial nodes", () => {
  const { unmount } = render(menu(false));
  expect(screen.queryByText("Fetch older records")).toBeNull();
  unmount();
  render(menu(true));
  expect(screen.getByText("Fetch older records")).toBeInTheDocument();
});

test("wallets and unknown nodes get one 'Expand neighbors…' item; contracts get none", () => {
  for (const kind of ["eoa", "unknown"] as const) {
    const onExpand = vi.fn();
    const { unmount } = render(menu(false, kind, onExpand));
    expect(screen.queryByText("Select…")).toBeNull();
    expect(screen.queryByText(/^Top /)).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Expand neighbors…" }));
    expect(onExpand).toHaveBeenCalledTimes(1);
    unmount();
  }
  const onBrowse = vi.fn();
  render(menu(false, "contract", () => {}, onBrowse));
  expect(screen.queryByRole("menuitem", { name: "Expand neighbors…" })).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: "Browse interactions…" }));
  expect(onBrowse).toHaveBeenCalledTimes(1);
});

test("'Expand…' sits right before the neighbours item for wallets and contracts, runs onExpandSelf, and is absent for a center", () => {
  for (const [kind, next] of [["eoa", "Expand neighbors…"], ["contract", "Browse interactions…"]] as const) {
    const onExpandSelf = vi.fn();
    const { unmount } = render(menu(false, kind, () => {}, () => {}, onExpandSelf));
    const labels = screen.getAllByRole("menuitem").map((m) => m.textContent);
    expect(labels[labels.indexOf("Expand…") + 1]).toBe(next);
    fireEvent.click(screen.getByRole("menuitem", { name: "Expand…" }));
    expect(onExpandSelf).toHaveBeenCalledTimes(1);
    unmount();
  }
  act(() => useGraph.getState().addCenter(A));
  render(menu(false, "eoa"));
  expect(screen.queryByRole("menuitem", { name: "Expand…" })).toBeNull();
});

test("wallets have no 'Browse interactions…' item", () => {
  render(menu(false, "eoa"));
  expect(screen.queryByRole("menuitem", { name: "Browse interactions…" })).toBeNull();
});

test("'Remove as center' only shows for centers and removes the center", () => {
  const { unmount } = render(menu(false));
  expect(screen.queryByRole("menuitem", { name: "Remove as center" })).toBeNull();
  unmount();
  act(() => useGraph.getState().addCenter(A));
  render(menu(false));
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove as center" }));
  expect(useGraph.getState().centers).toEqual([]);
});

test("no key hints that would suggest the keys work while the menu is open", () => {
  const { container } = render(menu(false));
  expect(container.querySelector("kbd")).toBeNull();
});

function Host() {
  useShortcuts(() => undefined);
  return <input aria-label="t" />;
}

test("Ctrl+Z undoes hide; shortcuts ignored while typing in an input", () => {
  render(<Host />);
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  fireEvent.keyDown(document.body, { key: "h" });
  expect(useGraph.getState().ui[A]?.hidden).toBe(true);
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
  expect(useGraph.getState().ui[A]?.hidden).toBe(false);
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true, shiftKey: true });
  expect(useGraph.getState().ui[A]?.hidden).toBe(true);

  fireEvent.keyDown(screen.getByLabelText("t"), { key: "p" });
  expect(useGraph.getState().ui[A]?.pinned).toBeFalsy();
  fireEvent.keyDown(document.body, { key: "p" });
  expect(useGraph.getState().ui[A]?.pinned).toBe(true);
  fireEvent.keyDown(document.body, { key: "l" });
  expect(useUi.getState().labelEditorFor).toBe(A);
});

test("Ctrl+Alt+S, Ctrl+F and Alt+H trigger no action and no preventDefault", () => {
  render(<Host />);
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  for (const init of [{ key: "s", ctrlKey: true, altKey: true }, { key: "f", ctrlKey: true }, { key: "h", altKey: true }]) {
    const ev = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  }
  expect(useGraph.getState().ui[A]).toBeUndefined();
});

test("graph shortcuts do nothing while a tx tab is active", () => {
  const TXH = "0x" + "11".repeat(32);
  const sync = vi.spyOn(api, "sync").mockResolvedValue({ jobs: [] } as never);
  render(<Host />);
  act(() => {
    useGraph.getState().select({ kind: "node", address: A });
    useGraph.getState().setPinned([A], true); // something to undo
    useTabs.getState().openTx(TXH);
  });
  for (const init of [{ key: "s" }, { key: "h" }, { key: "p" }, { key: "f" }, { key: "l" }, { key: "z", ctrlKey: true }]) {
    const ev = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented, init.key).toBe(false);
  }
  expect(sync).not.toHaveBeenCalled();
  expect(useGraph.getState().ui[A]).toMatchObject({ pinned: true, hidden: false });
  expect(useUi.getState().labelEditorFor).toBeNull();
  // Back on the graph tab they work again.
  act(() => useTabs.getState().activate("graph"));
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
  expect(useGraph.getState().ui[A]?.pinned).toBe(false);
});

test("'Identify type' shows only for a node that needs it and queues just that address", async () => {
  const identify = vi.spyOn(api, "identify").mockResolvedValue({ queued: 1, jobs: [1] });
  const { unmount } = render(menu(false, "eoa"));
  expect(screen.queryByRole("menuitem", { name: "Identify type" })).toBeNull();
  unmount();
  const { unmount: u2 } = render(
    <ContextMenu x={1} y={2} node={{ ...node(false, "unknown"), identified: false }} data={data} onExpand={() => {}} onBrowse={() => {}} onExpandSelf={() => {}} onClose={() => {}} />,
  );
  await act(async () => screen.getByRole("menuitem", { name: "Identify type" }).click());
  expect(identify).toHaveBeenCalledWith(expect.objectContaining({ addresses: [A] }));
  u2();
  render(menu(false, "contract")); // identified: true
  expect(screen.queryByRole("menuitem", { name: "Identify type" })).toBeNull();
});
