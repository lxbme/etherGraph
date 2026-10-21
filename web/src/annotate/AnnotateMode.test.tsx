import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useGraph } from "../graph/store";
import { useShortcuts } from "../graph/useShortcuts";
import { useTabs } from "../shell/tabs";
import { CanvasTools } from "../views/CanvasTools";
import { useSaveRequest } from "../workspace/saveRequest";
import { captureState } from "../workspace/useWorkspace";
import { AnnotateToolbar } from "./AnnotateToolbar";
import { AnnotationLayer } from "./AnnotationLayer";
import { txCallsView, txFlowView, type Annotation, type ViewId } from "./model";
import { useAnnotations } from "./store";

/** A canvas with pan (100,50) and zoom 2: screen = model × 2 + pan. */
function fakeCy() {
  const container = document.createElement("div");
  return {
    container: () => container,
    pan: () => ({ x: 100, y: 50 }),
    zoom: () => 2,
    on() {},
    off() {},
  };
}
const s = () => useAnnotations.getState();
const notes = (view: ViewId = "graph") => s().byView[view] ?? [];
const rect = (id: string, over: Partial<Annotation> = {}): Annotation => ({
  id, kind: "rect", color: "red", x1: 100, y1: 100, x2: 200, y2: 200, ...over,
});

function renderLayer(view: ViewId = "graph") {
  const cy = fakeCy();
  const r = render(<AnnotationLayer view={view} cy={cy as never} />);
  const svg = () => r.container.querySelector("svg.annotation-layer") as SVGSVGElement;
  return { ...r, cy, svg };
}
const at = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, pointerId: 1 });
/** A pointer drag on the overlay, in screen (client) coordinates. */
function drag(el: Element, from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(el, at(...from));
  fireEvent.pointerMove(el, at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2));
  fireEvent.pointerMove(el, at(...to));
  fireEvent.pointerUp(el, at(...to));
}
const key = (target: EventTarget, init: KeyboardEventInit) =>
  act(() => void target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })));

/** jsdom has no canvas: a 2D context whose text is 1em per CJK glyph and 0.6em per other character. */
const fontSizeOf = (font: string) => parseFloat(/([\d.]+)px/.exec(font)?.[1] ?? "10");
const fakeCtx = {
  font: "10px sans-serif",
  measureText(t: string) {
    const em = fontSizeOf(this.font);
    return { width: [...t].reduce((w, ch) => w + (/[\u3000-\u9fff]/.test(ch) ? em : 0.6 * em), 0) };
  },
};
beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => fakeCtx) as never);
});
afterAll(() => vi.restoreAllMocks());

beforeEach(() => {
  s().reset();
  useTabs.setState({ tabs: [{ id: "graph" }], active: "graph" });
});

describe("annotate mode", () => {
  test("drawing a rectangle adds one annotation in model coordinates", () => {
    act(() => {
      s().setMode("graph");
      s().setTool("rect");
    });
    const { svg } = renderLayer();
    drag(svg(), [300, 250], [500, 450]);
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toMatchObject({ kind: "rect", color: "red", x1: 100, y1: 100, x2: 200, y2: 200 });
    expect(s().selected).toBe(notes()[0]!.id);
    expect(s().tool).toBe("rect");
    s().undo("graph");
    expect(notes()).toEqual([]);
    expect(s().canUndo("graph")).toBe(false);
  });

  test("a tiny drag adds nothing", () => {
    act(() => {
      s().setMode("graph");
      s().setTool("ellipse");
    });
    const { svg } = renderLayer();
    drag(svg(), [300, 250], [302, 252]);
    expect(notes()).toEqual([]);
    expect(s().canUndo("graph")).toBe(false);
  });

  test("an arrow runs from the press to the release; pointer events stop at the overlay", () => {
    act(() => {
      s().setMode("graph");
      s().setTool("arrow");
    });
    const { svg } = renderLayer();
    const outside = vi.fn();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("pointerup", outside);
    try {
      drag(svg(), [100, 50], [300, 50]);
    } finally {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("pointerup", outside);
    }
    expect(notes()[0]).toMatchObject({ kind: "arrow", x1: 0, y1: 0, x2: 100, y2: 0 });
    expect(outside).not.toHaveBeenCalled();
  });

  test("outside annotate mode the overlay takes no pointer events and draws nothing", () => {
    act(() => s().setTool("rect"));
    const { svg } = renderLayer();
    expect(svg()).not.toHaveClass("annotation-layer--active");
    drag(svg(), [300, 250], [500, 450]);
    expect(notes()).toEqual([]);
  });

  test("text: typing then Enter commits; Escape on empty removes without an undo step", () => {
    act(() => {
      s().setMode("graph");
      s().setTool("text");
    });
    const { svg, container } = renderLayer();
    drag(svg(), [300, 250], [300, 250]);
    let box = container.querySelector("textarea")!;
    expect(box).toHaveStyle({ fontSize: "28px", left: "300px" });
    expect(parseFloat(box.style.top)).toBeCloseTo(250 - 0.15 * 28); // half a leading above the text's top
    expect(notes()).toEqual([]); // a draft until committed
    fireEvent.change(box, { target: { value: "a\nb" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(container.querySelector("textarea")).not.toBeNull(); // Shift+Enter is a newline
    fireEvent.keyDown(box, { key: "Enter" });
    expect(container.querySelector("textarea")).toBeNull();
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toMatchObject({ kind: "text", text: "a\nb", x1: 100, y1: 100 });

    // A second draft left empty: nothing is added, and one undo removes the first text.
    drag(svg(), [500, 450], [500, 450]);
    box = container.querySelector("textarea")!;
    fireEvent.keyDown(box, { key: "Escape" });
    expect(container.querySelector("textarea")).toBeNull();
    expect(notes()).toHaveLength(1);
    s().undo("graph");
    expect(notes()).toEqual([]);
    expect(s().canUndo("graph")).toBe(false);
  });

  test("text: the editor is as wide as its longest line measured in its font, CJK included, and grows while typing", () => {
    act(() => {
      s().setMode("graph");
      s().setTool("text");
    });
    const { svg, container } = renderLayer();
    drag(svg(), [300, 250], [300, 250]);
    const box = container.querySelector("textarea")!;
    fireEvent.change(box, { target: { value: "中文" } });
    const narrow = parseFloat(box.style.width);
    fireEvent.change(box, { target: { value: "ab\n中文标注测试文字" } });
    const wide = parseFloat(box.style.width);
    expect(wide).toBeGreaterThanOrEqual(8 * 28 * 0.9); // 8 glyphs at font size 14 × zoom 2
    expect(wide).toBeGreaterThan(narrow);
  });

  test("text: blur commits; editing a text to empty removes it as one step", () => {
    act(() => {
      s().setMode("graph");
      s().setTool("text");
    });
    const { svg, container } = renderLayer();
    drag(svg(), [300, 250], [300, 250]);
    fireEvent.change(container.querySelector("textarea")!, { target: { value: "hi" } });
    fireEvent.blur(container.querySelector("textarea")!);
    expect(notes()).toMatchObject([{ kind: "text", text: "hi" }]);

    act(() => s().setTool("select"));
    fireEvent.doubleClick(svg(), at(304, 254));
    const box = container.querySelector("textarea")!;
    expect(box).toHaveValue("hi");
    expect(container.querySelector("text")).toBeNull(); // the edited text is hidden under its editor
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(notes()).toEqual([]);
    s().undo("graph");
    expect(notes()).toMatchObject([{ kind: "text", text: "hi" }]);
  });

  test("select-drag moves by the model delta as one undo step", () => {
    act(() => {
      s().load("graph", [rect("r")]);
      s().setMode("graph");
    });
    const { svg, container } = renderLayer();
    drag(svg(), [400, 350], [440, 370]); // model (150,150) → (170,160)
    expect(notes()).toEqual([rect("r", { x1: 120, y1: 110, x2: 220, y2: 210 })]);
    expect(s().selected).toBe("r");
    expect(container.querySelector(".annotation-layer__selection")).not.toBeNull();
    s().undo("graph");
    expect(notes()).toEqual([rect("r")]);
    expect(s().canUndo("graph")).toBe(false);
  });

  test("clicking a shape selects it, clicking empty space clears the selection", () => {
    act(() => {
      s().load("graph", [rect("r"), { id: "a", kind: "arrow", color: "blue", x1: 300, y1: 0, x2: 400, y2: 0 }]);
      s().setMode("graph");
    });
    const { svg } = renderLayer();
    drag(svg(), [700, 54], [700, 54]); // 2 screen px off the arrow
    expect(s().selected).toBe("a");
    drag(svg(), [304, 254], [304, 254]); // inside the rectangle
    expect(s().selected).toBe("r");
    drag(svg(), [900, 900], [900, 900]);
    expect(s().selected).toBeNull();
    expect(s().canUndo("graph")).toBe(false);
  });

  test("Delete removes the selected annotation; Delete inside the textarea does not", () => {
    act(() => {
      s().load("graph", [rect("r")]);
      s().setMode("graph");
      s().select("r");
      s().setTool("text");
    });
    const { svg, container } = renderLayer();
    drag(svg(), [900, 900], [900, 900]);
    const box = container.querySelector("textarea")!;
    key(box, { key: "Delete" });
    key(box, { key: "Backspace" });
    expect(notes()).toEqual([rect("r")]);
    fireEvent.keyDown(box, { key: "Escape" });
    key(document.body, { key: "Delete" });
    expect(notes()).toEqual([]);
    expect(s().selected).toBeNull();
  });

  test("Escape clears the selection first, then leaves the mode; annotations and history stay", () => {
    act(() => {
      s().setMode("graph");
      s().add("graph", rect("r"));
      s().select("r");
    });
    renderLayer();
    key(document.body, { key: "Escape" });
    expect(s().selected).toBeNull();
    expect(s().active).toBe("graph");
    key(document.body, { key: "Escape" });
    expect(s().active).toBeNull();
    expect(notes()).toEqual([rect("r")]);
    expect(s().canUndo("graph")).toBe(true);
  });

  test("Mod+Z in annotate mode undoes the annotation, not the graph", () => {
    const undo = vi.spyOn(useGraph.getState(), "undo");
    const redo = vi.spyOn(useGraph.getState(), "redo");
    function Host() {
      useShortcuts(() => undefined);
      return <AnnotationLayer view="graph" cy={fakeCy() as never} />;
    }
    render(<Host />);
    act(() => {
      s().setMode("graph");
      s().add("graph", rect("r"));
    });
    key(document.body, { key: "z", ctrlKey: true });
    expect(notes()).toEqual([]);
    key(document.body, { key: "z", ctrlKey: true, shiftKey: true });
    expect(notes()).toEqual([rect("r")]);
    key(document.body, { key: "y", ctrlKey: true });
    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();
    // Out of the mode, the keys are the graph's again.
    act(() => s().setMode(null));
    key(document.body, { key: "z", ctrlKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(notes()).toEqual([rect("r")]);
    undo.mockRestore();
    redo.mockRestore();
  });

  test("the keys act on the active view only", () => {
    const flow = txFlowView("0xAB");
    act(() => {
      s().setMode(flow);
      s().add("graph", rect("g"));
      s().add(flow, rect("f"));
    });
    renderLayer("graph");
    renderLayer(flow);
    key(document.body, { key: "z", ctrlKey: true });
    expect(notes(flow)).toEqual([]);
    expect(notes("graph")).toEqual([rect("g")]);
  });

  test("Mod+S while writing a new text commits it first: the save captures the text", () => {
    function Host() {
      useShortcuts(() => undefined);
      return <AnnotationLayer view="graph" cy={fakeCy() as never} />;
    }
    const { container } = render(<Host />);
    act(() => {
      s().setMode("graph");
      s().setTool("text");
    });
    const svg = container.querySelector("svg.annotation-layer")!;
    drag(svg, [300, 250], [300, 250]);
    const box = container.querySelector("textarea")!;
    act(() => box.focus());
    fireEvent.change(box, { target: { value: "draft" } });
    const before = useSaveRequest.getState().pending?.n ?? 0;
    key(box, { key: "s", ctrlKey: true });
    // The save request comes after the commit, so whatever acts on it captures the text.
    expect(useSaveRequest.getState().pending).toMatchObject({ kind: "save", n: before + 1 });
    expect(captureState().graph.annotations).toMatchObject([{ kind: "text", text: "draft", x1: 100, y1: 100 }]);
    expect(container.querySelector("textarea")).toBeNull();
    act(() => useSaveRequest.setState({ pending: null }));
  });

  test("in annotate mode the overlay suppresses the browser's context menu", () => {
    const { svg } = renderLayer();
    expect(fireEvent.contextMenu(svg())).toBe(true); // not prevented outside the mode
    act(() => s().setMode("graph"));
    expect(fireEvent.contextMenu(svg())).toBe(false);
  });

  test("the wheel is forwarded to the canvas", () => {
    act(() => s().setMode("graph"));
    const { svg, cy } = renderLayer();
    const got = vi.fn();
    cy.container().addEventListener("wheel", (e) => got(e.deltaY, e.clientX));
    const ev = new WheelEvent("wheel", { deltaY: -100, clientX: 7, bubbles: true, cancelable: true });
    svg().dispatchEvent(ev);
    expect(got).toHaveBeenCalledWith(-100, 7);
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe("annotate toolbar", () => {
  test("the toggle in the canvas tools enters and leaves the mode", () => {
    render(<CanvasTools exporter={{ cy: () => null, baseName: () => "x" }} annotateView="graph" />);
    const toggle = screen.getByRole("button", { name: "Annotate" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    act(() => toggle.click());
    expect(s().active).toBe("graph");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    act(() => toggle.click());
    expect(s().active).toBeNull();
  });

  test("shown only for the active view: tools, colours (recolouring the selection) and Done", () => {
    const { rerender } = render(<AnnotateToolbar view="graph" />);
    expect(screen.queryByRole("toolbar", { name: "Annotate" })).toBeNull();
    act(() => {
      s().setMode("graph");
      s().add("graph", rect("r"));
      s().select("r");
    });
    rerender(<AnnotateToolbar view="graph" />);
    const bar = within(screen.getByRole("toolbar", { name: "Annotate" }));
    expect(bar.getByRole("button", { name: "Select" })).toHaveAttribute("aria-pressed", "true");
    for (const name of ["Text", "Arrow", "Rectangle", "Ellipse"]) {
      expect(bar.getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
    }
    act(() => bar.getByRole("button", { name: "Ellipse" }).click());
    expect(s().tool).toBe("ellipse");
    expect(bar.getByRole("button", { name: "Ellipse" })).toHaveAttribute("aria-pressed", "true");
    expect(bar.getByRole("button", { name: "Red" })).toHaveAttribute("aria-pressed", "true");
    act(() => bar.getByRole("button", { name: "Blue" }).click());
    expect(s().color).toBe("blue");
    expect(notes()[0]!.color).toBe("blue");
    act(() => bar.getByRole("button", { name: "Done" }).click());
    expect(s().active).toBeNull();
    expect(screen.queryByRole("toolbar", { name: "Annotate" })).toBeNull();
    expect(notes()).toHaveLength(1);
  });

  test("the delete button is disabled with nothing selected", () => {
    act(() => {
      s().setMode("graph");
      s().add("graph", rect("r"));
    });
    render(<AnnotateToolbar view="graph" />);
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });

  test("the delete button removes the selected annotation as one undo step", () => {
    act(() => {
      s().setMode("graph");
      s().add("graph", rect("r"));
      s().select("r");
    });
    render(<AnnotateToolbar view="graph" />);
    const del = screen.getByRole("button", { name: "Delete" });
    expect(del).toBeEnabled();
    act(() => del.click());
    expect(notes()).toHaveLength(0);
    expect(s().selected).toBeNull();
    act(() => s().undo("graph"));
    expect(notes().map((n) => n.id)).toEqual(["r"]);
  });

  test("leaving the canvas' tab or view leaves the mode", () => {
    const hash = "0xab";
    act(() => useTabs.setState({ tabs: [{ id: "graph" }, { id: "data", kind: "data" }, { id: hash, kind: "tx", hash }], active: "graph" }));
    act(() => s().setMode("graph"));
    act(() => useTabs.getState().activate("data"));
    expect(s().active).toBeNull();

    act(() => useTabs.getState().activate(hash));
    act(() => s().setMode(txFlowView(hash)));
    act(() => useTabs.getState().setDetailTab(hash, "logs")); // the canvas stays shown
    expect(s().active).toBe(txFlowView(hash));
    act(() => useTabs.getState().setTxView(hash, "calls"));
    expect(s().active).toBeNull();
    act(() => s().setMode(txCallsView(hash)));
    act(() => useTabs.getState().close(hash));
    expect(s().active).toBeNull();
  });
});
