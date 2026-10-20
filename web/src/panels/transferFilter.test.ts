import { useGraph } from "../graph/store";
import { isDefault, transferParams, useTransferFilter, type TransferTableFilter } from "./transferFilter";

const DEFAULT: TransferTableFilter = { from: null, to: null, asset: undefined, direction: "all", kind: "all" };
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

beforeEach(() => useTransferFilter.getState().reset());

test("default maps to no params", () => {
  expect(useTransferFilter.getState()).toMatchObject(DEFAULT);
  expect(isDefault(DEFAULT)).toBe(true);
  expect(transferParams(DEFAULT)).toEqual({});
  expect(Object.keys(transferParams(DEFAULT))).toEqual([]);
});

test("days become an inclusive UTC range", () => {
  const f = { ...DEFAULT, from: "2022-03-23", to: "2022-03-31" };
  expect(isDefault(f)).toBe(false);
  expect(transferParams(f)).toEqual({ timeFrom: "2022-03-23T00:00:00Z", timeTo: "2022-03-31T23:59:59Z" });
  // An open side sends nothing.
  expect(transferParams({ ...DEFAULT, from: "2022-03-23" })).toEqual({ timeFrom: "2022-03-23T00:00:00Z" });
  expect(transferParams({ ...DEFAULT, to: "2022-03-31" })).toEqual({ timeTo: "2022-03-31T23:59:59Z" });
});

test("an inverted range is swapped", () => {
  expect(transferParams({ ...DEFAULT, from: "2022-03-31", to: "2022-03-23" })).toEqual({
    timeFrom: "2022-03-23T00:00:00Z",
    timeTo: "2022-03-31T23:59:59Z",
  });
});

test("asset null means ETH and undefined means all", () => {
  expect(transferParams({ ...DEFAULT, asset: null })).toEqual({ asset: null });
  expect(transferParams({ ...DEFAULT, asset: USDC })).toEqual({ asset: USDC });
  expect("asset" in transferParams(DEFAULT)).toBe(false);
  expect(isDefault({ ...DEFAULT, asset: null })).toBe(false);
  // Direction "all" sends none; a kind is a one-element list.
  expect(transferParams({ ...DEFAULT, direction: "in", kind: "erc20" })).toEqual({ direction: "in", kinds: ["erc20"] });
});

test("a new epoch resets the filter", () => {
  useTransferFilter.getState().set({ from: "2022-03-23", asset: null, direction: "out", kind: "native" });
  // A selection change keeps it.
  useGraph.getState().select({ kind: "node", address: USDC });
  expect(useTransferFilter.getState()).toMatchObject({ from: "2022-03-23", asset: null, direction: "out", kind: "native" });
  useGraph.getState().reset();
  expect(useTransferFilter.getState()).toMatchObject(DEFAULT);
});
