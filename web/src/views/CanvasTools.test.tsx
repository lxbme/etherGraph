import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type cytoscape from "cytoscape";
import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import { exportImage } from "../graph/exportImage";
import { useIdentifying } from "../graph/identify";
import { download } from "../lib/download";
import { Toasts } from "../shell/Toasts";
import { useGraph } from "../graph/store";
import { CanvasTools, IdentifyAllButton, MoreToggleButton, type CanvasExport } from "./CanvasTools";

vi.mock("../graph/exportImage", async (orig) => ({ ...(await orig<typeof import("../graph/exportImage")>()), exportImage: vi.fn() }));
vi.mock("../lib/download", async (orig) => ({ ...(await orig<typeof import("../lib/download")>()), download: vi.fn() }));

const fakeCy = (empty = false) => ({ elements: () => ({ empty: () => empty }) }) as unknown as cytoscape.Core;
const exporter = (over: Partial<CanvasExport> = {}): CanvasExport => ({ cy: () => fakeCy(), baseName: () => "ethergraph-w", ...over });

beforeEach(() => vi.clearAllMocks());

test("a toolbar with the select-mode toggle (aria-pressed) and room for more tools", () => {
  const onSelectModeChange = vi.fn();
  const { rerender } = render(
    <CanvasTools selectMode={false} onSelectModeChange={onSelectModeChange} exporter={exporter()}>
      <button type="button">extra</button>
    </CanvasTools>,
  );
  const bar = screen.getByRole("toolbar", { name: "Canvas tools" });
  const toggle = within(bar).getByRole("button", { name: "Box select (Shift+drag)" });
  expect(toggle).toHaveAttribute("title", "Box select (Shift+drag)");
  expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(within(bar).getByRole("button", { name: "extra" })).toBeInTheDocument();
  act(() => toggle.click());
  expect(onSelectModeChange).toHaveBeenCalledWith(true);
  rerender(<CanvasTools selectMode onSelectModeChange={onSelectModeChange} exporter={exporter()} />);
  expect(screen.getByRole("button", { name: "Box select (Shift+drag)" })).toHaveAttribute("aria-pressed", "true");
  act(() => screen.getByRole("button", { name: "Box select (Shift+drag)" }).click());
  expect(onSelectModeChange).toHaveBeenLastCalledWith(false);
});

test("a canvas without a box selection has no select-mode toggle", () => {
  render(<CanvasTools exporter={exporter()} />);
  const bar = screen.getByRole("toolbar", { name: "Canvas tools" });
  expect(within(bar).queryByRole("button", { name: "Box select (Shift+drag)" })).toBeNull();
  expect(within(bar).getByRole("button", { name: "Export" })).toBeInTheDocument();
});

test("Identify all is disabled while an identification run is in flight", () => {
  const nodes = [{ address: "0x" + "1".repeat(40), kind: "unknown", identified: false }] as unknown as NodeSummaryDto[];
  render(<IdentifyAllButton nodes={nodes} />);
  const button = screen.getByRole("button", { name: /Identify all \(1\)/ });
  expect(button).toBeEnabled();
  act(() => useIdentifying.setState({ running: true }));
  expect(button).toBeDisabled();
  act(() => useIdentifying.setState({ running: false }));
});

test("the toggle hides all proxies, then reads show all with the count", () => {
  const A = "0x" + "a".repeat(40);
  const B = "0x" + "b".repeat(40);
  const HIDE = 'Hide all "+N more"';
  const OM = { [A]: 3, [B]: 2 };
  useGraph.getState().reset();
  act(() => useGraph.getState().setCenters([A, B]));
  const { rerender } = render(<MoreToggleButton proxied={[]} omitted={OM} />);
  expect(screen.getByRole("button", { name: HIDE })).toBeDisabled();
  rerender(<MoreToggleButton proxied={[A, B]} omitted={OM} />);
  const hide = screen.getByRole("button", { name: HIDE });
  expect(hide).toHaveAttribute("title", HIDE);
  expect(hide).toBeEnabled();
  act(() => hide.click());
  expect(useGraph.getState().hiddenProxies).toEqual([A, B]);
  // The hidden proxies leave the canvas.
  rerender(<MoreToggleButton proxied={[]} omitted={OM} />);
  const show = screen.getByRole("button", { name: 'Show all "+N more" (2)' });
  expect(show).toBeEnabled();
  act(() => show.click());
  expect(useGraph.getState().hiddenProxies).toEqual([]);
  expect(screen.getByRole("button", { name: HIDE })).toBeDisabled();
  // A hidden entry that is no longer a center does not count.
  act(() => useGraph.setState({ hiddenProxies: ["0x" + "c".repeat(40)] }));
  expect(screen.getByRole("button", { name: HIDE })).toBeDisabled();
});

test("hidden centers with nothing omitted are not counted, and showing clears them", () => {
  const A = "0x" + "a".repeat(40);
  const B = "0x" + "b".repeat(40);
  useGraph.getState().reset();
  act(() => {
    useGraph.getState().setCenters([A, B]);
    useGraph.setState({ hiddenProxies: [A, B] });
  });
  const { rerender } = render(<MoreToggleButton proxied={[]} omitted={{ [A]: 4, [B]: 0 }} />);
  const show = screen.getByRole("button", { name: 'Show all "+N more" (1)' });
  act(() => show.click());
  expect(useGraph.getState().hiddenProxies).toEqual([]);
  // Nothing omitted anywhere: reads hide, disabled without a visible proxy.
  act(() => useGraph.setState({ hiddenProxies: [A, B] }));
  rerender(<MoreToggleButton proxied={[]} omitted={{ [A]: 0, [B]: 0 }} />);
  expect(screen.getByRole("button", { name: 'Hide all "+N more"' })).toBeDisabled();
});

describe("export menu", () => {
  const openMenu = async () => {
    await userEvent.click(within(screen.getByRole("toolbar", { name: "Canvas tools" })).getByRole("button", { name: "Export" }));
    return screen.getByRole("menu", { name: "Export" });
  };

  test("offers PNG, transparent PNG and SVG; each exports the canvas and downloads <base>.<ext>", async () => {
    const cy = fakeCy();
    const blob = new Blob(["x"]);
    vi.mocked(exportImage).mockReturnValue(blob);
    render(<CanvasTools selectMode={false} onSelectModeChange={vi.fn()} exporter={exporter({ cy: () => cy })} />);
    const trigger = screen.getByRole("button", { name: "Export" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    const menu = await openMenu();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(within(menu).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["PNG", "Transparent PNG", "SVG"]);

    await userEvent.click(within(menu).getByRole("menuitem", { name: "PNG" }));
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(within(await openMenu()).getByRole("menuitem", { name: "Transparent PNG" }));
    await userEvent.click(within(await openMenu()).getByRole("menuitem", { name: "SVG" }));
    expect(vi.mocked(exportImage).mock.calls).toEqual([[cy, "png", []], [cy, "png-transparent", []], [cy, "svg", []]]);
    expect(vi.mocked(download).mock.calls).toEqual([
      [blob, "ethergraph-w.png"],
      [blob, "ethergraph-w.png"],
      [blob, "ethergraph-w.svg"],
    ]);
  });

  test("File… appears only when the view can export a file, and calls it", async () => {
    const onExportFile = vi.fn();
    const { rerender } = render(<CanvasTools selectMode={false} onSelectModeChange={vi.fn()} exporter={exporter()} />);
    expect(within(await openMenu()).queryByRole("menuitem", { name: "File…" })).toBeNull();
    rerender(<CanvasTools selectMode={false} onSelectModeChange={vi.fn()} exporter={exporter({ onExportFile })} />);
    await userEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "File…" }));
    expect(onExportFile).toHaveBeenCalledTimes(1);
    expect(exportImage).not.toHaveBeenCalled();
  });

  test("an empty or missing canvas toasts Nothing to export; a failing export toasts its error", async () => {
    const cyRef: { cy: cytoscape.Core | null } = { cy: null };
    render(
      <>
        <CanvasTools selectMode={false} onSelectModeChange={vi.fn()} exporter={exporter({ cy: () => cyRef.cy })} />
        <Toasts />
      </>,
    );
    await userEvent.click(within(await openMenu()).getByRole("menuitem", { name: "PNG" }));
    expect(await screen.findByText("Nothing to export")).toBeInTheDocument();
    cyRef.cy = fakeCy(true);
    await userEvent.click(within(await openMenu()).getByRole("menuitem", { name: "SVG" }));
    expect(exportImage).not.toHaveBeenCalled();
    cyRef.cy = fakeCy();
    vi.mocked(exportImage).mockImplementation(() => {
      throw new Error("canvas too large");
    });
    await userEvent.click(within(await openMenu()).getByRole("menuitem", { name: "PNG" }));
    expect(await screen.findByText(/canvas too large/)).toBeInTheDocument();
    expect(download).not.toHaveBeenCalled();
  });

  test("closes on Escape and on an outside press", async () => {
    render(
      <>
        <CanvasTools selectMode={false} onSelectModeChange={vi.fn()} exporter={exporter()} />
        <button>outside</button>
      </>,
    );
    await openMenu();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    await openMenu();
    await userEvent.click(screen.getByRole("button", { name: "outside" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
