import { create } from "zustand";
import { useUi } from "../uiStore";
import type { DocId } from "./docs";

/** What the right panel shows instead of the node detail: an asset (null = ETH) or a documentation topic. */
export type InfoView = { kind: "asset"; asset: string | null; tokenId?: string } | { kind: "doc"; id: DocId };

const same = (a: InfoView, b: InfoView): boolean =>
  a.kind === "doc" || b.kind === "doc"
    ? a.kind === b.kind && (a as { id: DocId }).id === (b as { id: DocId }).id
    : a.asset === b.asset && a.tokenId === b.tokenId;

interface InfoState {
  /** Per tab (`"graph"` or the tx hash): the views stacked over its detail panel, the last one shown. */
  stacks: Record<string, InfoView[]>;
  /** Pushes a view (not twice in a row) and opens the right panel if it is collapsed. */
  open(tab: string, view: InfoView): void;
  /** Pops the top view; an empty stack shows the underlying detail again. */
  back(tab: string): void;
  /** Clears the tab's stack. */
  close(tab: string): void;
  /** Drops a closed tab's stack. */
  forget(tab: string): void;
}

export const useInfo = create<InfoState>((set, get) => ({
  stacks: {},
  open: (tab, view) => {
    const stack = get().stacks[tab] ?? [];
    const top = stack[stack.length - 1];
    if (!top || !same(top, view)) set((s) => ({ stacks: { ...s.stacks, [tab]: [...stack, view] } }));
    useUi.getState().setDetailOpen(true);
  },
  back: (tab) => set((s) => ({ stacks: { ...s.stacks, [tab]: (s.stacks[tab] ?? []).slice(0, -1) } })),
  close: (tab) => set((s) => ({ stacks: { ...s.stacks, [tab]: [] } })),
  forget: (tab) =>
    set((s) => {
      const stacks = { ...s.stacks };
      delete stacks[tab.toLowerCase()];
      delete stacks[tab];
      return { stacks };
    }),
}));
