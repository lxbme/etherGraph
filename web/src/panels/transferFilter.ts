import { create } from "zustand";
import type { TransfersParams } from "../api/endpoints";
import { useGraph } from "../graph/store";
import type { TransferKind } from "../lib/transferKinds";

/** The bottom transfer table's own filter, independent of the graph filter. */
export interface TransferTableFilter {
  /** UTC days "YYYY-MM-DD"; null = open. */
  from: string | null;
  to: string | null;
  /** undefined = all assets; null = ETH; else a lowercase token address. */
  asset: string | null | undefined;
  direction: "all" | "in" | "out";
  kind: "all" | TransferKind;
}

const DEFAULT: TransferTableFilter = { from: null, to: null, asset: undefined, direction: "all", kind: "all" };

interface TransferFilterState extends TransferTableFilter {
  set(patch: Partial<TransferTableFilter>): void;
  reset(): void;
}

/** Not persisted: it survives selection changes and starts over with a new canvas (graph `epoch`). */
export const useTransferFilter = create<TransferFilterState>((set) => ({
  ...DEFAULT,
  set: (patch) => set(patch),
  reset: () => set(DEFAULT),
}));

useGraph.subscribe((s, prev) => {
  if (s.epoch !== prev.epoch) useTransferFilter.getState().reset();
});

/** Whether `f` narrows nothing. */
export function isDefault(f: TransferTableFilter): boolean {
  return f.from === null && f.to === null && f.asset === undefined && f.direction === "all" && f.kind === "all";
}

/** The query params of `f`: whole UTC days (an inverted range swapped), and only the fields it sets. */
export function transferParams(
  f: TransferTableFilter,
): Pick<TransfersParams, "timeFrom" | "timeTo" | "asset" | "direction" | "kinds"> {
  const out: Pick<TransfersParams, "timeFrom" | "timeTo" | "asset" | "direction" | "kinds"> = {};
  const [from, to] = f.from !== null && f.to !== null && f.from > f.to ? [f.to, f.from] : [f.from, f.to];
  if (from !== null) out.timeFrom = `${from}T00:00:00Z`;
  if (to !== null) out.timeTo = `${to}T23:59:59Z`;
  if (f.asset !== undefined) out.asset = f.asset;
  if (f.direction !== "all") out.direction = f.direction;
  if (f.kind !== "all") out.kinds = [f.kind];
  return out;
}
