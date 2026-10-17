import { describe, expect, it } from "vitest";
import {
  callBudget,
  defaultSelection,
  heavySet,
  nodeBudget,
  nodeCapacity,
  perCenterBatch,
  usage,
  weight,
  type Candidate,
} from "./budget";

const cand = (i: number, o: Partial<Candidate> = {}): Candidate => ({
  address: `0x${String(i).padStart(40, "0")}`,
  kind: "eoa",
  hot: false,
  onCanvas: false,
  calls: 7,
  weight: { value: i, estimated: false },
  ...o,
});

describe("budget", () => {
  it("nodeCapacity / nodeBudget", () => {
    expect(nodeCapacity({ width: 960, height: 576 })).toBe(60);
    expect(nodeBudget(60, 70)).toBe(0);
    expect(nodeBudget(60, 10)).toBe(50);
  });
  it("callBudget", () => {
    expect(callBudget({ rate: 2.5, queuedCalls: 100, quotaRemaining: 1000 })).toBe(125);
    expect(callBudget({ rate: 2.5, queuedCalls: 100, quotaRemaining: 50 })).toBe(50);
    expect(callBudget({ rate: 2.5, queuedCalls: 300, quotaRemaining: 1000 })).toBe(0);
    expect(callBudget({ rate: 2.5, queuedCalls: 100, quotaRemaining: null })).toBe(125);
  });
  it("weight", () => {
    expect(weight({ nonce: 9, localTransfers: 99 })).toEqual({ value: 1, estimated: false });
    expect(weight({ nonce: null, localTransfers: 99 })).toEqual({ value: 2, estimated: true });
  });
  it("heavySet", () => {
    const m = new Map([1, 2, 3, 4, 5, 6, 7, 5000].map((n) => [`a${n}`, n]));
    expect([...heavySet(m)]).toEqual(["a5000"]);
    expect(heavySet(new Map([["a", 1], ["b", 2], ["c", 3000]])).size).toBe(0);
  });
  it("defaultSelection greedy by weight", () => {
    const cs = Array.from({ length: 10 }, (_, i) => cand(10 - i));
    const r = defaultSelection(cs, { nodes: 30, calls: 1000 });
    expect(r.overBudget).toBe(false);
    expect(r.selected).toEqual([1, 2, 3, 4, 5].map((i) => cand(i).address));
  });
  it("never selects contracts or hot", () => {
    const cs = [cand(1, { kind: "contract" }), cand(2, { hot: true }), cand(3)];
    expect(defaultSelection(cs, { nodes: 100, calls: 100 }).selected).toEqual([cand(3).address]);
  });
  it("selects lightest when nothing fits", () => {
    const r = defaultSelection([cand(2), cand(1)], { nodes: 0, calls: 0 });
    expect(r).toEqual({ selected: [cand(1).address], overBudget: true });
  });
  it("all contracts", () => {
    expect(defaultSelection([cand(1, { kind: "contract" })], { nodes: 0, calls: 0 })).toEqual({ selected: [], overBudget: false });
  });
  it("perCenterBatch", () => {
    expect(perCenterBatch(60, 4, 4)).toBe(14);
    expect(perCenterBatch(5, 4, 4)).toBe(3);
    expect(perCenterBatch(60, 0, 0)).toBe(60);
  });
  it("usage", () => {
    const u = usage([cand(1), cand(2, { onCanvas: true })], { nodes: 10, calls: 13 });
    expect(u).toEqual({ nodes: 11, calls: 14, overNodes: true, overCalls: true });
  });
  it("non-finite inputs count as 0", () => {
    expect(callBudget({ rate: NaN, queuedCalls: 0, quotaRemaining: 100 })).toBe(0);
    expect(callBudget({ rate: 2.5, queuedCalls: 0, quotaRemaining: NaN })).toBe(0);
    expect(nodeCapacity({ width: NaN, height: 500 })).toBe(0);
    expect(nodeBudget(NaN, 3)).toBe(0);
    expect(perCenterBatch(NaN, 2, 0)).toBe(3);
    expect(defaultSelection([cand(1)], { nodes: NaN, calls: NaN }).overBudget).toBe(true);
  });
  it("negative nonce weighs 0", () => {
    expect(weight({ nonce: -5, localTransfers: 0 })).toEqual({ value: 0, estimated: false });
    expect(weight({ nonce: null, localTransfers: -5 })).toEqual({ value: 0, estimated: true });
  });
  it("empty candidates", () => {
    expect(defaultSelection([], { nodes: 10, calls: 10 })).toEqual({ selected: [], overBudget: false });
  });
  it("onCanvas candidate costs K_MIN only", () => {
    const r = defaultSelection([cand(1, { onCanvas: true }), cand(2, { onCanvas: true })], { nodes: 5, calls: 100 });
    expect(r).toEqual({ selected: [cand(1).address], overBudget: false });
  });
});
