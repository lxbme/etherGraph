import type { NodeSummaryDto } from "../api/generated/NodeSummaryDto";
import type { SyncStatusDto } from "../api/generated/SyncStatusDto";
import type { FlowDto } from "../api/generated/FlowDto";
import { useLocale } from "../i18n";
import { callTooltip, delegationTooltip, flowTooltip, edgeTooltip, moreTooltip, nodeTooltip } from "./tooltip";
import type { VisualEdge } from "./visualEdges";

const node = (o: Partial<NodeSummaryDto> = {}): NodeSummaryDto => ({
  address: "0x1111111111111111111111111111111111111111", kind: "eoa", display_name: null, ens: null,
  contract_name: null, labels: [], partial: false, syncing: false, synced: false, hot: false, identified: true, nonce: null, balance: null, ...o,
});
const text = (ls: { label?: string; value: string }[]) => ls.map((l) => `${l.label ?? ""} ${l.value}`).join("\n");

describe("nodeTooltip", () => {
  test("an unsynced EOA says so", () => {
    expect(text(nodeTooltip(node(), {}))).toContain("Not synced");
  });
  test("omitted neighbours show as hidden", () => {
    expect(text(nodeTooltip(node(), { degree: 5, omitted: 12 }))).toContain("5 (+12 hidden)");
  });
  test("no balance, no Balance line; with one it is fixed ETH", () => {
    expect(text(nodeTooltip(node(), {}))).not.toContain("Balance");
    const ls = nodeTooltip(node({ balance: "1500000000000000000", nonce: 1234 }), {});
    expect(text(ls)).toContain("Balance 1.500000 ETH");
    expect(text(ls)).toContain("Nonce 1,234");
    expect(ls.find((l) => l.label === "Balance")?.sub).toBeUndefined();
    expect(nodeTooltip(node({ balance: "1500000000000000001" }), {}).find((l) => l.label === "Balance")?.sub).toBe("1.500000000000000001 ETH");
    expect(nodeTooltip(node({ balance: "1000000000000000000" }), {}).find((l) => l.label === "Balance")?.sub).toBeUndefined();
  });
  test("synced shows the newest coverage time (UTC) with a local title; partial wins", () => {
    const cov = (t: string): SyncStatusDto => ({ kind: "native", from_block: 1, to_block: 2, truncated: false, state: "ok", last_synced_at: t });
    const ls = nodeTooltip(node({ synced: true, labels: [{ id: 1, text: "x", category: "cex", source: "user" }] }), {
      coverage: [cov("2026-01-01T00:00:00Z"), cov("2026-02-03T04:05:06Z")],
    });
    expect(text(ls)).toContain("Synced to 2026-02-03 04:05:06");
    expect(text(ls)).toContain("Category CEX");
    expect(ls.find((l) => l.value.startsWith("Synced"))?.sub).toMatch(/^local \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC([+-]\d+(:\d\d)?)?$/);
    expect(text(nodeTooltip(node({ synced: true }), {}))).toMatch(/Sync Synced$/);
    const two = nodeTooltip(node({ labels: [{ id: 1, text: "a", category: "cex", source: "user" }, { id: 2, text: "b", category: "defi", source: "user" }] }), {});
    expect(text(two)).toContain("Category CEX, DeFi");
    expect(text(nodeTooltip(node({ synced: true, partial: true }), {}))).toContain("Partial");
  });
  test("partial uses the one neutral name the legend and node details use", () => {
    expect(text(nodeTooltip(node({ partial: true }), {})).split("\n")).toContain("Sync Partial sync");
  });
  test("a State line names center, pinned and a user label when they apply", () => {
    expect(text(nodeTooltip(node(), {}))).not.toContain("State");
    const user = { id: 1, text: "mine", category: "other", source: "user" } as const;
    expect(text(nodeTooltip(node({ labels: [user] }), { center: true, pinned: true }))).toContain("State Center, Pinned, Your label");
    expect(text(nodeTooltip(node(), { pinned: true }))).toContain("State Pinned");
    // An imported label is not "your" label.
    expect(text(nodeTooltip(node({ labels: [{ ...user, source: "import" }] }), {}))).not.toContain("State");
  });
  test("coverage shows the block range, marked partial when a category was truncated", () => {
    const cov = (from: number | null, to: number | null, truncated = false): SyncStatusDto => ({
      kind: "native", from_block: from, to_block: to, truncated, state: "ok", last_synced_at: "2026-02-03T04:05:06Z",
    });
    const ls = nodeTooltip(node({ synced: true }), { coverage: [cov(18_000_000, 19_500_000), cov(17_250_000, 19_400_000), cov(null, null)] });
    const line = ls.find((l) => l.label === "Coverage");
    expect(line?.value).toBe("Blocks 17,250,000–19,500,000");
    expect(line?.sub).toBeUndefined();
    // The sync time stays on its own line.
    expect(text(ls)).toContain("Synced to 2026-02-03 04:05:06");
    const cut = nodeTooltip(node({ synced: true }), { coverage: [cov(18_000_000, 19_500_000, true)] });
    expect(cut.find((l) => l.label === "Coverage")?.sub).toBe("partial");
    expect(nodeTooltip(node(), { coverage: [cov(null, null)] }).find((l) => l.label === "Coverage")).toBeUndefined();
    expect(nodeTooltip(node(), {}).find((l) => l.label === "Coverage")).toBeUndefined();
  });
  describe("token and proxy tags", () => {
    const other = { id: 1, text: "Centre: USD Coin", category: "other", source: "import:eth-labels" } as const;
    const usdc = node({
      kind: "contract", labels: [other], is_proxy: true, token: { standard: "erc20", symbol: "USDC", decimals: 6 },
    });
    afterEach(() => useLocale.getState().setLocale("en"));
    test("sit next to the type and leave out the Other category", () => {
      const ls = nodeTooltip(usdc, {});
      expect(text(ls)).toContain("Type Contract · ERC-20 token · Proxy");
      expect(ls.find((l) => l.label === "Category")).toBeUndefined();
      useLocale.getState().setLocale("zh");
      expect(text(nodeTooltip(usdc, {}))).toContain("类型 合约 · ERC-20 代币 · 代理");
    });
    test("name each standard; a proxy alone is tagged too", () => {
      const tag = (o: Partial<NodeSummaryDto>) => nodeTooltip(node({ kind: "contract", ...o }), {}).find((l) => l.label === "Type")?.value;
      expect(tag({ token: { standard: "erc721", symbol: "PNK", decimals: null } })).toBe("Contract · ERC-721");
      expect(tag({ token: { standard: "erc1155", symbol: null, decimals: null } })).toBe("Contract · ERC-1155");
      expect(tag({ is_proxy: true, token: null })).toBe("Contract · Proxy");
      // Saved before the fields existed: no tags.
      expect(tag({})).toBe("Contract");
    });
    test("other categories still show; Other shows without a tag", () => {
      const cex = { ...other, id: 2, category: "cex" } as const;
      expect(text(nodeTooltip({ ...usdc, labels: [other, cex] }, {}))).toContain("Category CEX");
      expect(text(nodeTooltip({ ...usdc, labels: [other, cex] }, {}))).not.toContain("Other");
      expect(text(nodeTooltip(node({ kind: "contract", labels: [other] }), {}))).toContain("Category Other");
    });
  });
});

describe("edgeTooltip", () => {
  const edge = (asset: string | null, count: number, symbol: string | null) => ({
    from: "0xa", to: "0xb", asset, asset_kind: asset ? "erc20" : "native", count, sum: "1", first_ts: "", last_ts: "", decimals: 18, symbol,
    trust: { level: "listed", impersonates: null, reason: null },
  }) as const;
  test("one line per asset plus the width note", () => {
    const v: VisualEdge = {
      id: "c", from: "0xa", to: "0xb", color: "eth", count: 8, badge: "×2", expanded: false,
      assets: [edge(null, 5, "ETH"), edge("0xdddddddddddddddddddddddddddddddddddddddd", 3, "DAI")],
    };
    const ls = edgeTooltip(v);
    expect(ls.map((l) => l.value)).toContain("5 transfers");
    expect(ls.map((l) => l.value)).toContain("3 transfers");
    expect(ls.filter((l) => l.label === "ETH" || l.label === "DAI")).toHaveLength(2);
    expect(ls.at(-1)?.value).toBe("Line width = transfers (log)");
    expect(ls[0]?.value).toContain("→");
  });
  test("each flagged asset adds a Trust line naming its symbol", () => {
    const fake = { ...edge("0xffffffffffffffffffffffffffffffffffffffff", 2, "USDT"), trust: { level: "scam", impersonates: null, reason: "scam-label" } } as const;
    const v: VisualEdge = {
      id: "c", from: "0xa", to: "0xb", color: "eth", count: 7, badge: "×2", expanded: false, assets: [edge(null, 5, "ETH"), fake],
    };
    const trust = edgeTooltip(v).filter((l) => l.label === "Trust");
    expect(trust).toEqual([{ label: "Trust", value: "USDT: Known scam", sub: "Labelled as a scam" }]);
    expect(edgeTooltip({ ...v, assets: [edge(null, 5, "ETH")] }).some((l) => l.label === "Trust")).toBe(false);
  });
  test("the direction uses display names where known", () => {
    const v: VisualEdge = {
      id: "c", from: "0xaaaa", to: "0xbbbb", color: "eth", count: 1, badge: null, expanded: false, assets: [edge(null, 1, "ETH")],
    };
    const ls = edgeTooltip(v, new Map([["0xaaaa", "Binance 14"]]));
    expect(ls[0]?.value).toBe("Binance 14 → 0xbbbb");
  });
});

test("call and more tooltips", () => {
  expect(callTooltip()[0]?.value).toBe("Call: sender → recipient. ETH value, if any, is its own flow edge");
  expect(callTooltip()).toHaveLength(1);
  expect(text(callTooltip("transfer"))).toContain("Method transfer");
  expect(text(moreTooltip(7))).toContain("7 more neighbours not shown");
});

test("a call decoded with the delegate's ABI says so, naming the delegate", () => {
  const ls = callTooltip("execute", "0x612373d7003d694220f7800eeaf8e3924c0951d3");
  expect(text(ls)).toContain("Method execute");
  expect(ls.at(-1)).toEqual({ value: "Decoded with the delegate's ABI (0x6123…51d3)" });
  expect(text(callTooltip("execute", null))).not.toContain("delegate");
});

test("a token-contract node's tooltip explains why it has no flow edges", () => {
  const note = "Token contract of these transfers — it emitted the Transfer events but did not send or receive funds itself.";
  expect(nodeTooltip(node(), { assetContract: true }).at(-1)).toEqual({ value: note });
  expect(text(nodeTooltip(node(), {}))).not.toContain(note);
});

test("delegationTooltip: what it is and signer → delegate by name", () => {
  const names = new Map([["0xaaaa", "lxbme.eth"]]);
  const ls = delegationTooltip("0xAAAA", "0x612373d7003d694220f7800eeaf8e3924c0951d3", names);
  expect(ls[0]).toEqual({ value: "EIP-7702 delegation: the signer's account runs the delegate's code" });
  expect(text(ls)).toContain("Direction lxbme.eth → 0x6123…51d3");
});

test("flowTooltip: names, symbol, fixed amount, order, kind", () => {
  const f: FlowDto = {
    seq: 2, from: "0xaaaa", to: "0xbbbb", asset: "0xdac17f958d2ee523a2206206994597c13d831ec7", amount: "1234567", token_id: null,
    kind: "erc20", trace_path: null, log_index: 1, decimals: 6, symbol: "USDT", trust: { level: "listed", impersonates: null, reason: null },
  };
  const ls = flowTooltip(f, new Map([["0xaaaa", "Alice"]]));
  const s = text(ls);
  expect(s).toContain("Alice → 0xbbbb");
  expect(s).toContain("Asset USDT");
  expect(s).toContain("Amount 1.23 USDT");
  expect(ls.find((l) => l.label === "Amount")?.sub).toBe("1.234567 USDT");
  expect(s).toContain("Order ②");
  expect(s).toContain("Kind ERC-20");
});

test("flowTooltip: a flagged token adds a Trust line with the explanation; a listed one has none", () => {
  const f: FlowDto = {
    seq: 2, from: "0xaaaa", to: "0xbbbb", asset: "0xffffffffffffffffffffffffffffffffffffffff", amount: "1", token_id: null,
    kind: "erc20", trace_path: null, log_index: 1, decimals: 6, symbol: "USDT",
    trust: { level: "suspicious", impersonates: { address: "0xdac17f958d2ee523a2206206994597c13d831ec7", symbol: "USDT", name: "Tether USD" }, reason: null },
  };
  expect(flowTooltip(f, new Map()).find((l) => l.label === "Trust")).toEqual({
    label: "Trust",
    value: "Possible impersonation",
    sub: "Same name as Tether USD (0xdac1…1ec7) but not in any token list",
  });
  const scam = flowTooltip({ ...f, trust: { level: "scam", impersonates: null, reason: "spam-token" } }, new Map());
  expect(scam.find((l) => l.label === "Trust")).toMatchObject({ value: "Known scam", sub: "Flagged as spam by eth-labels" });
  expect(flowTooltip({ ...f, trust: { level: "listed", impersonates: null, reason: null } }, new Map()).some((l) => l.label === "Trust")).toBe(false);
});

test("flowTooltip: seq 0 is a circled zero", () => {
  const f: FlowDto = {
    seq: 0, from: "0xaaaa", to: "0xbbbb", asset: null, amount: "1", token_id: null,
    kind: "native", trace_path: null, log_index: null, decimals: 18, symbol: null, trust: { level: "listed", impersonates: null, reason: null },
  };
  expect(text(flowTooltip(f, new Map()))).toContain("Order ⓪");
});

test("flowTooltip keeps the full NFT token id", () => {
  const id = "90146019176740571409723734689185553745879426092891378571553900257744947220924";
  const f: FlowDto = {
    seq: 1, from: "0xaaaa", to: "0xbbbb", asset: "0xdac17f958d2ee523a2206206994597c13d831ec7", amount: "1", token_id: id,
    kind: "erc721", trace_path: null, log_index: 1, decimals: null, symbol: "ENS",
    trust: { level: "unknown", impersonates: null, reason: null },
  };
  expect(text(flowTooltip(f, new Map()))).toContain(id);
});

test("a cross-chain label's name carries the cross-chain note", () => {
  const ls = nodeTooltip(
    node({ display_name: "Foo", labels: [{ id: 1, text: "Foo", category: "dex", source: "import:eth-labels-xchain" }] }),
    {},
  );
  expect(ls.find((l) => l.label === "Name")?.sub).toBe("eth-labels · from another EVM chain");
  expect(text(ls)).toContain("Category DEX");
});

test("the cross-chain note is left off when an ENS name, not the label, names the node", () => {
  const ls = nodeTooltip(
    node({ display_name: "vitalik.eth", labels: [{ id: 1, text: "Foo", category: "dex", source: "import:eth-labels-xchain" }] }),
    {},
  );
  expect(ls.find((l) => l.label === "Name")?.sub).toBeUndefined();
});
