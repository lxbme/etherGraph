import { AlertTriangle, Info, X } from "lucide-react";
import { create } from "zustand";
import { useT } from "../i18n";

type Kind = "error" | "info";
export interface ToastAction {
  label: string;
  onClick(): void;
}
export interface ToastOptions {
  /** A button on the toast; clicking it runs `onClick` and dismisses the toast. */
  action?: ToastAction;
  /** How long the toast stays (default 5 s); null: until dismissed. */
  ttlMs?: number | null;
  /** Runs once when the toast goes, however it goes (timer, close button, action, eviction, dismissToast). */
  onDismiss?(): void;
}
interface ToastItem { id: number; msg: string; kind: Kind; action?: ToastAction }

const MAX_VISIBLE = 3;
const TTL_MS = 5000;
let nextId = 1;
const onDismissById = new Map<number, () => void>();

const useToastStore = create<{ items: ToastItem[] }>(() => ({ items: [] }));

function gone(ids: number[]): void {
  for (const id of ids) {
    const f = onDismissById.get(id);
    onDismissById.delete(id);
    f?.();
  }
}

/** Shows a toast; returns its id for `dismissToast`. Over MAX_VISIBLE, the oldest toast without an action goes first. */
export function toast(msg: string, kind: Kind = "info", opts: ToastOptions = {}): number {
  const id = nextId++;
  const item: ToastItem = opts.action ? { id, msg, kind, action: opts.action } : { id, msg, kind };
  if (opts.onDismiss) onDismissById.set(id, opts.onDismiss);
  const items = [...useToastStore.getState().items, item];
  const evicted: number[] = [];
  while (items.length > MAX_VISIBLE) {
    const plain = items.findIndex((t) => !t.action);
    evicted.push(items.splice(plain === -1 ? 0 : plain, 1)[0]!.id);
  }
  useToastStore.setState({ items });
  gone(evicted);
  const ttl = opts.ttlMs === undefined ? TTL_MS : opts.ttlMs;
  if (ttl !== null) setTimeout(() => dismissToast(id), ttl);
  return id;
}

/** Removes the toast now; unknown or already gone ids are ignored. */
export function dismissToast(id: number): void {
  const { items } = useToastStore.getState();
  if (!items.some((t) => t.id === id)) return;
  useToastStore.setState({ items: items.filter((t) => t.id !== id) });
  gone([id]);
}

/** Removes every toast (tests). */
export function clearToasts(): void {
  const ids = useToastStore.getState().items.map((t) => t.id);
  useToastStore.setState({ items: [] });
  gone(ids);
}

export function Toasts() {
  const t = useT();
  const items = useToastStore((s) => s.items);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((it) => (
        <div key={it.id} className={`toast toast--${it.kind}`}>
          {it.kind === "error" ? <AlertTriangle className="toast__icon" size={16} /> : <Info className="toast__icon" size={16} />}
          <span className="toast__msg">{it.msg}</span>
          {it.action && (
            <button
              type="button"
              className="btn btn--compact btn--ghost toast__action"
              onClick={() => {
                dismissToast(it.id);
                it.action?.onClick();
              }}
            >
              {it.action.label}
            </button>
          )}
          <button
            type="button"
            className="btn btn--compact btn--ghost btn--icon toast__close"
            aria-label={t("common.dismiss")}
            title={t("common.dismiss")}
            onClick={() => dismissToast(it.id)}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
