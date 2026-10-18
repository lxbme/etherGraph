import { act, renderHook } from "@testing-library/react";
import { useAdminRoute } from "../shell/hashRoute";
import { useFileDrop, useFileRequest } from "./fileRequest";

/** A drag event on the window carrying `files`. */
function dragEvent(type: string, files: File[]) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: { types: ["Files"], files, dropEffect: "none" } });
  return e;
}

beforeEach(() => useFileRequest.setState({ exporting: null, importing: null }));
afterEach(() => useAdminRoute.setState({ open: false }));

test("a file dropped on the admin page is not imported into the hidden workspace (and does not open in the tab)", () => {
  const { unmount } = renderHook(() => useFileDrop());
  act(() => useAdminRoute.setState({ open: true }));
  const drop = dragEvent("drop", [new File(["{}"], "w.json")]);
  act(() => void window.dispatchEvent(drop));
  expect(drop.defaultPrevented).toBe(true);
  expect(useFileRequest.getState().importing).toBeNull();

  act(() => useAdminRoute.setState({ open: false }));
  const file = new File(["{}"], "w.json");
  act(() => void window.dispatchEvent(dragEvent("drop", [file])));
  expect(useFileRequest.getState().importing?.file).toBe(file);
  unmount();
});
