import type { CallFrameDto } from "../../api/generated/CallFrameDto";
import ens from "../../../../crates/eg-blockscout/tests/data/ens_register.json";
import {
  buildCallGraph, callName, defaultCollapsed, edgeOfFrame, frameId, nextFrameOfEdge, treeRows, visibleFrames,
} from "./model";

type Raw = {
  action: { callType?: string; from: string; to?: string; gas: string; input: string; value?: string };
  result?: { gasUsed: string; output: string };
  error?: string;
  traceAddress: number[];
  type: string;
};

const KINDS: Record<string, CallFrameDto["kind"]> = {
  call: "call", staticcall: "staticcall", delegatecall: "delegatecall", callcode: "callcode",
  create: "create", create2: "create2", suicide: "selfdestruct",
};

function frameOf(r: Raw): CallFrameDto {
  const a = r.action;
  return {
    path: r.traceAddress,
    kind: KINDS[a.callType ?? r.type]!,
    from: a.from,
    to: a.to ?? null,
    value: BigInt(a.value ?? "0x0").toString(),
    input: a.input,
    output: r.result?.output ?? null,
    gas: Number(BigInt(a.gas)),
    gas_used: r.result ? Number(BigInt(r.result.gasUsed)) : null,
    error: r.error ?? null,
    call: null,
    revert: null,
    via_delegate: null,
  };
}

const ensFrames = (ens as Raw[]).map(frameOf);
const SENDER = "0x82eb45562f991329ed2867f43fc60f0ba52c3dab";
const ALL = { showStatic: true, failedOnly: false };
const DEFAULT = { showStatic: false, failedOnly: false };

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);
const X = "0x" + "cc".repeat(20);

const synth = (path: number[], over: Partial<CallFrameDto> = {}): CallFrameDto => ({
  path, kind: "call", from: A, to: B, value: "0", input: "0x", output: "0x", gas: 1, gas_used: 1,
  error: null, call: null, revert: null, via_delegate: null, ...over,
});

describe("call-tree model", () => {
  it("static_frames_and_their_subtrees_are_hidden_by_default", () => {
    expect(ensFrames).toHaveLength(17);
    const vis = visibleFrames(ensFrames, DEFAULT);
    expect(vis).toHaveLength(9);
    expect(vis.some((f) => f.kind === "staticcall")).toBe(false);
    expect(visibleFrames(ensFrames, ALL)).toHaveLength(17);
    const { nodes } = buildCallGraph(ensFrames, DEFAULT);
    const hidden = ["0x5f4ec3", "0x7d4e74", "0x754256"];
    for (const h of hidden) expect(nodes.some((n) => n.startsWith(h))).toBe(false);
    expect(nodes.some((n) => n.startsWith("0x5f4ec3"))).toBe(false);
    expect(buildCallGraph(ensFrames, ALL).nodes.some((n) => n.startsWith("0x5f4ec3"))).toBe(true);
  });

  it("failed_only_keeps_failed_frames_and_ancestors", () => {
    const frames = [
      synth([]), synth([0]), synth([0, 0], { error: "Reverted" }), synth([0, 1]), synth([1]),
    ];
    const vis = visibleFrames(frames, { showStatic: false, failedOnly: true });
    expect(vis.map((f) => frameId(f.path))).toEqual(["root", "0", "0.0"]);
    // seq stays the position among all frames.
    const rows = treeRows(frames, { showStatic: false, failedOnly: true }, new Set());
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows[2]!.failed).toBe(true);
    expect(rows[0]!.failed).toBe(false);
  });

  it("graph_merges_repeated_calls_and_keeps_execution_order", () => {
    const frames = [
      synth([], { from: A, to: B }),
      synth([0], { from: B, to: X, value: "5" }),
      synth([1], { from: B, to: A }),
      synth([2], { from: B, to: X, value: "7" }),
    ];
    const { edges } = buildCallGraph(frames, DEFAULT);
    const e = edges.find((x) => x.id === `${B}>${X}`)!;
    expect(e.frameIds).toEqual(["0", "2"]);
    expect(e.label).toBe("② ×2");
    expect(e.valueWei).toBe(12n);
    expect(edges).toHaveLength(3);
  });

  it("self_delegatecall_is_a_self_loop", () => {
    const { edges } = buildCallGraph(ensFrames, DEFAULT);
    const loop = edges.find((e) => e.frameIds.includes("4.0"))!;
    expect(loop.selfLoop).toBe(true);
    expect(loop.from).toBe(loop.to);
    expect(loop.kinds.has("delegatecall")).toBe(true);
    expect(edges.filter((e) => e.selfLoop)).toHaveLength(1);
  });

  it("callback_to_sender_makes_a_cycle_without_error", () => {
    const { edges, nodes } = buildCallGraph(ensFrames, DEFAULT);
    const controller = "0x253553366da8546fc250f225fe3d25d0c782303b";
    expect(edges.some((e) => e.from === SENDER && e.to === controller)).toBe(true);
    const back = edges.find((e) => e.to === SENDER && e.from.startsWith("0xd4416b"))!;
    expect(back.frameIds).toEqual(["3.1"]);
    // The ETH refund from the controller is its own edge to the sender.
    expect(edges.find((e) => e.id === `${controller}>${SENDER}`)!.frameIds).toEqual(["5"]);
    expect(new Set(nodes).size).toBe(nodes.length);
  });

  it("undecoded_frames_show_the_raw_selector", () => {
    const f = ensFrames.find((x) => x.path.join(".") === "3")!;
    expect(f.call).toBeNull();
    expect(callName(f)).toBe("0xa4014982");
    expect(callName(ensFrames.find((x) => x.path.join(".") === "5")!)).toBe("");
    expect(callName({ ...f, call: { signature: "register()", name: "register", args: [], via_delegate: null } })).toBe("register");
  });

  it("default_collapse_depth_3_on_2000_frames", () => {
    // Depth 8 chain at the front, then a wide tree: 2,000 frames in pre-order.
    const frames: CallFrameDto[] = [];
    const grow = (path: number[]) => {
      if (frames.length >= 2000) return;
      frames.push(synth(path));
      if (path.length < 8) for (let i = 0; i < 3 && frames.length < 2000; i++) grow([...path, i]);
    };
    grow([]);
    expect(frames).toHaveLength(2000);
    expect(Math.max(...frames.map((f) => f.path.length))).toBe(8);
    const collapsed = defaultCollapsed(frames, 3);
    treeRows(frames, DEFAULT, collapsed); // warm up
    const t0 = performance.now();
    const rows = treeRows(frames, DEFAULT, defaultCollapsed(frames, 3));
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(50);
    expect(Math.max(...rows.map((r) => r.depth))).toBe(3);
    expect(rows.filter((r) => r.depth === 3).every((r) => r.hasChildren)).toBe(true);
    expect(rows.length).toBeLessThan(frames.length);
    // Expanding one marker reveals its children.
    const marker = rows.find((r) => r.depth === 3 && r.hasChildren)!;
    const open = new Set(collapsed);
    open.delete(marker.id);
    expect(treeRows(frames, DEFAULT, open).length).toBeGreaterThan(rows.length);
  });

  it("default_collapse_rows_for_ens", () => {
    expect(treeRows(ensFrames, DEFAULT, defaultCollapsed(ensFrames, 3))).toHaveLength(9);
    const rows = treeRows(ensFrames, DEFAULT, new Set(["3"]));
    expect(rows.map((r) => r.id)).toEqual(["root", "3", "4", "4.0", "5"]);
    expect(rows[1]!.hasChildren).toBe(true);
  });

  it("next_frame_cycles_through_a_merged_edge", () => {
    const frames = [synth([]), synth([0], { from: B, to: X }), synth([1], { from: B, to: X })];
    const { edges } = buildCallGraph(frames, DEFAULT);
    const e = edges.find((x) => x.to === X)!;
    expect(nextFrameOfEdge(e, null)).toBe("0");
    expect(nextFrameOfEdge(e, "0")).toBe("1");
    expect(nextFrameOfEdge(e, "1")).toBe("0");
    expect(nextFrameOfEdge(e, "root")).toBe("0");
    expect(edgeOfFrame(edges, "1")).toBe(e.id);
    expect(edgeOfFrame(edges, "nope")).toBeNull();
  });
});
