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
function save(key: string, w: number) {
  try {
    localStorage.setItem(key, String(Math.round(w)));
  } catch {
    /* ignore */
  }
}

/** A main pane beside a width-resizable side column; the side width is remembered under `storageKey`. */
export function ResizableSide({
  main,
  side,
  storageKey,
  minSide = 280,
  minMain = 320,
  defaultWidth,
  className,
}: {
  main: ReactNode;
  side: ReactNode;
  storageKey: string;
  minSide?: number;
  minMain?: number;
  /** CSS width used until the user resizes (a number is px). */
  defaultWidth: number | string;
  className?: string;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(() => load(storageKey, minSide));
  const dragging = useRef(false);
  const latest = useRef<number | null>(width);

  const clamp = useCallback(
    (w: number) => {
      const total = ref.current?.getBoundingClientRect().width ?? 0;
      const grip = handleRef.current?.offsetWidth ?? 0;
      const max = total > 0 ? Math.max(minSide, total - minMain - grip) : Infinity;
      return Math.min(Math.max(w, minSide), max);
    },
    [minSide, minMain],
  );

  // A width remembered on a bigger window is pulled back now and whenever the container changes size.
  useLayoutEffect(() => {
    const apply = () => {
      if (latest.current == null) return;
      const c = clamp(latest.current);
      if (c === latest.current) return;
      latest.current = c;
      setWidth(c);
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
    const w = clamp(ref.current.getBoundingClientRect().right - e.clientX);
    latest.current = w;
    setWidth(w);
  };
  const onPointerUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    if (latest.current != null) save(storageKey, latest.current);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const cur = latest.current ?? e.currentTarget.nextElementSibling?.getBoundingClientRect().width ?? minSide;
    const next = clamp(cur + (e.key === "ArrowLeft" ? STEP : -STEP));
    latest.current = next;
    setWidth(next);
    save(storageKey, next);
  };

  return (
    <div className={className ? `rside ${className}` : "rside"} ref={ref}>
      <div className="rside__main">{main}</div>
      <div
        className="rside__handle"
        ref={handleRef}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("split.resizeColumn")}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
      />
      <div
        className="rside__side"
        style={{ width: width != null ? `${width}px` : typeof defaultWidth === "number" ? `${defaultWidth}px` : defaultWidth, minWidth: minSide, maxWidth: `calc(100% - ${minMain}px)` }}
      >
        {side}
      </div>
    </div>
  );
}
