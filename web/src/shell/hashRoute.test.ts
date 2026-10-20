import { act, renderHook } from "@testing-library/react";
import { useGraph } from "../graph/store";
import { usePick } from "../panels/pick/pickStore";
import { leaveAdmin, parseHash, useAdminRoute, useHashRouting } from "./hashRoute";
import { useTabs } from "./tabs";

const A = "0x" + "ab".repeat(20);
const TX = "0x" + "12".repeat(32);

function setHash(h: string) {
  history.replaceState(null, "", h);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

beforeEach(() => {
  useTabs.setState({ tabs: [{ id: "graph" }], active: "graph" });
  useGraph.getState().reset();
  useAdminRoute.setState({ open: false });
  history.replaceState(null, "", "#/");
});

test("parses the admin route", () => {
  expect(parseHash("#/admin")).toEqual({ kind: "admin" });
  expect(parseHash("#/admin/x")).toBeNull();
  expect(parseHash(`#/address/${A}`)).toEqual({ kind: "address", addr: A });
});

test("#/admin opens the admin page on load and on navigation, and leaves the graph alone", () => {
  history.replaceState(null, "", "#/admin");
  const { unmount } = renderHook(() => useHashRouting());
  expect(useAdminRoute.getState().open).toBe(true);
  act(() => setHash("#/"));
  expect(useAdminRoute.getState().open).toBe(false);
  act(() => setHash("#/admin"));
  expect(useAdminRoute.getState().open).toBe(true);
  unmount();
});

test("while the admin page is open the graph does not rewrite the hash; leaving restores it", () => {
  const { unmount } = renderHook(() => useHashRouting());
  act(() => useGraph.getState().select({ kind: "node", address: A }));
  expect(location.hash).toBe(`#/address/${A}`);
  act(() => setHash("#/admin"));
  act(() => useGraph.getState().select(null));
  expect(location.hash).toBe("#/admin");
  act(() => leaveAdmin());
  expect(useAdminRoute.getState().open).toBe(false);
  expect(location.hash).toBe("#/");
  unmount();
});

describe("#/address links", () => {
  beforeEach(() => usePick.getState().close());

  test("a link to a new address puts it alone on the graph, selects it and offers the picker", () => {
    useTabs.setState({ tabs: [{ id: "graph" }, { id: TX, kind: "tx", hash: TX }], active: TX });
    history.replaceState(null, "", `#/address/${A}`);
    const { unmount } = renderHook(() => useHashRouting());
    expect(useGraph.getState().centers).toEqual([A]);
    expect(useGraph.getState().picks[A]).toEqual([]);
    expect(useGraph.getState().selection).toEqual({ kind: "node", address: A });
    expect(useTabs.getState().active).toBe("graph");
    expect(usePick.getState().targets).toEqual([A]);
    unmount();
  });

  test("route_reload_on_existing_center_opens_nothing", () => {
    useGraph.getState().setCenters([A]);
    history.replaceState(null, "", `#/address/${A}`);
    const { unmount } = renderHook(() => useHashRouting());
    expect(useGraph.getState().centers).toEqual([A]);
    expect(useGraph.getState().selection).toEqual({ kind: "node", address: A });
    expect(usePick.getState().targets).toBeNull();
    unmount();
  });
});
