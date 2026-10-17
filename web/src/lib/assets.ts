/** Symbol shown for the native asset (null asset address). */
export const NATIVE_SYMBOL = "ETH";

export type AssetClass = "eth" | "stable" | "erc20" | "nft";

export const STABLECOINS: ReadonlySet<string> = new Set([
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
  "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
  "0x4fabb145d64652a948d72533023f6e7a623c7c53", // BUSD
  "0x0000000000085d4780b73119b644ae5ecd22b376", // TUSD
  "0x8e870d67f660d95d5be530380d0ec0bd388289e1", // USDP
  "0x853d955acef822db058eb8505911ed77f175b99e", // FRAX
  "0x6c3ea9036406852006290770bedfcaba0e23a0e8", // PYUSD
]);

export function assetClass(asset: string | null, kind?: string): AssetClass {
  if (kind === "native" || kind === "internal" || asset === null) return "eth";
  if (kind === "erc721" || kind === "erc1155") return "nft";
  if (STABLECOINS.has(asset.toLowerCase())) return "stable";
  return "erc20";
}

/** CSS variable references (defined in styles/tokens.css). */
export const ASSET_COLORS: Record<AssetClass, string> = {
  eth: "var(--asset-eth)",
  stable: "var(--asset-stable)",
  erc20: "var(--asset-erc20)",
  nft: "var(--asset-nft)",
};
