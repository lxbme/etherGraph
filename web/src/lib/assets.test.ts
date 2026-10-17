import { expect, test } from "vitest";
import { ASSET_COLORS, STABLECOINS, assetClass } from "./assets";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

test("assetClass classifies eth, stablecoins case-insensitively, nft, erc20", () => {
  expect(assetClass(null)).toBe("eth");
  expect(assetClass(null, "erc20")).toBe("eth");
  expect(assetClass(USDC, "native")).toBe("eth");
  expect(assetClass(USDC, "internal")).toBe("eth");
  expect(assetClass(USDC)).toBe("stable");
  expect(assetClass(USDC.toUpperCase().replace("0X", "0x"), "erc20")).toBe("stable");
  expect(assetClass(USDC, "erc721")).toBe("nft");
  expect(assetClass("0x1234", "erc1155")).toBe("nft");
  expect(assetClass("0x1234", "erc20")).toBe("erc20");
  expect(assetClass("0x1234")).toBe("erc20");
});

test("stablecoin list and colors", () => {
  expect(STABLECOINS.size).toBe(8);
  expect(ASSET_COLORS.eth).toBe("var(--asset-eth)");
  expect(ASSET_COLORS.nft).toBe("var(--asset-nft)");
});
