import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/endpoints";
import { ApiError } from "../api/errors";
import type { WorkspaceDto } from "../api/generated/WorkspaceDto";
import { useGraph } from "../graph/store";
import { useWorkspace } from "../workspace/useWorkspace";
import { WorkspaceMenu } from "./WorkspaceMenu";

vi.mock("../api/endpoints", () => ({
  api: { createWorkspace: vi.fn(), updateWorkspace: vi.fn(), workspace: vi.fn(), workspaces: vi.fn(), deleteWorkspace: vi.fn() },
}));
const m = vi.mocked(api);
const A = "0x" + "a".repeat(40);
const dto = (over: Partial<WorkspaceDto> = {}): WorkspaceDto => ({
  id: 7, name: "w", schema_version: 1, state: {}, created_at: "T0", updated_at: "T1", ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  useGraph.getState().reset();
  useWorkspace.getState().clear();
});

async function pick(label: string) {
  await userEvent.click(screen.getByRole("button", { name: "画布菜单" }));
  await userEvent.click(screen.getByRole("menuitem", { name: label }));
}

describe("WorkspaceMenu", () => {
  test("409 on save offers reload or overwrite; overwrite refetches updated_at then saves", async () => {
    useWorkspace.getState().setCurrent(dto());
    m.updateWorkspace.mockRejectedValueOnce(new ApiError("conflict", 409, "x"));
    render(<WorkspaceMenu />);
    await pick("保存");
    expect(await screen.findByRole("dialog", { name: "画布已在别处修改" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新加载" })).toBeInTheDocument();
    m.workspace.mockResolvedValue(dto({ updated_at: "T9" }));
    m.updateWorkspace.mockResolvedValueOnce(dto({ updated_at: "T10" }));
    await userEvent.click(screen.getByRole("button", { name: "覆盖保存" }));
    await waitFor(() => expect(useWorkspace.getState().updatedAt).toBe("T10"));
    expect(m.updateWorkspace).toHaveBeenLastCalledWith(7, expect.objectContaining({ expected_updated_at: "T9" }));
  });

  test("save without id asks for a trimmed 1-100 char name, then creates", async () => {
    m.createWorkspace.mockResolvedValue(dto());
    render(<WorkspaceMenu />);
    await pick("保存");
    const input = screen.getByRole("textbox", { name: "画布名称" });
    await userEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await userEvent.type(input, "  my ws  ");
    await userEvent.click(screen.getByRole("button", { name: "确定" }));
    await waitFor(() => expect(m.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ name: "my ws" })));
  });

  test("new with unsaved changes confirms first", async () => {
    useGraph.getState().addCenter(A);
    render(<WorkspaceMenu />);
    await pick("新建");
    expect(screen.getByText("当前画布有未保存的修改，确定新建？")).toBeInTheDocument();
    expect(useGraph.getState().centers).toEqual([A]);
    await userEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(useGraph.getState().centers).toEqual([]);
    expect(useWorkspace.getState().dirty).toBe(false);
  });

  test("delete confirms with the workspace name", async () => {
    useWorkspace.getState().setCurrent(dto({ name: "foo" }));
    m.deleteWorkspace.mockResolvedValue(undefined);
    render(<WorkspaceMenu />);
    await pick("删除");
    expect(screen.getByText("确定删除画布「foo」？")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(m.deleteWorkspace).toHaveBeenCalledWith(7));
    await waitFor(() => expect(useWorkspace.getState().id).toBeNull());
  });
});
