import { create } from "zustand";

type Kind = "error" | "info";
interface ToastItem { id: number; msg: string; kind: Kind }

const MAX_VISIBLE = 3;
const TTL_MS = 5000;
let nextId = 1;

const useToastStore = create<{ items: ToastItem[] }>(() => ({ items: [] }));

export function toast(msg: string, kind: Kind = "info"): void {
  const id = nextId++;
  useToastStore.setState((s) => ({ items: [...s.items, { id, msg, kind }].slice(-MAX_VISIBLE) }));
  setTimeout(() => {
    useToastStore.setState((s) => ({ items: s.items.filter((t) => t.id !== id) }));
  }, TTL_MS);
}

export function Toasts() {
  const items = useToastStore((s) => s.items);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>{t.msg}</div>
      ))}
    </div>
  );
}
