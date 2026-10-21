// Pure model of the transaction call tree: filtered rows for the tree view and the aggregated call graph.
import type { CallFrameDto } from "../../api/generated/CallFrameDto";
import { circled } from "../txElements";

export interface TreeRow {
  /** `path.join(".")`, or "root" for the top-level call. */
  id: string;
  /** The root is depth 0. */
  depth: number;
  frame: CallFrameDto;
  /** Execution order among all frames (1-based), stable under filters. */
  seq: number;
  /** Whether a frame shown under the filter is nested below it. */
  hasChildren: boolean;
  failed: boolean;
}

export interface TreeFilter {
  showStatic: boolean;
  failedOnly: boolean;
}

export interface CallEdge {
  /** `${from}>${to}`, lower-case. */
  id: string;
  from: string;
  to: string;
  /** Frame ids in execution order. */
  frameIds: string[];
  kinds: Set<CallFrameDto["kind"]>;
  /** "①register" or "①register ×3". */
  label: string;
  /** The first call's name was guessed from the signature database (see `guessedName`). */
  guessed: boolean;
  /** ETH sent by its frames (see `sendsEth`). */
  valueWei: bigint;
  failed: boolean;
  selfLoop: boolean;
}

export function frameId(path: number[]): string {
  return path.length === 0 ? "root" : path.join(".");
}

const isFailed = (f: CallFrameDto) => f.error !== null;

/**
 * Whether the frame's value is ETH it sends. A DELEGATECALL repeats the value of the call it runs in (traces carry
 * it, e.g. a payable proxy's call into its implementation) and a CALLCODE pays its value to the caller itself: no
 * ETH moves in either.
 */
export const sendsEth = (f: CallFrameDto) => f.kind !== "delegatecall" && f.kind !== "callcode";

/**
 * The account a frame acts as, whose token its arguments count: the callee, but a DELEGATECALL or CALLCODE runs the
 * callee's code as its caller (a token proxy's `transfer` in its implementation moves the proxy's token).
 */
export const contextOf = (f: CallFrameDto): string | null =>
  f.kind === "delegatecall" || f.kind === "callcode" ? f.from : f.to;

/** Frames are in pre-order, so a subtree is a contiguous run of deeper paths. */
function withoutStaticSubtrees(frames: CallFrameDto[]): CallFrameDto[] {
  const out: CallFrameDto[] = [];
  let cut = -1; // length of the hidden subtree's root path, -1 when none
  for (const f of frames) {
    if (cut >= 0 && f.path.length > cut) continue;
    cut = -1;
    if (f.kind === "staticcall") {
      cut = f.path.length;
      continue;
    }
    out.push(f);
  }
  return out;
}

/**
 * Static subtrees go unless `showStatic`; `failedOnly` keeps just the failed frames and their ancestors, static
 * ones included (a failure under a read-only call is still on a failed path).
 */
export function visibleFrames(frames: CallFrameDto[], f: TreeFilter): CallFrameDto[] {
  if (!f.failedOnly) return f.showStatic ? frames : withoutStaticSubtrees(frames);
  const keep = new Set<string>();
  for (const fr of frames) {
    if (!isFailed(fr)) continue;
    for (let n = 0; n <= fr.path.length; n++) keep.add(frameId(fr.path.slice(0, n)));
  }
  return frames.filter((fr) => keep.has(frameId(fr.path)));
}

export function treeRows(frames: CallFrameDto[], f: TreeFilter, collapsed: ReadonlySet<string>): TreeRow[] {
  const seqOf = new Map<CallFrameDto, number>();
  frames.forEach((fr, i) => seqOf.set(fr, i + 1));
  const vis = visibleFrames(frames, f);
  const rows: TreeRow[] = [];
  let hidden = -1; // length of a collapsed row's path while skipping its descendants
  for (let i = 0; i < vis.length; i++) {
    const fr = vis[i]!;
    if (hidden >= 0 && fr.path.length > hidden) continue;
    hidden = -1;
    const id = frameId(fr.path);
    const next = vis[i + 1];
    const hasChildren = next !== undefined && next.path.length > fr.path.length;
    rows.push({ id, depth: fr.path.length, frame: fr, seq: seqOf.get(fr)!, hasChildren, failed: isFailed(fr) });
    if (hasChildren && collapsed.has(id)) hidden = fr.path.length;
  }
  return rows;
}

/** Ids of the frames at `depth` that have children, so rows of depth 0..`depth` show. */
export function defaultCollapsed(frames: CallFrameDto[], depth: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < frames.length - 1; i++) {
    const fr = frames[i]!;
    if (fr.path.length === depth && frames[i + 1]!.path.length > depth) out.add(frameId(fr.path));
  }
  return out;
}

/** The decoded name, else the raw 4-byte selector; "" for plain value transfers and creations. */
export function callName(frame: CallFrameDto): string {
  if (frame.call) return frame.call.name;
  if (frame.kind === "create" || frame.kind === "create2" || frame.kind === "selfdestruct") return "";
  return frame.input.length >= 10 ? frame.input.slice(0, 10).toLowerCase() : "";
}

export function buildCallGraph(frames: CallFrameDto[], f: TreeFilter): { nodes: string[]; edges: CallEdge[] } {
  const seqOf = new Map<CallFrameDto, number>();
  frames.forEach((fr, i) => seqOf.set(fr, i + 1));
  const nodes = new Set<string>();
  const edges = new Map<string, CallEdge>();
  for (const fr of visibleFrames(frames, f)) {
    const from = fr.from.toLowerCase();
    nodes.add(from);
    if (fr.to === null) continue; // a failed creation has no callee
    const to = fr.to.toLowerCase();
    nodes.add(to);
    const id = `${from}>${to}`;
    let e = edges.get(id);
    if (!e) {
      e = {
        id, from, to, frameIds: [], kinds: new Set(), label: `${circled(seqOf.get(fr)!)}${callName(fr)}`,
        guessed: fr.call?.guessed === true, valueWei: 0n, failed: false, selfLoop: from === to,
      };
      edges.set(id, e);
    }
    e.frameIds.push(frameId(fr.path));
    e.kinds.add(fr.kind);
    if (sendsEth(fr)) e.valueWei += BigInt(fr.value);
    if (isFailed(fr)) e.failed = true;
  }
  for (const e of edges.values()) if (e.frameIds.length > 1) e.label += ` ×${e.frameIds.length}`;
  return { nodes: [...nodes], edges: [...edges.values()] };
}

/** The frame after `current` on the edge, wrapping around; the first one when `current` is not on it. */
export function nextFrameOfEdge(edge: CallEdge, current: string | null): string {
  const i = current === null ? -1 : edge.frameIds.indexOf(current);
  return edge.frameIds[(i + 1) % edge.frameIds.length]!;
}

export function edgeOfFrame(edges: CallEdge[], frameId: string): string | null {
  return edges.find((e) => e.frameIds.includes(frameId))?.id ?? null;
}
