import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import { useT } from "../i18n";

const STEP = 24;

function load(key: string, min: number): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    const v = Number(raw);
    return Number.isFinite(v) && v >= min ? v : null;
  } catch {
    return null;
  }
}
function save(key: string, h: number) {
  try {
    localStorage.setItem(key, String(Math.round(h)));
  } catch {
    /* ignore */
  }
}

/** A top pane over a height-resizable bottom pane; the bottom height is remembered under `storageKey`. */
export function ResizableSplit({
  top,
  bottom,
  storageKey = "ethergraph.splitHeight",
  minBottom = 120,
  minTop = 120,
  defaultShare = 0.32,
  className,
}: {
  top: ReactNode;
  bottom: ReactNode;
  storageKey?: string;
  minBottom?: number;
  minTop?: number;
  defaultShare?: number;
  className?: string;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(() => load(storageKey, minBottom));
  const dragging = useRef(false);
  const latest = useRef<number | null>(height);

  const clamp = useCallback((h: number) => {
    const total = ref.current?.getBoundingClientRect().height ?? 0;
    const max = total > 0 ? Math.max(minBottom, total - minTop) : Infinity;
    return Math.min(Math.max(h, minBottom), max);
  }, [minBottom, minTop]);

  // A height remembered on a bigger window is pulled back now and whenever the container changes size.
  useLayoutEffect(() => {
    const apply = () => {
      if (latest.current == null) return;
      const c = clamp(latest.current);
      if (c === latest.current) return;
      latest.current = c;
      setHeight(c);
    };
    apply();
    if (typeof ResizeObserver === "undefined" || !ref.current) return;
    const ro = new ResizeObserver(apply);
    ro.observe(ref.current);
    return () => ro.disconnect();
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
    if (latest.current != null) save(storageKey, latest.current);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const cur = latest.current ?? (ref.current ? ref.current.getBoundingClientRect().height * defaultShare : 200);
    const next = clamp(cur + (e.key === "ArrowUp" ? STEP : -STEP));
    latest.current = next;
    setHeight(next);
    save(storageKey, next);
  };

  return (
    <div className={className ? `split ${className}` : "split"} ref={ref}>
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
      <div className="split__bottom" style={{ height: height != null ? `${height}px` : `${defaultShare * 100}%` }}>{bottom}</div>
    </div>
  );
}
