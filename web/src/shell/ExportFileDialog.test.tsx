import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { download } from "../lib/download";
import { buildFile, type EtherGraphFileV1 } from "../workspace/file";
import { requestExport, useFileRequest } from "../workspace/fileRequest";
import { useWorkspace } from "../workspace/useWorkspace";
import { ExportFileDialog } from "./ExportFileDialog";
import { clearToasts, Toasts } from "./Toasts";

vi.mock("../lib/download", async (orig) => ({ ...(await orig<typeof import("../lib/download")>()), download: vi.fn() }));
vi.mock("../workspace/file", async (orig) => ({ ...(await orig<typeof import("../workspace/file")>()), buildFile: vi.fn() }));

const H = "0x" + "ab".repeat(32);
const FILE = { format: "ethergraph", version: 1, kind: "graph" } as EtherGraphFileV1;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildFile).mockResolvedValue(FILE);
  useWorkspace.getState().clear();
  act(() => clearToasts());
});

const dialog = () => screen.queryByRole("dialog", { name: "Export file" });

test("nothing shows until an export is requested; both boxes start unticked", () => {
  render(<ExportFileDialog />);
  expect(dialog()).toBeNull();
  act(() => requestExport("graph"));
  expect(dialog()).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "Include my labels" })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "Include node notes" })).not.toBeChecked();
});

test("Export builds the file with the ticked options and downloads it as JSON", async () => {
  useWorkspace.setState({ name: "Case/7" });
  render(<ExportFileDialog />);
  act(() => requestExport("workspace"));
  await userEvent.click(screen.getByRole("checkbox", { name: "Include node notes" }));
  await userEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
  expect(buildFile).toHaveBeenCalledWith("workspace", { labels: false, notes: true });
  const [blob, name] = vi.mocked(download).mock.calls[0]!;
  expect(name).toBe("ethergraph-Case_7.ethergraph.json");
  expect(blob.type).toBe("application/json");
  expect(JSON.parse(await blob.text())).toEqual(FILE);
  expect(dialog()).toBeNull();
  expect(useFileRequest.getState().exporting).toBeNull();
});

test("a tx tab's file is named after its hash; a graph's after the workspace or `graph`", async () => {
  render(<ExportFileDialog />);
  act(() => requestExport("tx", H));
  await userEvent.click(screen.getByRole("checkbox", { name: "Include my labels" }));
  await userEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
  expect(buildFile).toHaveBeenCalledWith("tx", { labels: true, notes: false, tabHash: H });
  expect(vi.mocked(download).mock.calls[0]![1]).toBe("ethergraph-tx-ababababab.ethergraph.json");
  act(() => requestExport("graph"));
  await userEvent.click(screen.getByRole("button", { name: "Export" }));
  await waitFor(() => expect(download).toHaveBeenCalledTimes(2));
  expect(vi.mocked(download).mock.calls[1]![1]).toBe("ethergraph-graph.ethergraph.json");
});

test("Cancel and Escape close it without exporting", async () => {
  render(<ExportFileDialog />);
  act(() => requestExport("graph"));
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(dialog()).toBeNull();
  act(() => requestExport("graph"));
  await userEvent.keyboard("{Escape}");
  expect(dialog()).toBeNull();
  expect(buildFile).not.toHaveBeenCalled();
});

test("a view that cannot be exported yet shows an error and closes", async () => {
  vi.mocked(buildFile).mockRejectedValue(new Error("This view's data has not loaded yet"));
  render(
    <>
      <ExportFileDialog />
      <Toasts />
    </>,
  );
  act(() => requestExport("graph"));
  await userEvent.click(screen.getByRole("button", { name: "Export" }));
  expect(await screen.findByText("Export failed: This view's data has not loaded yet")).toBeInTheDocument();
  expect(download).not.toHaveBeenCalled();
  expect(dialog()).toBeNull();
});
