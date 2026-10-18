import { useUi } from "../uiStore";
import { useInfo } from "./infoStore";

const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const H = "0x" + "ab".repeat(32);

beforeEach(() => {
  useInfo.setState({ stacks: {} });
  useUi.setState({ detailOpen: false });
});

test("open pushes onto the tab's own stack and opens a collapsed panel", () => {
  useInfo.getState().open("graph", { kind: "asset", asset: null });
  useInfo.getState().open(H, { kind: "asset", asset: USDT });
  expect(useInfo.getState().stacks["graph"]).toEqual([{ kind: "asset", asset: null }]);
  expect(useInfo.getState().stacks[H]).toEqual([{ kind: "asset", asset: USDT }]);
  expect(useUi.getState().detailOpen).toBe(true);
});

test("back pops one view, close clears the whole stack, other tabs are untouched", () => {
  const s = useInfo.getState();
  s.open("graph", { kind: "asset", asset: USDT });
  s.open("graph", { kind: "doc", id: "erc-20" });
  s.open(H, { kind: "asset", asset: null });
  useInfo.getState().back("graph");
  expect(useInfo.getState().stacks["graph"]).toEqual([{ kind: "asset", asset: USDT }]);
  useInfo.getState().open("graph", { kind: "doc", id: "erc-20" });
  useInfo.getState().close("graph");
  expect(useInfo.getState().stacks["graph"] ?? []).toEqual([]);
  expect(useInfo.getState().stacks[H]).toHaveLength(1);
});

test("reopening the view on top does not stack a duplicate", () => {
  useInfo.getState().open("graph", { kind: "asset", asset: USDT });
  useInfo.getState().open("graph", { kind: "asset", asset: USDT });
  expect(useInfo.getState().stacks["graph"]).toHaveLength(1);
});

test("forget drops a closed tab's stack", () => {
  useInfo.getState().open(H, { kind: "asset", asset: null });
  useInfo.getState().forget(H);
  expect(H in useInfo.getState().stacks).toBe(false);
});
