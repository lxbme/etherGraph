import { create } from "zustand";
import type { EdgeDto } from "../api/generated/EdgeDto";

export const ETH_KEY = "eth";
/** Lowercase address, or "eth" for the native asset. */
export const assetKey = (a: string | null | undefined) =>
  a == null || a.toLowerCase() === ETH_KEY ? ETH_KEY : a.toLowerCase();

export interface KnownAsset {
  symbol: string | null;
  decimals: number | null;
  kind: EdgeDto["asset_kind"];
}

interface AssetRegistry {
  assets: Record<string, KnownAsset>;
  merge(edges: EdgeDto[]): void;
  clear(): void;
}

/** Every asset seen in any graph response this session, so the filter list does not shrink once filtered. */
export const useAssetRegistry = create<AssetRegistry>()((set) => ({
  assets: {},
  merge: (edges) =>
    set((s) => {
      let next: Record<string, KnownAsset> | null = null;
      for (const e of edges) {
        const key = assetKey(e.asset);
        const known: KnownAsset = { symbol: e.symbol, decimals: key === ETH_KEY ? 18 : e.decimals, kind: e.asset_kind };
        const cur = (next ?? s.assets)[key];
        if (cur && cur.symbol === known.symbol && cur.decimals === known.decimals && cur.kind === known.kind) continue;
        next ??= { ...s.assets };
        next[key] = known;
      }
      return next ? { assets: next } : s;
    }),
  clear: () => set({ assets: {} }),
}));
