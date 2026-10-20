import type cytoscape from "cytoscape";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { newBatchId as newId } from "../lib/batchId";
import { arrowHead, ellipseOf, hitTest, rectOf, textLines } from "./geometry";
import {
  bounds,
  FONT_SIZE,
  LINE_HEIGHT,
  STROKE_WIDTH,
  translate,
  type Annotation,
  type AnnotationColor,
  type ViewId,
} from "./model";
import { useAnnotations } from "./store";
import { useAnnotateKeys } from "./useAnnotateKeys";

const NO_NOTES: Annotation[] = []; // stable, so an untouched view does not re-render on every store change
/** How close (screen px) a press must be to a line or box outline to hit it. */
const HIT_PX = 6;
/** A drag shorter than this (screen px) draws or moves nothing. */
const DRAG_MIN_PX = 4;

type Point = { x: number; y: number };
type Viewport = { pan: Point; zoom: number };

/** A text being written: a new draft (`id` null, added on commit) or an existing text (updated, or removed when emptied). */
interface TextEditor {
  id: string | null;
  x: number;
  y: number;
  color: AnnotationColor;
  text: string;
}

/** The pointer gesture in progress: drawing a shape, moving one (once past DRAG_MIN_PX), or a click placing a text. */
type Gesture =
  | { kind: "draw"; shape: Annotation }
  | { kind: "move"; id: string; from: Point; moving: boolean }
  | { kind: "text"; at: Point };

const tokenOf = (a: Annotation) => `var(--note-${a.color})`;

function Shape({ a, textRef }: { a: Annotation; textRef?: (el: SVGTextElement | null) => void }) {
  const color = tokenOf(a);
  const common = { stroke: color, strokeWidth: STROKE_WIDTH, fill: "none", strokeLinejoin: "round" as const };
  switch (a.kind) {
    case "rect":
      return <rect {...common} {...rectOf(a)} />;
    case "ellipse":
      return <ellipse {...common} {...ellipseOf(a)} />;
    case "arrow":
      return (
        <>
          <line {...common} strokeLinecap="round" x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} />
          <polygon fill={color} stroke="none" points={arrowHead(a).map((p) => p.join(",")).join(" ")} />
        </>
      );
    case "text":
      // Spaces are kept, as the export's fillText keeps them.
      return (
        <text ref={textRef} x={a.x1} y={a.y1} fill={color} fontSize={FONT_SIZE} dominantBaseline="hanging" style={{ whiteSpace: "pre" }}>
          {textLines(a).map((line, i) => (
            <tspan key={i} x={a.x1} y={a.y1 + i * FONT_SIZE * LINE_HEIGHT}>
              {line}
            </tspan>
          ))}
        </text>
      );
  }
}

/**
 * The annotations of one canvas, drawn over it in model coordinates: one group follows the Cytoscape pan and zoom.
 * Colours reference the theme tokens, so a theme switch needs no re-render.
 *
 * Outside annotate mode it never takes pointer events. In annotate mode for `view` it takes them all (Cytoscape sees
 * none, so the graph neither pans nor selects; the wheel is forwarded to it, so it still zooms) to draw, select, move
 * and edit annotations, and its keys are on (useAnnotateKeys).
 */
export function AnnotationLayer({ view, cy }: { view: ViewId; cy: cytoscape.Core | null }) {
  const list = useAnnotations((s) => s.byView[view] ?? NO_NOTES);
  const on = useAnnotations((s) => s.active === view);
  const tool = useAnnotations((s) => s.tool);
  const selected = useAnnotations((s) => (s.active === view ? s.selected : null));
  const [vp, setVp] = useState<Viewport>(() => (cy ? { pan: cy.pan(), zoom: cy.zoom() } : { pan: { x: 0, y: 0 }, zoom: 1 }));
  useEffect(() => {
    if (!cy) return;
    const sync = () => setVp({ pan: { ...cy.pan() }, zoom: cy.zoom() });
    sync();
    cy.on("viewport resize", sync);
    return () => {
      cy.off("viewport resize", sync);
    };
  }, [cy]);

  const svgRef = useRef<SVGSVGElement>(null);
  const gesture = useRef<Gesture | null>(null);
  /** The shape being drawn, and the offset of the one being moved (model units). */
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [move, setMove] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const [editor, setEditor] = useState<TextEditor | null>(null);
  const editorRef = useRef<TextEditor | null>(null);
  const setEd = (next: TextEditor | null) => {
    editorRef.current = next;
    setEditor(next);
  };

  // Text size: the rendered box where the browser can measure it, else the model's estimate (e.g. jsdom).
  const textEls = useRef(new Map<string, SVGTextElement>());
  const measure = useCallback((a: Annotation) => {
    const el = textEls.current.get(a.id);
    const box = el && typeof el.getBBox === "function" ? el.getBBox() : null;
    if (box && box.width > 0) return { w: box.width, h: Math.max(box.height, textLines(a).length * FONT_SIZE * LINE_HEIGHT) };
    const b = bounds([a])!;
    return { w: b.x2 - b.x1, h: b.y2 - b.y1 };
  }, []);
  const textRef = (id: string) => (el: SVGTextElement | null) => {
    if (el) textEls.current.set(id, el);
    else textEls.current.delete(id);
  };
  // A text's selection outline is measured from its rendered box: render once more after the text is drawn.
  const [, remeasure] = useReducer((n: number) => n + 1, 0);
  const selectedText = selected !== null && list.some((a) => a.id === selected && a.kind === "text");
  useLayoutEffect(() => {
    if (selectedText) remeasure();
  }, [selectedText, list]);

  /** The live viewport (the state copy may lag a frame behind a pan). */
  const viewport = (): Viewport => (cy ? { pan: cy.pan(), zoom: cy.zoom() } : vp);
  const toModel = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current!.getBoundingClientRect();
    const { pan, zoom } = viewport();
    return { x: (e.clientX - r.left - pan.x) / zoom, y: (e.clientY - r.top - pan.y) / zoom };
  };

  /** Ends text editing: a new non-empty text is added (one step), an edited one updated, or removed when emptied. */
  const commitText = () => {
    const ed = editorRef.current;
    if (!ed) return;
    setEd(null);
    const s = useAnnotations.getState();
    const empty = ed.text.trim() === "";
    if (ed.id !== null) {
      if (empty) s.remove(view, ed.id);
      else s.update(view, ed.id, { text: ed.text });
    } else if (!empty) {
      const a: Annotation = { id: newId(), kind: "text", color: ed.color, x1: ed.x, y1: ed.y, x2: ed.x, y2: ed.y, text: ed.text };
      s.add(view, a);
      if (s.active === view) s.select(a.id);
    }
  };
  const commitTextRef = useRef(commitText);
  commitTextRef.current = commitText;

  // Leaving the mode ends any gesture and commits the text being written.
  useEffect(() => {
    if (on) return;
    gesture.current = null;
    setDraft(null);
    setMove(null);
    commitTextRef.current();
  }, [on]);

  useAnnotateKeys(view, on);

  // The overlay is not inside the Cytoscape container: hand it the wheel, so the canvas still zooms.
  useEffect(() => {
    const svg = svgRef.current;
    if (!on || !svg || !cy) return;
    const forward = (e: WheelEvent) => {
      e.preventDefault();
      const { clientX, clientY, screenX, screenY, deltaX, deltaY, deltaZ, deltaMode, ctrlKey, shiftKey, altKey, metaKey } = e;
      cy.container()?.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          ...{ clientX, clientY, screenX, screenY, deltaX, deltaY, deltaZ, deltaMode, ctrlKey, shiftKey, altKey, metaKey },
        }),
      );
    };
    svg.addEventListener("wheel", forward, { passive: false });
    return () => svg.removeEventListener("wheel", forward);
  }, [on, cy]);

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!on) return;
    e.stopPropagation();
    if (e.button !== 0) return;
    // A press elsewhere while writing only ends the text.
    if (editorRef.current) return commitText();
    const p = toModel(e);
    const s = useAnnotations.getState();
    if (s.tool === "select") {
      const hit = hitTest(list, p, HIT_PX / viewport().zoom, measure);
      s.select(hit);
      gesture.current = hit === null ? null : { kind: "move", id: hit, from: p, moving: false };
    } else if (s.tool === "text") {
      gesture.current = { kind: "text", at: p };
    } else {
      const shape: Annotation = { id: newId(), kind: s.tool, color: s.color, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
      gesture.current = { kind: "draw", shape };
      setDraft(shape);
    }
    if (gesture.current) {
      try {
        e.currentTarget.setPointerCapture(e.pointerId); // keep the drag when it leaves the canvas
      } catch {
        // not an active pointer (synthetic events)
      }
    }
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!on) return;
    e.stopPropagation();
    const g = gesture.current;
    if (!g || g.kind === "text") return;
    const p = toModel(e);
    if (g.kind === "draw") {
      g.shape = { ...g.shape, x2: p.x, y2: p.y };
      setDraft(g.shape);
      return;
    }
    const dx = p.x - g.from.x;
    const dy = p.y - g.from.y;
    g.moving ||= Math.hypot(dx, dy) * viewport().zoom >= DRAG_MIN_PX;
    if (g.moving) setMove({ id: g.id, dx, dy });
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!on) return;
    e.stopPropagation();
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const p = toModel(e);
    const s = useAnnotations.getState();
    if (g.kind === "text") {
      setEd({ id: null, x: g.at.x, y: g.at.y, color: s.color, text: "" });
    } else if (g.kind === "draw") {
      setDraft(null);
      const shape = { ...g.shape, x2: p.x, y2: p.y };
      if (Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1) * viewport().zoom < DRAG_MIN_PX) return;
      s.add(view, shape);
      s.select(shape.id);
    } else {
      setMove(null);
      const a = (s.byView[view] ?? []).find((x) => x.id === g.id);
      if (!g.moving || !a) return;
      const { x1, y1, x2, y2 } = translate(a, p.x - g.from.x, p.y - g.from.y);
      s.update(view, a.id, { x1, y1, x2, y2 });
    }
  };

  const onPointerCancel = () => {
    gesture.current = null;
    setDraft(null);
    setMove(null);
  };

  // Double-clicking a text with the select tool edits it.
  const onDoubleClick = (e: ReactMouseEvent<SVGSVGElement>) => {
    if (!on) return;
    e.stopPropagation();
    if (useAnnotations.getState().tool !== "select") return;
    const hit = hitTest(list, toModel(e), HIT_PX / viewport().zoom, measure);
    const a = list.find((x) => x.id === hit);
    if (a?.kind !== "text") return;
    setEd({ id: a.id, x: a.x1, y: a.y1, color: a.color, text: a.text ?? "" });
  };

  const shown = list
    .filter((a) => a.id !== editor?.id)
    .map((a) => (move?.id === a.id ? translate(a, move.dx, move.dy) : a));
  const sel = on ? shown.find((a) => a.id === selected) : undefined;
  const selBox = sel ? bounds([sel], measure) : null;
  const pad = 4 / vp.zoom;
  const editorLines = editor ? editor.text.split("\n") : [];

  return (
    <>
      <svg
        ref={svgRef}
        className={on ? `annotation-layer annotation-layer--active annotation-layer--${tool}` : "annotation-layer"}
        aria-hidden="true"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onDoubleClick={onDoubleClick}
      >
        <g transform={`translate(${vp.pan.x} ${vp.pan.y}) scale(${vp.zoom})`}>
          {shown.map((a) => (
            <Shape key={a.id} a={a} textRef={a.kind === "text" ? textRef(a.id) : undefined} />
          ))}
          {draft && <Shape a={draft} />}
          {selBox && (
            <rect
              className="annotation-layer__selection"
              x={selBox.x1 - pad}
              y={selBox.y1 - pad}
              width={selBox.x2 - selBox.x1 + 2 * pad}
              height={selBox.y2 - selBox.y1 + 2 * pad}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={1 / vp.zoom}
              strokeDasharray={`${4 / vp.zoom} ${3 / vp.zoom}`}
            />
          )}
        </g>
      </svg>
      {editor && (
        <textarea
          className="annotate-editor"
          autoFocus
          spellCheck={false}
          value={editor.text}
          rows={editorLines.length}
          cols={Math.max(...editorLines.map((l) => l.length), 1) + 1}
          style={{
            left: editor.x * vp.zoom + vp.pan.x,
            // The first line's box starts half a leading above the text's top, as the overlay draws it.
            top: (editor.y - ((LINE_HEIGHT - 1) / 2) * FONT_SIZE) * vp.zoom + vp.pan.y,
            fontSize: FONT_SIZE * vp.zoom,
            lineHeight: LINE_HEIGHT,
            color: `var(--note-${editor.color})`,
          }}
          onChange={(e) => setEd({ ...editor, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return; // an IME's Enter picks a candidate
            if ((e.key === "Enter" && !e.shiftKey) || e.key === "Escape") {
              e.preventDefault();
              commitText();
            }
          }}
          onBlur={commitText}
        />
      )}
    </>
  );
}
