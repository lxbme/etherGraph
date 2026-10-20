import { create } from "zustand";
import { useGraph } from "../../graph/store";
import { useTabs } from "../../shell/tabs";
import { useUi } from "../uiStore";
import type { DocId } from "./docs";

/** What the right panel shows instead of the node detail: an asset (null = ETH) or a documentation topic. */
/** The kind of the transfer an asset was opened from: the server's fallback standard when it has no tokens row. */
export type TokenKind = "erc20" | "erc721" | "erc1155";

export const tokenKindOf = (k: string): TokenKind | undefined => (k === "erc20" || k === "erc721" || k === "erc1155" ? k : undefined);

export type InfoView = { kind: "asset"; asset: string | null; tokenId?: string; tokenKind?: TokenKind } | { kind: "doc"; id: DocId };

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

/**
 * Opens documentation page `id` over `tab`'s detail panel. The data tab has no right panel: from there the page
 * opens on the graph tab, which is shown first. Every doc link goes through here.
 */
export function openDoc(tab: string, id: DocId): void {
  let target = tab;
  if (tab === "data") {
    useTabs.getState().activate("graph");
    target = "graph";
  }
  useInfo.getState().open(target, { kind: "doc", id });
}

// Whatever changes the graph tab's selection (canvas tap, transfer row, search pick, hash route) must show
// its result in the panel, so the views stacked over the detail are dropped.
useGraph.subscribe((s, prev) => {
  if (s.selection !== prev.selection && (useInfo.getState().stacks["graph"]?.length ?? 0) > 0) useInfo.getState().close("graph");
});
