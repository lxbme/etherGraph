import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/endpoints";
import { ApiError } from "../api/errors";
import type { WorkspaceDto } from "../api/generated/WorkspaceDto";
import { useGraph } from "../graph/store";
import { useWorkspace } from "../workspace/useWorkspace";
import { serialize } from "../workspace/serialize";
import { WorkspaceMenu, safeFileName } from "./WorkspaceMenu";

vi.mock("../api/endpoints", () => ({
  api: { createWorkspace: vi.fn(), updateWorkspace: vi.fn(), workspace: vi.fn(), workspaces: vi.fn(), deleteWorkspace: vi.fn() },
}));
const cyHolder = vi.hoisted(() => ({ cy: null as unknown }));
vi.mock("../graph/cyRegistry", () => ({ getMainCy: () => cyHolder.cy, setMainCy: vi.fn() }));
const m = vi.mocked(api);
const A = "0x" + "a".repeat(40);
const dto = (over: Partial<WorkspaceDto> = {}): WorkspaceDto => ({
  id: 7, name: "w", schema_version: 1, state: {}, created_at: "T0", updated_at: "T1", ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  useGraph.getState().reset();
  useWorkspace.getState().clear();
  cyHolder.cy = null;
});

async function pick(label: string) {
  await userEvent.click(screen.getByRole("button", { name: "Workspace menu" }));
  await userEvent.click(screen.getByRole("menuitem", { name: label }));
}

describe("WorkspaceMenu", () => {
  test("the dropdown closes on an outside mousedown and on Escape", async () => {
    render(
      <>
        <WorkspaceMenu />
        <button>outside</button>
      </>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Workspace menu" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Workspace menu" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    // A click inside the menu does not count as outside.
    await userEvent.click(screen.getByRole("button", { name: "Workspace menu" }));
    await userEvent.pointer({ keys: "[MouseLeft>]", target: screen.getByRole("menuitem", { name: "Save" }) });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  test("409 on save offers reload or overwrite; overwrite refetches updated_at then saves", async () => {
    useWorkspace.getState().setCurrent(dto());
    m.updateWorkspace.mockRejectedValueOnce(new ApiError("conflict", 409, "x"));
    render(<WorkspaceMenu />);
    await pick("Save");
    expect(await screen.findByRole("dialog", { name: "Workspace changed elsewhere" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    m.workspace.mockResolvedValue(dto({ updated_at: "T9" }));
    m.updateWorkspace.mockResolvedValueOnce(dto({ updated_at: "T10" }));
    await userEvent.click(screen.getByRole("button", { name: "Overwrite" }));
    await waitFor(() => expect(useWorkspace.getState().updatedAt).toBe("T10"));
    expect(m.updateWorkspace).toHaveBeenLastCalledWith(7, expect.objectContaining({ expected_updated_at: "T9" }));
  });

  test("save without id asks for a trimmed 1-100 char name, then creates", async () => {
    m.createWorkspace.mockResolvedValue(dto());
    render(<WorkspaceMenu />);
    await pick("Save");
    const input = screen.getByRole("textbox", { name: "Workspace name" });
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await userEvent.type(input, "  my ws  ");
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() => expect(m.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ name: "my ws" })));
  });

  test("new with unsaved changes confirms first", async () => {
    useGraph.getState().addCenter(A);
    render(<WorkspaceMenu />);
    await pick("New");
    expect(screen.getByText("This workspace has unsaved changes. Discard them and start a new one?")).toBeInTheDocument();
    expect(useGraph.getState().centers).toEqual([A]);
    await userEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(useGraph.getState().centers).toEqual([]);
    expect(useWorkspace.getState().dirty).toBe(false);
  });

  test("delete confirms with the workspace name", async () => {
    useWorkspace.getState().setCurrent(dto({ name: "foo" }));
    m.deleteWorkspace.mockResolvedValue(undefined);
    render(<WorkspaceMenu />);
    await pick("Delete");
    expect(screen.getByText("Delete workspace “foo”?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(m.deleteWorkspace).toHaveBeenCalledWith(7));
    await waitFor(() => expect(useWorkspace.getState().id).toBeNull());
  });

  test("conflict dialog: Reload loads the server version", async () => {
    useWorkspace.getState().setCurrent(dto());
    m.updateWorkspace.mockRejectedValueOnce(new ApiError("conflict", 409, "x"));
    const server = serialize(
      { centers: [A], filter: {}, sort: "count", expandedPairs: new Set(), ui: {} },
      { zoom: 1, pan: { x: 0, y: 0 } },
    );
    m.workspace.mockResolvedValue(dto({ updated_at: "T7", state: JSON.parse(JSON.stringify(server)) }));
    render(<WorkspaceMenu />);
    await pick("Save");
    await userEvent.click(await screen.findByRole("button", { name: "Reload" }));
    await waitFor(() => expect(useWorkspace.getState().updatedAt).toBe("T7"));
    expect(useGraph.getState().centers).toEqual([A]);
    expect(useWorkspace.getState().dirty).toBe(false);
  });

  describe("export", () => {
    let created: Blob[];
    let names: string[];
    beforeEach(() => {
      created = [];
      names = [];
      URL.createObjectURL = vi.fn((b: Blob | MediaSource) => {
        created.push(b as Blob);
        return "blob:x";
      });
      URL.revokeObjectURL = vi.fn();
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
        names.push(this.download);
      });
    });

    test("PNG uses cy.png full/scale 2 and a sanitized name; url is revoked", async () => {
      const blob = new Blob(["x"], { type: "image/png" });
      const png = vi.fn(() => blob);
      cyHolder.cy = { png, getElementById: () => ({ nonempty: () => false }), viewport: () => {} };
      useWorkspace.getState().setCurrent(dto({ name: "a/../b" }));
      render(<WorkspaceMenu />);
      await pick("Export PNG");
      expect(png).toHaveBeenCalledWith(expect.objectContaining({ full: true, scale: 2, output: "blob" }));
      expect(names).toEqual(["ethergraph-a_.._b.png"]);
      expect(created[0]).toBe(blob);
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:x");
    });

    test("JSON export downloads the serialized state with the name", async () => {
      cyHolder.cy = {
        nodes: () => ({ forEach: () => {} }),
        zoom: () => 2,
        pan: () => ({ x: 1, y: 2 }),
        getElementById: () => ({ nonempty: () => false }),
        viewport: () => {},
      };
      useGraph.getState().addCenter(A);
      useWorkspace.getState().setCurrent(dto({ name: ".." }));
      render(<WorkspaceMenu />);
      await pick("Export JSON");
      expect(names).toEqual(["ethergraph-untitled.json"]);
      expect(created[0]!.type).toBe("application/json");
      const body = JSON.parse(await created[0]!.text());
      expect(body.state.centers).toEqual([A]);
      expect(body.state.viewport).toEqual({ zoom: 2, pan: { x: 1, y: 2 } });
      expect(URL.revokeObjectURL).toHaveBeenCalled();
    });
  });

  test("safeFileName sanitizes", () => {
    expect(safeFileName("a/../b")).toBe("a_.._b");
    expect(safeFileName("..")).toBe("untitled");
    expect(safeFileName(null)).toBe("untitled");
    expect(safeFileName('x:y*z?')).toBe("x_y_z_");
  });

  test("open dialog per-row delete asks for confirmation", async () => {
    m.workspaces.mockResolvedValue([{ id: 3, name: "old", updated_at: "2026-01-01T00:00:00Z" }]);
    m.deleteWorkspace.mockResolvedValue(undefined);
    render(<WorkspaceMenu />);
    await pick("Open…");
    await userEvent.click(await screen.findByRole("button", { name: "Delete old" }));
    expect(m.deleteWorkspace).not.toHaveBeenCalled();
    expect(screen.getByText("Delete workspace “old”?")).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole("dialog", { name: "Confirm delete" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(m.deleteWorkspace).toHaveBeenCalledWith(3));
  });
});
