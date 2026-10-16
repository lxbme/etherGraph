import { act, fireEvent, render, screen } from "@testing-library/react";
import type { GraphResponseDto } from "../api/generated/GraphResponseDto";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { useShortcuts } from "../graph/useShortcuts";
import { useGraph } from "../graph/store";
import { ContextMenu } from "./ContextMenu";
import { useUi } from "./uiStore";

const A = "0x" + "aa".repeat(20);
const node = (partial: boolean): NodeSummaryDto => ({
  address: A, kind: "eoa", display_name: null, ens: null, contract_name: null, labels: [],
  partial, syncing: false, synced: true, hot: false,
});
const data: GraphResponseDto = { nodes: [], edges: [], omitted: {}, coverage: {} };
const menu = (partial: boolean) => (
  <ContextMenu x={1} y={2} node={node(partial)} data={data} byAmount={false}
    onExpandSelect={() => {}} onExpandTop={() => {}} onClose={() => {}} />
);

beforeEach(() => {
  useGraph.getState().reset();
  useUi.setState({ labelEditorFor: null });
});

test("'older' item only appears for partial nodes", () => {
  const { unmount } = render(menu(false));
  expect(screen.queryByText("继续拉更早的记录")).toBeNull();
  unmount();
  render(menu(true));
  expect(screen.getByText("继续拉更早的记录")).toBeInTheDocument();
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

test("Ctrl+S, Ctrl+F and Alt+H trigger no action and no preventDefault", () => {
  render(<Host />);
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  for (const init of [{ key: "s", ctrlKey: true }, { key: "f", ctrlKey: true }, { key: "h", altKey: true }]) {
    const ev = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  }
  expect(useGraph.getState().ui[A]).toBeUndefined();
});
