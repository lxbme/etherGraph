import { create } from "zustand";
import type { TransferDto } from "../api/generated/TransferDto";
import { transferKey, type HiddenTransfer } from "../graph/hiddenTransfers";
import { useGraph } from "../graph/store";
import { parseHumanAmount } from "../lib/amount";
import { transferParams } from "../panels/transferFilter";

/** The Data tab's own filter over its loaded rows, on top of the graph filter they already pass. */
export interface DataFilter {
  /** UTC days "YYYY-MM-DD", both inclusive; null = open. */
  from: string | null;
  to: string | null;
  /** undefined = all assets; null = ETH; else a lowercase token address. */
  asset: string | null | undefined;
  kind: "all" | TransferDto["kind"];
  /** A substring (any case) of the address or of its name, on the side(s) `addressRole` names; "" = any. */
  address: string;
  addressRole: "any" | "from" | "to";
  /** Whole units ("1,000.5"), applied only when one asset is chosen; "" (or an invalid entry) = open. */
  minAmount: string;
  maxAmount: string;
  /** Whether hidden transfers are listed (muted). */
  showHidden: boolean;
}

export const DEFAULT_DATA_FILTER: DataFilter = {
  from: null,
  to: null,
  asset: undefined,
  kind: "all",
  address: "",
  addressRole: "any",
  minAmount: "",
  maxAmount: "",
  showHidden: true,
};

interface DataFilterState extends DataFilter {
  set(patch: Partial<DataFilter>): void;
  reset(): void;
}

/** Not persisted: it starts over with a new canvas (graph `epoch`). */
export const useDataFilter = create<DataFilterState>((set) => ({
  ...DEFAULT_DATA_FILTER,
  set: (patch) => set(patch),
  reset: () => set(DEFAULT_DATA_FILTER),
}));

useGraph.subscribe((s, prev) => {
  if (s.epoch !== prev.epoch) useDataFilter.getState().reset();
});

/** Whether `f` narrows nothing (the amount bounds count only while one asset is chosen, as they apply). */
export function isDefaultDataFilter(f: DataFilter): boolean {
  return (
    f.from === null &&
    f.to === null &&
    f.asset === undefined &&
    f.kind === "all" &&
    f.address.trim() === "" &&
    f.addressRole === "any" &&
    f.showHidden
  );
}

/** A whole-unit bound as an exact fraction `digits / 10^scale`; null when blank or not a plain decimal amount. */
function parseBound(input: string): { digits: bigint; scale: number } | null {
  const s = input.trim();
  const dot = s.indexOf(".");
  const scale = dot === -1 ? 0 : s.length - dot - 1;
  const digits = parseHumanAmount(s, scale);
  return digits === null ? null : { digits: BigInt(digits), scale };
}

/** Whether `input` is blank or a valid whole-unit amount (an invalid one is ignored, and its input flagged). */
export function amountBoundValid(input: string): boolean {
  return input.trim() === "" || parseBound(input) !== null;
}

/** `raw / 10^decimals` compared with `b`, exactly: negative, 0 or positive. */
function compareToBound(raw: string, decimals: number, b: { digits: bigint; scale: number }): number {
  const left = BigInt(raw) * 10n ** BigInt(b.scale);
  const right = b.digits * 10n ** BigInt(decimals);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Newest first; within a second, by hash then sub id, both descending, so the order is the same however rows load. */
function newestFirst(a: TransferDto, b: TransferDto): number {
  const ta = Date.parse(a.ts);
  const tb = Date.parse(b.ts);
  if (ta !== tb) return tb - ta;
  const ha = a.tx_hash.toLowerCase();
  const hb = b.tx_hash.toLowerCase();
  if (ha !== hb) return ha < hb ? 1 : -1;
  return a.sub_id === b.sub_id ? 0 : a.sub_id < b.sub_id ? 1 : -1;
}

/**
 * The rows `f` lets through, newest first (a new array; `rows` is left as it is). `hidden`: the store's hidden
 * transfers by key; `names`: display names by lowercase address, matched like the address itself. Amount bounds apply
 * only to a chosen asset, compared exactly in its units; a row whose decimals are unknown fails any bound.
 */
export function filterRows(
  rows: TransferDto[],
  f: DataFilter,
  hidden: Record<string, HiddenTransfer>,
  names: ReadonlyMap<string, string>,
): TransferDto[] {
  const { timeFrom, timeTo } = transferParams({ from: f.from, to: f.to, asset: undefined, direction: "all", kind: "all" });
  const from = timeFrom ? Date.parse(timeFrom) : -Infinity;
  const to = timeTo ? Date.parse(timeTo) : Infinity;
  const needle = f.address.trim().toLowerCase();
  const min = f.asset === undefined ? null : parseBound(f.minAmount);
  const max = f.asset === undefined ? null : parseBound(f.maxAmount);
  const matches = (addr: string) => {
    const a = addr.toLowerCase();
    return a.includes(needle) || (names.get(a)?.toLowerCase().includes(needle) ?? false);
  };

  return rows
    .filter((r) => {
      const ts = Date.parse(r.ts);
      if (ts < from || ts > to) return false;
      if (f.asset !== undefined && (r.asset === null ? f.asset !== null : r.asset.toLowerCase() !== f.asset)) return false;
      if (f.kind !== "all" && r.kind !== f.kind) return false;
      if (needle !== "") {
        const hit = f.addressRole === "from" ? matches(r.from) : f.addressRole === "to" ? matches(r.to) : matches(r.from) || matches(r.to);
        if (!hit) return false;
      }
      if (min || max) {
        if (r.decimals === null) return false;
        if (min && compareToBound(r.amount, r.decimals, min) < 0) return false;
        if (max && compareToBound(r.amount, r.decimals, max) > 0) return false;
      }
      return f.showHidden || !(transferKey(r) in hidden);
    })
    .sort(newestFirst);
}
