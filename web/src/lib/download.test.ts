import { expect, test, vi } from "vitest";
import { download, safeFileName } from "./download";

test("safeFileName sanitizes; an empty name falls back to `fallback` (untitled by default)", () => {
  expect(safeFileName("a/../b")).toBe("a_.._b");
  expect(safeFileName("..")).toBe("untitled");
  expect(safeFileName(null)).toBe("untitled");
  expect(safeFileName("x:y*z?")).toBe("x_y_z_");
  expect(safeFileName(null, "graph")).toBe("graph");
  expect(safeFileName("  ", "graph")).toBe("graph");
});

test("download clicks a temporary link with the file name and revokes the URL", () => {
  const blob = new Blob(["x"]);
  const names: string[] = [];
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    names.push(this.download);
  });
  download(blob, "ethergraph-w.png");
  expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
  expect(names).toEqual(["ethergraph-w.png"]);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:x");
  expect(document.querySelector("a[download]")).toBeNull();
  click.mockRestore();
});
