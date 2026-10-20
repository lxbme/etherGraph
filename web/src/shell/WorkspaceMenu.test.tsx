import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../api/endpoints";
import { ApiError } from "../api/errors";
import type { WorkspaceDto } from "../api/generated/WorkspaceDto";
import { useGraph } from "../graph/store";
import { requestSave } from "../workspace/saveRequest";
import { useWorkspace } from "../workspace/useWorkspace";
import { serialize } from "../workspace/serialize";
import { WorkspaceMenu } from "./WorkspaceMenu";
import { formatLocalTime } from "../lib/format";
import { clearExport, requestImport, useFileRequest } from "../workspace/fileRequest";
import { useTabs } from "./tabs";
import { clearToasts, Toasts } from "./Toasts";

vi.mock("../api/endpoints", () => ({
  api: { createWorkspace: vi.fn(), updateWorkspace: vi.fn(), workspace: vi.fn(), workspaces: vi.fn(), deleteWorkspace: vi.fn() },
}));
const cyHolder = vi.hoisted(() => ({ cy: null as unknown }));
vi.mock("../graph/cyRegistry", () => ({ getMainCy: () => cyHolder.cy, setMainCy: vi.fn() }));
const m = vi.mocked(api);
const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
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
  test("a save request on an unnamed workspace opens the name dialog; a save-as request opens it too", async () => {
    render(<WorkspaceMenu />);
    act(() => requestSave("save"));
    expect(await screen.findByRole("dialog", { name: "Workspace name" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    act(() => requestSave("saveAs"));
    expect(await screen.findByRole("dialog", { name: "Workspace name" })).toBeInTheDocument();
  });

  test("a save request on a saved workspace saves it", async () => {
    m.updateWorkspace.mockResolvedValue(dto());
    useWorkspace.setState({ id: 7, name: "w", updatedAt: "T1" });
    render(<WorkspaceMenu />);
    act(() => requestSave("save"));
    await waitFor(() => expect(m.updateWorkspace).toHaveBeenCalled());
  });

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
      { centers: [A], filter: {}, sort: "count", expandedPairs: new Set(), ui: {}, limits: { [A]: 20 }, picks: {}, proxyPos: {}, hiddenProxies: [], hiddenTransfers: {} },
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

  describe("files", () => {
    const H = "0x" + "1".repeat(64);
    /** A minimal graph file with A as center. */
    const graphFile = () => ({
      format: "ethergraph", version: 1, kind: "graph", exported_at: "2026-10-01T00:00:00Z", includes: { labels: false, notes: false },
      state: {
        graph: {
          ...serialize({ ...useGraph.getState(), centers: [A] }, { zoom: 1, pan: { x: 0, y: 0 } }),
          snapshot: { exported_at: "2026-10-01T00:00:00Z", includes: { labels: false, notes: false }, data: { nodes: [], edges: [], omitted: {}, coverage: {} } },
        },
        tabs: [],
        active: "graph",
      },
    });
    const fileOf = (v: unknown) => new File([JSON.stringify(v)], "x.ethergraph.json", { type: "application/json" });

    test("the menu exports and imports files; image and JSON export are gone", async () => {
      render(<WorkspaceMenu />);
      await userEvent.click(screen.getByRole("button", { name: "Workspace menu" }));
      expect(screen.queryByRole("menuitem", { name: /PNG/ })).toBeNull();
      expect(screen.queryByRole("menuitem", { name: /JSON/ })).toBeNull();
      expect(screen.getByRole("menuitem", { name: "Import file…" })).toBeInTheDocument();
      await userEvent.click(screen.getByRole("menuitem", { name: "Export workspace file…" }));
      expect(useFileRequest.getState().exporting).toEqual({ kind: "workspace" });
      act(() => clearExport());
    });

    test("Import file… picks a .json file; a graph file opens as an unsaved workspace", async () => {
      render(<WorkspaceMenu />);
      const input = screen.getByTestId("import-file-input");
      expect(input).toHaveAttribute("accept", ".json,application/json");
      const click = vi.spyOn(input, "click");
      await pick("Import file…");
      expect(click).toHaveBeenCalled();
      await userEvent.upload(input, fileOf(graphFile()));
      await waitFor(() => expect(useGraph.getState().frozen).not.toBeNull());
      expect(useGraph.getState().centers).toEqual([A]);
      expect(useWorkspace.getState()).toMatchObject({ id: null, dirty: true });
    });

    test("with unsaved changes a dropped graph file asks first; Cancel leaves the workspace as it was", async () => {
      useWorkspace.getState().setCurrent(dto());
      useGraph.getState().addCenter(B);
      expect(useWorkspace.getState().dirty).toBe(true);
      render(<WorkspaceMenu />);
      act(() => requestImport(fileOf(graphFile())));
      const dialog = await screen.findByRole("dialog", { name: "Confirm" });
      expect(within(dialog).getByText("This workspace has unsaved changes. Discard them and open the imported file?")).toBeInTheDocument();
      await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(useGraph.getState().centers).toEqual([B]);
      expect(useWorkspace.getState().id).toBe(7);
      act(() => requestImport(fileOf(graphFile())));
      await userEvent.click(within(await screen.findByRole("dialog", { name: "Confirm" })).getByRole("button", { name: "OK" }));
      expect(useGraph.getState().centers).toEqual([A]);
      expect(useWorkspace.getState()).toMatchObject({ id: null, dirty: true });
    });

    test("a bad file shows one error and changes nothing", async () => {
      useGraph.getState().addCenter(B);
      render(
        <>
          <WorkspaceMenu />
          <Toasts />
        </>,
      );
      act(() => requestImport(fileOf({ ...graphFile(), version: 3 })));
      expect(await screen.findByText("Cannot import the file: Unsupported etherGraph file version: 3")).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(useGraph.getState().centers).toEqual([B]);
      expect(useGraph.getState().frozen).toBeNull();
      act(() => clearToasts());
    });

    test("a tx file opens its tab without asking, even with unsaved changes", async () => {
      useGraph.getState().addCenter(B);
      render(<WorkspaceMenu />);
      const flow = {
        tx: { hash: H, block_number: 1, ts: "T", from: A, to: null, value: "0", success: true, gas_used: "1", fee: "1", method: null, selector: null },
        detail: {
          nonce: 0, tx_type: 2, position: null, confirmations: null, gas_limit: "1", gas_used: "1", gas_price: null, effective_gas_price: null,
          max_fee: null, max_priority_fee: null, base_fee: null, burnt_fee: null, savings: null, blob_gas_used: null, blob_gas_price: null,
          blob_fee: null, access_list_len: null, contract_created: null, revert_reason: null, input: "0x", authorizations: [], delegations: [],
        },
        call: null, nodes: [], flows: [], events: [], completeness: "fund_flow",
      };
      const meta = { exported_at: "2026-10-01T00:00:00Z", includes: { labels: false, notes: false } };
      const file = { ...graphFile(), kind: "tx", state: { graph: { ...graphFile().state.graph, centers: [], snapshot: undefined }, tabs: [{ hash: H, snapshot: { ...meta, flow, raw: null } }], active: H } };
      act(() => requestImport(fileOf(file)));
      await waitFor(() => expect(useTabs.getState().active).toBe(H));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(useGraph.getState().centers).toEqual([B]);
      act(() => useTabs.getState().closeAllTx());
    });
  });

  test("open dialog per-row delete asks for confirmation", async () => {
    m.workspaces.mockResolvedValue([{ id: 3, name: "old", updated_at: "2026-01-01T00:00:00Z" }]);
    m.deleteWorkspace.mockResolvedValue(undefined);
    render(<WorkspaceMenu />);
    await pick("Open…");
    const updated = await screen.findByText("2026-01-01 00:00:00 UTC");
    expect(updated).toHaveAttribute("title", formatLocalTime("2026-01-01T00:00:00Z"));
    await userEvent.click(await screen.findByRole("button", { name: "Delete old" }));
    expect(m.deleteWorkspace).not.toHaveBeenCalled();
    expect(screen.getByText("Delete workspace “old”?")).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole("dialog", { name: "Confirm delete" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(m.deleteWorkspace).toHaveBeenCalledWith(3));
  });
});
