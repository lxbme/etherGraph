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
function save(key: string, h: number) {
  try {
    localStorage.setItem(key, String(Math.round(h)));
  } catch {
    /* ignore */
  }
}

/**
 * A top pane over a height-resizable bottom pane; the bottom height is remembered under `storageKey`.
 * The chosen height is kept as is and only shown clamped to the container, so a window shrunk and grown
 * back returns to it.
 */
export function ResizableSplit({
  top,
  bottom,
  storageKey = "ethergraph.splitHeight",
  minBottom = 120,
  minTop = 120,
  defaultShare = 0.32,
  label,
  className,
}: {
  top: ReactNode;
  bottom: ReactNode;
  storageKey?: string;
  minBottom?: number;
  minTop?: number;
  defaultShare?: number;
  /** The separator's accessible name (default: the address graph's "resize the details table"). */
  label?: string;
  className?: string;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [preferred, setPreferred] = useState<number | null>(() => load(storageKey, minBottom));
  // The container's height less the separator's (0 until measured: nothing is clamped yet).
  const [room, setRoom] = useState(0);
  const dragging = useRef(false);
  const latest = useRef<number | null>(preferred);

  const clampTo = (h: number, space: number) => {
    const max = space > 0 ? Math.max(minBottom, space - minTop) : Infinity;
    return Math.min(Math.max(h, minBottom), max);
  };
  const measure = () => {
    const total = ref.current?.getBoundingClientRect().height ?? 0;
    return total > 0 ? total - (handleRef.current?.offsetHeight ?? 0) : 0;
  };
  const shown = preferred != null ? clampTo(preferred, room) : null;

  // Measured now and whenever the container changes size; only the shown height follows, the chosen one stays.
  useLayoutEffect(() => {
    const apply = () => setRoom(measure());
    apply();
    if (typeof ResizeObserver === "undefined" || !ref.current) return;
    const ro = new ResizeObserver(apply);
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const choose = (h: number) => {
    latest.current = h;
    setPreferred(h);
  };
  const onPointerDown = (e: PointerEvent) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!dragging.current || !ref.current) return;
    choose(clampTo(ref.current.getBoundingClientRect().bottom - e.clientY, measure()));
  };
  // Released, cancelled (touch scroll, system gesture) or capture lost: the drag ends where it is.
  const endDrag = () => {
    if (!dragging.current) return;
    dragging.current = false;
    if (latest.current != null) save(storageKey, latest.current);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const cur = shown ?? bottomRef.current?.getBoundingClientRect().height ?? 0;
    const next = clampTo(cur + (e.key === "ArrowUp" ? STEP : -STEP), measure());
    choose(next);
    save(storageKey, next);
  };

  return (
    <div className={className ? `split ${className}` : "split"} ref={ref}>
      <div className="split__top">{top}</div>
      <div
        className="split__handle"
        ref={handleRef}
        role="separator"
        aria-orientation="horizontal"
        aria-label={label ?? t("split.resize")}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onKeyDown={onKeyDown}
      />
      <div className="split__bottom" ref={bottomRef} style={{ height: shown != null ? `${shown}px` : `${defaultShare * 100}%` }}>{bottom}</div>
    </div>
  );
}
