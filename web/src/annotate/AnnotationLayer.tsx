import type cytoscape from "cytoscape";
import { useEffect, useState } from "react";
import { arrowHead, ellipseOf, rectOf, textLines } from "./geometry";
import { FONT_SIZE, LINE_HEIGHT, STROKE_WIDTH, type Annotation, type ViewId } from "./model";
import { useAnnotations } from "./store";

const NO_NOTES: Annotation[] = []; // stable, so an untouched view does not re-render on every store change

const tokenOf = (a: Annotation) => `var(--note-${a.color})`;

function Shape({ a }: { a: Annotation }) {
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
      return (
        <text x={a.x1} y={a.y1} fill={color} fontSize={FONT_SIZE} dominantBaseline="hanging">
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
 * Colours reference the theme tokens, so a theme switch needs no re-render. It never takes pointer events.
 */
export function AnnotationLayer({ view, cy }: { view: ViewId; cy: cytoscape.Core | null }) {
  const list = useAnnotations((s) => s.byView[view] ?? NO_NOTES);
  const [vp, setVp] = useState(() => (cy ? { pan: cy.pan(), zoom: cy.zoom() } : { pan: { x: 0, y: 0 }, zoom: 1 }));
  useEffect(() => {
    if (!cy) return;
    const sync = () => setVp({ pan: { ...cy.pan() }, zoom: cy.zoom() });
    sync();
    cy.on("viewport resize", sync);
    return () => {
      cy.off("viewport resize", sync);
    };
  }, [cy]);
  return (
    <svg className="annotation-layer" aria-hidden="true">
      <g transform={`translate(${vp.pan.x} ${vp.pan.y}) scale(${vp.zoom})`}>
        {list.map((a) => (
          <Shape key={a.id} a={a} />
        ))}
      </g>
    </svg>
  );
}
