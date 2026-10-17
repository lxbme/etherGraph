import { t } from "../i18n";
import type { EdgeFilterDto } from "../api/generated/EdgeFilterDto";
import { withFirstBatch, type GraphState, type Pos, type SortKey } from "../graph/store";

export interface WorkspaceStateV1 {
  nodes: { address: string; x?: number; y?: number; pinned: boolean; hidden: boolean; note: string }[];
  centers: string[];
  expanded_pairs: [string, string][];
  filter: EdgeFilterDto;
  /** Absent in older states: means "count". */
  sort?: SortKey;
  /** Neighbour limit per center. Absent in older states; centers without one get a first batch on load. */
  limits?: Record<string, number>;
  viewport: { zoom: number; pan: { x: number; y: number } };
}

export const DEFAULT_VIEWPORT: WorkspaceStateV1["viewport"] = { zoom: 1, pan: { x: 0, y: 0 } };
export const SCHEMA_VERSION = 1;

export interface SerializeOpts {
  /** Addresses currently on the canvas (e.g. the live Cytoscape nodes); centers are always included. */
  nodes?: string[];
  /** Live layout positions (win over the store's dragged `ui.pos`). */
  positions?: Record<string, Pos>;
}

const lc = (s: string) => s.toLowerCase();

export function serialize(
  state: Pick<GraphState, "centers" | "filter" | "sort" | "expandedPairs" | "ui" | "limits">,
  viewport: WorkspaceStateV1["viewport"],
  opts: SerializeOpts = {},
): WorkspaceStateV1 {
  const flagged = Object.keys(state.ui)
    .filter((k) => {
      const u = state.ui[k]!;
      return u.pinned || u.hidden || u.note !== "";
    })
    .sort();
  const addrs = [...new Set([...state.centers, ...(opts.nodes ?? []), ...flagged].map(lc))];
  const positions: Record<string, Pos> = {};
  for (const [k, p] of Object.entries(opts.positions ?? {})) positions[lc(k)] = p;
  return {
    nodes: addrs.map((address) => {
      const u = state.ui[address];
      const pos = positions[address] ?? u?.pos;
      return {
        address,
        ...(pos ? { x: pos.x, y: pos.y } : {}),
        pinned: u?.pinned ?? false,
        hidden: u?.hidden ?? false,
        note: u?.note ?? "",
      };
    }),
    centers: [...state.centers],
    expanded_pairs: [...state.expandedPairs].map((k) => k.split("|") as [string, string]),
    filter: state.filter,
    sort: state.sort,
    limits: Object.fromEntries(
      state.centers.flatMap((c) => {
        const n = state.limits[c];
        return n === undefined ? [] : [[c, n]];
      }),
    ),
    viewport: { zoom: viewport.zoom, pan: { ...viewport.pan } },
  };
}

const SORTS: readonly string[] = ["count", "amount", "recent"];
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isLimit = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1;

export function deserialize(
  v: unknown,
  schemaVersion: number,
): { ok: true; state: WorkspaceStateV1 } | { ok: false; reason: string } {
  const bad = (reason: string) => ({ ok: false as const, reason });
  if (schemaVersion !== SCHEMA_VERSION) return bad(t("ws.err.version"));
  if (!isObj(v)) return bad(t("ws.err.data"));
  const { nodes, centers, expanded_pairs, filter, viewport } = v;
  if (!Array.isArray(nodes)) return bad(t("ws.err.field", { field: "nodes" }));
  for (const n of nodes) {
    if (!isObj(n) || !isStr(n.address)) return bad(t("ws.err.nodeAddress"));
    if (typeof n.pinned !== "boolean" || typeof n.hidden !== "boolean" || !isStr(n.note)) {
      return bad(t("ws.err.nodeProps"));
    }
    if ((n.x !== undefined && !isNum(n.x)) || (n.y !== undefined && !isNum(n.y))) return bad(t("ws.err.nodeCoords"));
  }
  if (!isStrArr(centers)) return bad(t("ws.err.field", { field: "centers" }));
  if (!Array.isArray(expanded_pairs) || !expanded_pairs.every((p) => isStrArr(p) && p.length === 2)) {
    return bad(t("ws.err.field", { field: "expanded_pairs" }));
  }
  if (!isObj(filter)) return bad(t("ws.err.field", { field: "filter" }));
  if (v.sort !== undefined && !(isStr(v.sort) && SORTS.includes(v.sort))) return bad(t("ws.err.field", { field: "sort" }));
  if (!isObj(viewport) || !isNum(viewport.zoom) || !isObj(viewport.pan) || !isNum(viewport.pan.x) || !isNum(viewport.pan.y)) {
    return bad(t("ws.err.field", { field: "viewport" }));
  }
  if (v.limits !== undefined && !(isObj(v.limits) && Object.values(v.limits).every(isLimit))) {
    return bad(t("ws.err.field", { field: "limits" }));
  }
  // Centers saved without a limit (older states) get the first batch of a new center.
  const stored: Record<string, number> = {};
  for (const [k, n] of Object.entries((v.limits ?? {}) as Record<string, number>)) stored[lc(k)] = n;
  // The batch is shared by all of them, over an empty canvas (ruling R12).
  const limits = withFirstBatch(stored, centers.map(lc), { fresh: true });
  return { ok: true, state: { ...(v as unknown as WorkspaceStateV1), limits } };
}
