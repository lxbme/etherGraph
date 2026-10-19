import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

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

/**
 * A main pane beside a width-resizable side column; the side width is remembered under `storageKey`.
 * The chosen width is kept as is and only shown clamped to the container, so a window shrunk and grown
 * back returns to it.
 */
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
  const sideRef = useRef<HTMLDivElement>(null);
  const [preferred, setPreferred] = useState<number | null>(() => load(storageKey, minSide));
  // The container's width less the separator's (0 until measured: nothing is clamped yet).
  const [room, setRoom] = useState(0);
  const dragging = useRef(false);
  const latest = useRef<number | null>(preferred);

  const clampTo = (w: number, space: number) => {
    const max = space > 0 ? Math.max(minSide, space - minMain) : Infinity;
    return Math.min(Math.max(w, minSide), max);
  };
  const measure = () => {
    const total = ref.current?.getBoundingClientRect().width ?? 0;
    return total > 0 ? total - (handleRef.current?.offsetWidth ?? 0) : 0;
  };
  const shown = preferred != null ? clampTo(preferred, room) : null;

  // Measured now and whenever the container changes size; only the shown width follows, the chosen one stays.
  useLayoutEffect(() => {
    const apply = () => setRoom(measure());
    apply();
    if (typeof ResizeObserver === "undefined" || !ref.current) return;
    const ro = new ResizeObserver(apply);
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const choose = (w: number) => {
    latest.current = w;
    setPreferred(w);
  };
  const onPointerDown = (e: PointerEvent) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging.current || !ref.current) return;
    choose(clampTo(ref.current.getBoundingClientRect().right - e.clientX, measure()));
  };
  // Released, cancelled (touch scroll, system gesture) or capture lost: the drag ends where it is.
  const endDrag = () => {
    if (!dragging.current) return;
    dragging.current = false;
    if (latest.current != null) save(storageKey, latest.current);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const cur = shown ?? sideRef.current?.getBoundingClientRect().width ?? minSide;
    const next = clampTo(cur + (e.key === "ArrowLeft" ? STEP : -STEP), measure());
    choose(next);
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
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onKeyDown={onKeyDown}
      />
      <div
        className="rside__side"
        ref={sideRef}
        style={{ width: shown != null ? `${shown}px` : typeof defaultWidth === "number" ? `${defaultWidth}px` : defaultWidth, minWidth: minSide, maxWidth: `calc(100% - ${minMain}px)` }}
      >
        {side}
      </div>
    </div>
  );
}
