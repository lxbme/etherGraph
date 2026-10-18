import type { EdgeDto } from "../api/generated/EdgeDto";
import { useAssetRegistry } from "./assetRegistry";

const FAKE = "0x" + "fa".repeat(20);
const edge = (o: Partial<EdgeDto> = {}): EdgeDto => ({
  from: "0x" + "aa".repeat(20), to: "0x" + "bb".repeat(20), asset: FAKE, asset_kind: "erc20", count: 1, sum: "1",
  first_ts: "2024-01-01T00:00:00Z", last_ts: "2024-01-01T00:00:00Z", decimals: 6, symbol: "USDT",
  trust: { level: "unknown", impersonates: null, reason: null }, ...o,
});

beforeEach(() => useAssetRegistry.getState().clear());

test("the registry keeps each asset's trust and follows a change of it", () => {
  const r = useAssetRegistry.getState();
  r.merge([edge()]);
  expect(useAssetRegistry.getState().assets[FAKE]?.trust.level).toBe("unknown");
  const before = useAssetRegistry.getState().assets;
  r.merge([edge()]);
  expect(useAssetRegistry.getState().assets).toBe(before);
  const scam = { level: "scam", impersonates: null, reason: "spam-token" } as const;
  r.merge([edge({ trust: scam })]);
  expect(useAssetRegistry.getState().assets[FAKE]).toEqual({ symbol: "USDT", decimals: 6, kind: "erc20", trust: scam });
});
