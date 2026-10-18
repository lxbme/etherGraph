import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { api } from "../../api/endpoints";
import type { TokenDetailDto } from "../../api/generated/TokenDetailDto";
import * as identify from "../../graph/identify";
import { useInfo } from "./infoStore";
import { AssetDetail } from "./AssetDetail";

const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";

const dto = (o: Partial<TokenDetailDto> = {}): TokenDetailDto => ({
  address: USDT, standard: "erc20", name: "Tether USD", symbol: "USDT", decimals: 6, contract_name: "TetherToken",
  identified: true, source_verified: true, lists: { uniswap: true, coingecko: true }, tags: ["bridged-token"],
  website: "https://tether.to", ...o,
});

function renderDetail(props: { asset: string | null; tokenId?: string; tokenKind?: "erc20" | "erc721" | "erc1155" }, tab = "graph") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AssetDetail tab={tab} {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => useInfo.setState({ stacks: {} }));
afterEach(() => vi.restoreAllMocks());

test("ETH shows static rows and never asks the server", () => {
  const spy = vi.spyOn(api, "token");
  renderDetail({ asset: null });
  expect(screen.getByText("Ether")).toBeInTheDocument();
  expect(screen.getByText("ETH is the native currency; it has no contract.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Native currency" }));
  expect(useInfo.getState().stacks["graph"]).toEqual([{ kind: "doc", id: "native-eth" }]);
  expect(spy).not.toHaveBeenCalled();
});

test("a full token shows metadata, list membership, source state and readable tags", async () => {
  vi.spyOn(api, "token").mockResolvedValue(dto());
  renderDetail({ asset: USDT });
  expect(await screen.findByText("Tether USD")).toBeInTheDocument();
  expect(screen.getByText("Uniswap default list")).toBeInTheDocument();
  expect(screen.getByText("Listed on CoinGecko")).toBeInTheDocument();
  expect(screen.getByText("Source verified")).toBeInTheDocument();
  expect(screen.getByText("Bridged token")).toBeInTheDocument();
  expect(screen.getByText("TetherToken")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "https://tether.to" })).toHaveAttribute("rel", "noopener noreferrer");
  fireEvent.click(screen.getByRole("button", { name: "ERC-20" }));
  expect(useInfo.getState().stacks["graph"]).toEqual([{ kind: "doc", id: "erc-20" }]);
});

test("an unknown address says it is not identified and Identify queues a lookup", async () => {
  vi.spyOn(api, "token").mockResolvedValue(
    dto({ standard: "unknown", name: null, symbol: null, decimals: null, contract_name: null, identified: false, source_verified: null, lists: { uniswap: false, coingecko: false }, tags: [], website: null }),
  );
  const spy = vi.spyOn(identify, "identifyAddresses").mockResolvedValue();
  renderDetail({ asset: USDT });
  expect(await screen.findByText("Not identified")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "ERC-20" })).toBeNull();
  expect(screen.queryByText("Uniswap default list")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Identify" }));
  expect(spy).toHaveBeenCalledWith([USDT]);
});

test("while the token is loading it shows the loading placeholder and no rows", () => {
  vi.spyOn(api, "token").mockReturnValue(new Promise(() => {}));
  renderDetail({ asset: USDT });
  expect(screen.getByText("Loading…")).toBeInTheDocument();
  expect(screen.queryByTestId("asset-kv")).toBeNull();
});

test.each(["null", "", "ftp://x"])("a website of %j gives no Website row", async (website) => {
  vi.spyOn(api, "token").mockResolvedValue(dto({ website }));
  renderDetail({ asset: USDT });
  expect(await screen.findByText("Tether USD")).toBeInTheDocument();
  expect(screen.queryByText("Website")).toBeNull();
  expect(screen.queryByText("null")).toBeNull();
  expect(screen.queryByText("ftp://x")).toBeNull();
  expect(screen.getAllByRole("link").map((a) => a.textContent)).toEqual(["Etherscan"]);
});

test("an https website is a Website row with a safe link", async () => {
  vi.spyOn(api, "token").mockResolvedValue(dto({ website: "https://tether.to" }));
  renderDetail({ asset: USDT });
  expect(await screen.findByText("Website")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "https://tether.to" })).toHaveAttribute("rel", "noopener noreferrer");
});

test("an NFT shows the full token id and no decimals", async () => {
  vi.spyOn(api, "token").mockResolvedValue(dto({ standard: "erc721", decimals: null, source_verified: false }));
  renderDetail({ asset: USDT, tokenId: "123456789012345678901234567890" });
  expect(await screen.findByText("123456789012345678901234567890")).toBeInTheDocument();
  expect(screen.queryByText("Decimals")).toBeNull();
  expect(screen.getByText("Source not verified")).toBeInTheDocument();
});

test("a failed lookup shows the error", async () => {
  vi.spyOn(api, "token").mockRejectedValue(new Error("boom"));
  renderDetail({ asset: USDT });
  expect(await screen.findByRole("alert")).toBeInTheDocument();
});

test("the opening transfer's kind is sent to the server as a hint", async () => {
  const spy = vi.spyOn(api, "token").mockResolvedValue(dto({ standard: "erc721", decimals: null }));
  renderDetail({ asset: USDT, tokenId: "5", tokenKind: "erc721" });
  await screen.findByText("Tether USD");
  expect(spy).toHaveBeenCalledWith(USDT, "erc721");
});

test("risk tags are warnings, others stay neutral, and website-down hides the Website row", async () => {
  vi.spyOn(api, "token").mockResolvedValue(dto({ tags: ["scam", "stablecoin", "website-down"] }));
  renderDetail({ asset: USDT });
  expect(await screen.findByText("Scam")).toHaveClass("tag--warn");
  expect(screen.getByText("Website down")).toHaveClass("tag--warn");
  expect(screen.getByText("Stablecoin")).toHaveClass("tag--neutral");
  expect(screen.queryByText("Website")).toBeNull();
});
