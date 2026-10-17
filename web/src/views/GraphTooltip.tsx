import { useLayoutEffect, useRef, useState, type JSX } from "react";
import type { TooltipLine } from "../graph/tooltip";

/** Keep in step with `.graph-tooltip` max-width. */
const MAX_WIDTH = 280;
const GAP = 12;

/**
 * Hover explanation placed beside `anchor` (container-relative), flipped to the left / above when it
 * would overflow the container (its offset parent).
 */
export function GraphTooltip({ anchor, lines }: { anchor: { x: number; y: number }; lines: TooltipLine[] }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.x + GAP, top: anchor.y + GAP });
  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.parentElement;
    const w = el?.offsetWidth || MAX_WIDTH;
    const h = el?.offsetHeight || 0;
    const cw = box?.clientWidth ?? Infinity;
    const ch = box?.clientHeight ?? Infinity;
    let left = anchor.x + GAP;
    let top = anchor.y + GAP;
    if (left + w > cw) left = anchor.x - GAP - w;
    if (top + h > ch) top = anchor.y - GAP - h;
    setPos({ left: Math.max(0, left), top: Math.max(0, top) });
  }, [anchor.x, anchor.y, lines]);

  return (
    <div ref={ref} className="graph-tooltip" role="tooltip" data-testid="graph-tooltip" style={{ left: pos.left, top: pos.top }}>
      {lines.map((l, i) => (
        <div key={i} className="graph-tooltip__line">
          {l.label && <span className="graph-tooltip__label">{l.label}</span>}
          <span className={l.mono ? "graph-tooltip__value graph-tooltip__value--mono" : "graph-tooltip__value"} title={l.title}>
            {l.value}
          </span>
        </div>
      ))}
    </div>
  );
}
