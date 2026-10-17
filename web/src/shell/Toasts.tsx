import { AlertTriangle, Info } from "lucide-react";
import { create } from "zustand";

type Kind = "error" | "info";
export interface ToastAction {
  label: string;
  onClick(): void;
}
export interface ToastOptions {
  /** A button on the toast; clicking it runs `onClick` and dismisses the toast. */
  action?: ToastAction;
  /** How long the toast stays (default 5 s). */
  ttlMs?: number;
}
interface ToastItem { id: number; msg: string; kind: Kind; action?: ToastAction }

const MAX_VISIBLE = 3;
const TTL_MS = 5000;
let nextId = 1;

const useToastStore = create<{ items: ToastItem[] }>(() => ({ items: [] }));

/** Shows a toast; returns its id for `dismissToast`. */
export function toast(msg: string, kind: Kind = "info", opts: ToastOptions = {}): number {
  const id = nextId++;
  const item: ToastItem = opts.action ? { id, msg, kind, action: opts.action } : { id, msg, kind };
  useToastStore.setState((s) => ({ items: [...s.items, item].slice(-MAX_VISIBLE) }));
  setTimeout(() => dismissToast(id), opts.ttlMs ?? TTL_MS);
  return id;
}

/** Removes the toast now; unknown or already gone ids are ignored. */
export function dismissToast(id: number): void {
  useToastStore.setState((s) => (s.items.some((t) => t.id === id) ? { items: s.items.filter((t) => t.id !== id) } : s));
}

export function Toasts() {
  const items = useToastStore((s) => s.items);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          {t.kind === "error" ? <AlertTriangle className="toast__icon" size={16} /> : <Info className="toast__icon" size={16} />}
          <span className="toast__msg">{t.msg}</span>
          {t.action && (
            <button
              type="button"
              className="btn btn--compact btn--ghost toast__action"
              onClick={() => {
                dismissToast(t.id);
                t.action?.onClick();
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
