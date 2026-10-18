import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

/**
 * The shell of a right-click menu: fixed at viewport coordinates (kept inside the viewport), closing on
 * Escape or an outside press. Items are `MenuItem`s, which close the menu after running.
 */
export function MenuShell({ x, y, onClose, children }: { x: number; y: number; onClose(): void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.(".ctx-menu")) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [onClose]);

  const ref = useRef<HTMLDivElement>(null);
  // Keep the menu inside the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.left = `${Math.max(0, Math.min(x, window.innerWidth - el.offsetWidth - 4))}px`;
    el.style.top = `${Math.max(0, Math.min(y, window.innerHeight - el.offsetHeight - 4))}px`;
  }, [x, y]);

  return (
    <div className="menu ctx-menu" role="menu" ref={ref} style={{ left: x, top: y }}>
      {children}
    </div>
  );
}

/** One menu entry: runs `onRun`, then closes the menu. */
export function MenuItem({ onRun, onClose, children }: { onRun(): void; onClose(): void; children: ReactNode }) {
  return (
    <button
      role="menuitem"
      className="menu__item"
      onClick={() => {
        onRun();
        onClose();
      }}
    >
      {children}
    </button>
  );
}
