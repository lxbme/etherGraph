import { act } from "@testing-library/react";
import { api } from "../api/endpoints";
import { usePick } from "../panels/pick/pickStore";
import { toast } from "../shell/Toasts";
import { useTabs } from "../shell/tabs";
import { addToGraph, introduce, pickNeighbours } from "./nodeActions";
import { useGraph } from "./store";

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const C = "0x" + "cc".repeat(20);
const TX = "0x" + "12".repeat(32);
const g = () => useGraph.getState();

vi.mock("../shell/Toasts", async (orig) => ({ ...(await orig<typeof import("../shell/Toasts")>()), toast: vi.fn() }));
const toastTexts = () => vi.mocked(toast).mock.calls.map((c) => c[0]);

beforeEach(() => {
  vi.mocked(toast).mockClear();
  usePick.getState().close();
  g().reset();
  useTabs.setState({ tabs: [{ id: "graph" }], active: "graph" });
});
afterEach(() => vi.restoreAllMocks());

describe("introduce", () => {
  test("new addresses become centers picked with none in one history step; the picker opens for them only", () => {
    g().setCenters([B]);
    const steps = g()._past.length;
    const sync = vi.spyOn(api, "sync");
    const address = vi.spyOn(api, "address");
    act(() => introduce([A.toUpperCase().replace("0X", "0x"), B, C], { activateGraph: false }));
    expect(g().centers).toEqual([B, A, C]);
    expect(g().picks[A]).toEqual([]);
    expect(g().picks[C]).toEqual([]);
    expect(usePick.getState().targets).toEqual([A, C]);
    expect(g().selection).toBeNull();
    // No upstream call: the picker asks before syncing.
    expect(sync).not.toHaveBeenCalled();
    expect(address).not.toHaveBeenCalled();
    expect(g()._past.length).toBe(steps + 1);
    act(() => g().undo());
    expect(g().centers).toEqual([B]);
  });

  test("activateGraph switches to the graph and selects the first address", () => {
    useTabs.setState({ tabs: [{ id: "graph" }, { id: TX, kind: "tx", hash: TX }], active: TX });
    act(() => introduce([A], { activateGraph: true }));
    expect(useTabs.getState().active).toBe("graph");
    expect(g().selection).toEqual({ kind: "node", address: A });
    expect(usePick.getState().targets).toEqual([A]);
  });

  test("an address that already is a center opens nothing", () => {
    g().setCenters([A]);
    const steps = g()._past.length;
    act(() => introduce([A], { activateGraph: true }));
    expect(g().centers).toEqual([A]);
    expect(g()._past.length).toBe(steps);
    expect(g().selection).toEqual({ kind: "node", address: A });
    expect(usePick.getState().targets).toBeNull();
  });

  test("a hidden address (hiding a center drops it) is shown again as a center and offered the picker", () => {
    g().setCenters([A, B]);
    g().setHidden([A], true);
    act(() => introduce([A], { activateGraph: false }));
    expect(g().ui[A]?.hidden).toBe(false);
    expect(g().centers).toEqual([B, A]);
    expect(usePick.getState().targets).toEqual([A]);
  });

  test("on a snapshot it waits for the refresh, then reveals and opens the picker", () => {
    g().freeze({ data: { nodes: [], edges: [], omitted: {}, coverage: {} } } as never);
    act(() => introduce([A], { activateGraph: false }));
    expect(g().centers).toEqual([]);
    expect(usePick.getState().targets).toBeNull();
    act(() => g().resolveLive(true));
    expect(g().centers).toEqual([A]);
    expect(usePick.getState().targets).toEqual([A]);
  });
});

test("add_to_graph_from_tx_view_opens_picker_without_switching_tab", () => {
  useTabs.setState({ tabs: [{ id: "graph" }, { id: TX, kind: "tx", hash: TX }], active: TX });
  act(() => addToGraph(A));
  expect(useTabs.getState().active).toBe(TX);
  expect(g().centers).toEqual([A]);
  expect(g().selection).toBeNull();
  expect(usePick.getState().targets).toEqual([A]);
  expect(toastTexts()).toEqual(["Added to graph"]);

  usePick.getState().close();
  vi.mocked(toast).mockClear();
  act(() => addToGraph([A, B, C]));
  expect(g().centers).toEqual([A, B, C]);
  expect(usePick.getState().targets).toEqual([B, C]);
  expect(toastTexts()).toEqual(["Added 3 addresses to the graph"]);
});

describe("pickNeighbours", () => {
  const canvas = (...addrs: string[]) => ({
    nodes: addrs.map((address) => ({ address }) as never),
    edges: [],
    omitted: {},
    coverage: {},
  });

  test("a node the canvas shows: the picker opens for it, the graph is left alone", () => {
    g().setCenters([A]);
    const steps = g()._past.length;
    act(() => pickNeighbours(B, canvas(A, B)));
    expect(usePick.getState().targets).toEqual([B]);
    expect(g().centers).toEqual([A]);
    expect(g()._past.length).toBe(steps);
  });

  test("a node the canvas does not show becomes a shown center first", () => {
    g().setCenters([A]);
    g().setHidden([B], true);
    act(() => pickNeighbours(B, canvas(A, B)));
    expect(g().centers).toEqual([A, B]);
    expect(g().ui[B]?.hidden).toBe(false);
    expect(usePick.getState().targets).toEqual([B]);
    usePick.getState().close();
    act(() => pickNeighbours(C, canvas(A, B)));
    expect(g().centers).toEqual([A, B, C]);
    expect(usePick.getState().targets).toEqual([C]);
  });
});
