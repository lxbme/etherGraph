import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, within } from "@testing-library/react";
import { api } from "../api/endpoints";
import { useBoxSelection } from "../graph/boxSelection";
import { useIdentifying } from "../graph/identify";
import { useGraph } from "../graph/store";
import { BatchBar, BatchBarShell, identifyAction } from "./BatchBar";
import { useUi } from "./uiStore";

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);

function mount(ids: string[], onCancel = vi.fn(), onRun = vi.fn()) {
  const tree = (list: string[]) => (
    <QueryClientProvider client={new QueryClient()}>
      <BatchBarShell ids={list} actions={[{ id: "run", label: "Run", onClick: onRun }]} onCancel={onCancel} />
    </QueryClientProvider>
  );
  const r = render(tree(ids));
  return { ...r, rerender: (list: string[]) => r.rerender(tree(list)), onCancel, onRun };
}

beforeEach(() => {
  useUi.setState({ labelEditorFor: null, detailOpen: true });
  useBoxSelection.getState().set([]);
});

test("nothing for an empty selection; for one or more: the count, the actions and Cancel", () => {
  const { rerender, onCancel, onRun } = mount([]);
  expect(screen.queryByRole("toolbar")).toBeNull();
  rerender([A]);
  const bar = within(screen.getByRole("toolbar", { name: "Batch actions" }));
  expect(bar.getByText("1 node selected")).toBeInTheDocument();
  act(() => bar.getByRole("button", { name: "Run" }).click());
  expect(onRun).toHaveBeenCalled();
  act(() => bar.getByRole("button", { name: "Cancel" }).click());
  expect(onCancel).toHaveBeenCalled();
});

test("the batch label editor shows only for this exact selection and never opens the detail panel", () => {
  const { rerender } = mount([A, B]);
  useUi.setState({ detailOpen: false });
  act(() => useUi.getState().openLabelEditor([B.toUpperCase().replace("0X", "0x"), A]));
  expect(useUi.getState()).toMatchObject({ labelEditorFor: [B, A], detailOpen: false });
  expect(screen.getByLabelText("Label text")).toBeInTheDocument();
  rerender([A]);
  expect(screen.queryByLabelText("Label text")).toBeNull();
});

test("a batch label request goes away with its selection, so the same selection later does not reopen it", () => {
  const { rerender } = mount([A, B]);
  act(() => useUi.getState().openLabelEditor([A, B]));
  rerender([]);
  expect(useUi.getState().labelEditorFor).toBeNull();
  rerender([A, B]);
  expect(screen.queryByLabelText("Label text")).toBeNull();
});

test("batch Identify keeps the selection when a run is already in flight, and clears it otherwise", async () => {
  const identify = vi.spyOn(api, "identify").mockResolvedValue({ queued: 1, jobs: [] });
  const n = { address: A, kind: "unknown", identified: false } as never;
  const clear = vi.fn();
  const [action] = identifyAction([A], [n], clear, () => "Identify type");
  useIdentifying.setState({ running: true });
  action!.onClick();
  expect(identify).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
  useIdentifying.setState({ running: false });
  action!.onClick();
  expect(clear).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(identify).toHaveBeenCalled());
});

test("'Expand as centers' hands only the non-center ids to onMakeCenters, leaves the centers alone and clears the selection", () => {
  useGraph.getState().reset();
  useGraph.getState().addCenter(A);
  useBoxSelection.getState().set([A.toUpperCase().replace("0X", "0x"), B]);
  const onMakeCenters = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <BatchBar nodes={[]} onMakeCenters={onMakeCenters} />
    </QueryClientProvider>,
  );
  act(() => screen.getByRole("button", { name: "Expand as centers" }).click());
  expect(onMakeCenters).toHaveBeenCalledWith([B]);
  expect(useGraph.getState().centers).toEqual([A]);
  expect(useBoxSelection.getState().ids).toEqual([]);
});

test("no 'Expand as centers' when every selected node is already a center", () => {
  useGraph.getState().reset();
  useGraph.getState().addCenter(A);
  useBoxSelection.getState().set([A]);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <BatchBar nodes={[]} onMakeCenters={vi.fn()} />
    </QueryClientProvider>,
  );
  expect(screen.getByRole("toolbar", { name: "Batch actions" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Expand as centers" })).toBeNull();
});
