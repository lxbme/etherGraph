import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import { useT } from "../i18n";

const MIN_BOTTOM = 120;
const KEY = "ethergraph.splitHeight";

function load(): number | null {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v >= MIN_BOTTOM ? v : null;
  } catch {
    return null;
  }
}
function save(h: number) {
  try {
    localStorage.setItem(KEY, String(Math.round(h)));
  } catch {
    /* ignore */
  }
}

export function ResizableSplit({ top, bottom }: { top: ReactNode; bottom: ReactNode }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(load);
  const dragging = useRef(false);
  const latest = useRef<number | null>(height);

  const clamp = useCallback((h: number) => {
    const total = ref.current?.getBoundingClientRect().height ?? 0;
    const max = total > 0 ? Math.max(MIN_BOTTOM, total - MIN_BOTTOM) : Infinity;
    return Math.min(Math.max(h, MIN_BOTTOM), max);
  }, []);

  useLayoutEffect(() => {
    if (latest.current == null) return;
    const c = clamp(latest.current);
    latest.current = c;
    setHeight(c);
  }, [clamp]);

  const onPointerDown = (e: PointerEvent) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging.current || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const h = clamp(rect.bottom - e.clientY);
    latest.current = h;
    setHeight(h);
  };
  const onPointerUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    if (latest.current != null) save(latest.current);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const cur = latest.current ?? (ref.current ? ref.current.getBoundingClientRect().height * 0.32 : 200);
    const next = clamp(cur + (e.key === "ArrowUp" ? 24 : -24));
    latest.current = next;
    setHeight(next);
    save(next);
  };

  return (
    <div className="split" ref={ref}>
      <div className="split__top">{top}</div>
      <div
        className="split__handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("split.resize")}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
      />
      <div className="split__bottom" style={{ height: height != null ? `${height}px` : "32%" }}>{bottom}</div>
    </div>
  );
}
