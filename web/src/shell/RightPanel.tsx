import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import { useT } from "../i18n";

const KEY = "eg.rightWidth";
const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 280;
const MAX_SHARE = 0.4;
const KEY_STEP = 16;

/** The widest the panel may be: 40% of the viewport, but never below the minimum. */
function maxWidth(): number {
  return Math.max(MIN_WIDTH, Math.floor(window.innerWidth * MAX_SHARE));
}
/** Between 280px and 40% of the viewport; the minimum wins on very narrow screens. */
function clamp(w: number): number {
  return Math.round(Math.min(Math.max(w, MIN_WIDTH), maxWidth()));
}
function load(): number {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw === null ? NaN : Number(raw);
    return Number.isFinite(v) ? clamp(v) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}
function save(w: number) {
  try {
    localStorage.setItem(KEY, String(w));
  } catch {
    /* storage unavailable: keep the width for this session only */
  }
}

/** The right-hand detail panel, resizable by dragging (or arrow keys on) its left edge. */
export function RightPanel({ children }: { children: ReactNode }) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(load);
  const dragging = useRef(false);
  const latest = useRef(width);

  const set = (w: number) => {
    latest.current = w;
    setWidth(w);
  };
  const onPointerDown = (e: PointerEvent) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging.current || !ref.current) return;
    set(clamp(ref.current.getBoundingClientRect().right - e.clientX));
  };
  const onPointerUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    save(latest.current);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = clamp(latest.current + (e.key === "ArrowLeft" ? KEY_STEP : -KEY_STEP));
    set(next);
    save(next);
  };

  return (
    <aside className="main__right" ref={ref} style={{ width: `${width}px` }}>
      <div
        className="main__right-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("panel.resize")}
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={maxWidth()}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      />
      <div className="main__right-body">{children}</div>
    </aside>
  );
}
