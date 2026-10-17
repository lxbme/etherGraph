import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../api/endpoints";
import { queryClient } from "../../api/queryClient";
import { setHistoryEffectHandler } from "../../graph/historyEffects";
import { useGraph } from "../../graph/store";
import { registerExpansionEffects } from "./expansion";

vi.mock("../../api/endpoints", () => ({ api: { cancelBatch: vi.fn(), sync: vi.fn() } }));
const m = vi.mocked(api);
const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);
const g = () => useGraph.getState();

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
  g().reset();
  m.cancelBatch.mockResolvedValue({ cancelled: [] });
  m.sync.mockResolvedValue(undefined as never);
  registerExpansionEffects();
  registerExpansionEffects(); // idempotent
});
afterEach(() => setHistoryEffectHandler(null));

describe("expansion effects", () => {
  test("undo cancels the batch once", () => {
    g().expand([A, B], "b1", 7);
    g().undo();
    expect(m.cancelBatch).toHaveBeenCalledTimes(1);
    expect(m.cancelBatch).toHaveBeenCalledWith("b1");
  });

  test("redo re-syncs only unsynced addresses under a new batch, and a later undo cancels that one", () => {
    queryClient.setQueryData(["graph", "x"], { nodes: [{ address: A, synced: true, syncing: false }] });
    g().expand([A, B], "b1", 7);
    g().undo();
    g().redo();
    expect(m.sync).toHaveBeenCalledTimes(1);
    const arg = m.sync.mock.calls[0]![0];
    expect(arg.addresses).toEqual([B]);
    expect(arg.depth).toBe("shallow");
    expect(arg.batch).not.toBe("b1");
    g().undo();
    expect(m.cancelBatch).toHaveBeenLastCalledWith(arg.batch);
  });

  test("redo of more than 50 unsynced addresses syncs them in chunks of 50 under one new batch", () => {
    const many = Array.from({ length: 120 }, (_, i) => "0x" + (i + 1).toString(16).padStart(40, "0"));
    g().expand(many, "b1", 3);
    g().undo();
    g().redo();
    const reqs = m.sync.mock.calls.map((c) => c[0]);
    expect(reqs.map((r) => r.addresses.length)).toEqual([50, 50, 20]);
    expect(reqs.flatMap((r) => r.addresses)).toEqual(many);
    expect(new Set(reqs.map((r) => r.batch)).size).toBe(1);
    expect(reqs[0]!.batch).not.toBe("b1");
  });

  test("redo with everything synced does not call the API", () => {
    queryClient.setQueryData(["graph", "x"], {
      nodes: [A, B].map((address) => ({ address, synced: true, syncing: false })),
    });
    g().expand([A, B], "b1", 7);
    g().undo();
    g().redo();
    expect(m.sync).not.toHaveBeenCalled();
  });
});
