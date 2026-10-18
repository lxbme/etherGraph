import { act, fireEvent, render, screen } from "@testing-library/react";
import { api } from "../api/endpoints";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { useGraph } from "../graph/store";
import { TxContextMenu } from "./TxContextMenu";
import { useUi } from "./uiStore";

const A = "0x" + "aa".repeat(20);
const node = (identified: boolean): NodeSummaryDto => ({
  address: A, kind: "unknown", display_name: null, ens: null, contract_name: null, labels: [],
  partial: false, syncing: false, synced: true, hot: false, identified, nonce: null, balance: null,
});

beforeEach(() => {
  useGraph.getState().reset();
  useUi.setState({ labelEditorFor: null });
});
afterEach(() => vi.restoreAllMocks());

test("identify (only when needed), add to graph, add label, copy and Etherscan; closes after an action", async () => {
  const identify = vi.spyOn(api, "identify").mockResolvedValue({ queued: 1, jobs: [1] });
  const onClose = vi.fn();
  const { unmount } = render(<TxContextMenu x={1} y={2} node={node(true)} onClose={onClose} />);
  expect(screen.queryByRole("menuitem", { name: "Identify type" })).toBeNull();
  expect(screen.getAllByRole("menuitem").map((e) => e.textContent)).toEqual([
    "Add to graph", "Add label / note", "Copy address", "Open in Etherscan",
  ]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Add to graph" }));
  expect(useGraph.getState().centers).toContain(A);
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("menuitem", { name: "Add label / note" }));
  expect(useUi.getState().labelEditorFor).toBe(A);
  unmount();

  render(<TxContextMenu x={1} y={2} node={node(false)} onClose={onClose} />);
  await act(async () => screen.getByRole("menuitem", { name: "Identify type" }).click());
  expect(identify).toHaveBeenCalledWith(expect.objectContaining({ addresses: [A] }));
});

test("Escape closes it", () => {
  const onClose = vi.fn();
  render(<TxContextMenu x={1} y={2} node={node(true)} onClose={onClose} />);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});
