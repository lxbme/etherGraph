import { request } from "./client";
import type { AddressProfileDto } from "./generated/AddressProfileDto";
import type { CancelledDto } from "./generated/CancelledDto";
import type { CounterpartyPageDto } from "./generated/CounterpartyPageDto";
import type { GraphRequestDto } from "./generated/GraphRequestDto";
import type { GraphResponseDto } from "./generated/GraphResponseDto";
import type { JobDto } from "./generated/JobDto";
import type { LabelDto } from "./generated/LabelDto";
import type { NewLabelDto } from "./generated/NewLabelDto";
import type { NewWorkspaceDto } from "./generated/NewWorkspaceDto";
import type { ProbeRequestDto } from "./generated/ProbeRequestDto";
import type { ProbeResponseDto } from "./generated/ProbeResponseDto";
import type { SearchResultDto } from "./generated/SearchResultDto";
import type { StatusDto } from "./generated/StatusDto";
import type { SyncRequestDto } from "./generated/SyncRequestDto";
import type { SyncResponseDto } from "./generated/SyncResponseDto";
import type { TransferPageDto } from "./generated/TransferPageDto";
import type { TxRawDto } from "./generated/TxRawDto";
import type { TxResponseDto } from "./generated/TxResponseDto";
import type { UpdateWorkspaceDto } from "./generated/UpdateWorkspaceDto";
import type { WorkspaceDto } from "./generated/WorkspaceDto";
import type { WorkspaceMetaDto } from "./generated/WorkspaceMetaDto";

export interface TransfersParams {
  address?: string;
  from?: string;
  to?: string;
  asset?: string | null;
  minAmount?: string;
  /** Only with `address`: "in" / "out" relative to it ("both" or absent: either side). */
  direction?: "in" | "out" | "both";
  kinds?: string[];
  timeFrom?: string;
  timeTo?: string;
  cursor?: string;
  limit?: number;
}

export interface CounterpartiesParams {
  /** Server default: count_desc. */
  sort?: "count_asc" | "count_desc" | "recent";
  /** 1 to 1000; server default 200. */
  limit?: number;
  offset?: number;
  /** "eoa" includes unknown kinds; server default all. */
  kind?: "eoa" | "contract" | "all";
  /** RFC 3339 time range bounds. */
  from?: string;
  to?: string;
}

const num = (n: number | undefined) => (n === undefined ? undefined : String(n));

export const api = {
  search: (q: string) => request<SearchResultDto>("GET", "/api/search", { query: { q } }),
  graphEdges: (req: GraphRequestDto, opts?: { signal?: AbortSignal }) =>
    request<GraphResponseDto>("POST", "/api/graph/edges", { body: req, signal: opts?.signal }),
  transfers: (p: TransfersParams) =>
    request<TransferPageDto>("GET", "/api/transfers", {
      query: {
        address: p.address,
        from: p.from,
        to: p.to,
        asset: p.asset === null ? "eth" : p.asset,
        min_amount: p.minAmount,
        direction: p.direction,
        kinds: p.kinds && p.kinds.length > 0 ? p.kinds.join(",") : undefined,
        time_from: p.timeFrom,
        time_to: p.timeTo,
        cursor: p.cursor,
        limit: p.limit === undefined ? undefined : String(p.limit),
      },
    }),
  address: (addr: string, opts?: { sync?: "auto" | "none" }) =>
    request<AddressProfileDto>("GET", `/api/address/${encodeURIComponent(addr)}`, {
      query: { sync: opts?.sync },
    }),
  job: (id: number) => request<JobDto>("GET", `/api/jobs/${id}`),
  recentJobs: () => request<JobDto[]>("GET", "/api/jobs", { query: { active: "false" } }),
  sync: (req: SyncRequestDto) => request<SyncResponseDto>("POST", "/api/sync", { body: req }),
  tx: (hash: string) => request<TxResponseDto>("GET", `/api/tx/${encodeURIComponent(hash)}`),
  txRaw: (hash: string) => request<TxRawDto>("GET", `/api/tx/${encodeURIComponent(hash)}/raw`),
  labels: (addr: string) => request<LabelDto[]>("GET", "/api/labels", { query: { addr } }),
  addLabel: (l: NewLabelDto) => request<LabelDto>("POST", "/api/labels", { body: l }),
  deleteLabel: (id: number) => request<void>("DELETE", `/api/labels/${id}`),
  workspaces: () => request<WorkspaceMetaDto[]>("GET", "/api/workspaces"),
  workspace: (id: number) => request<WorkspaceDto>("GET", `/api/workspaces/${id}`),
  createWorkspace: (w: NewWorkspaceDto) =>
    request<WorkspaceDto>("POST", "/api/workspaces", { body: w }),
  updateWorkspace: (id: number, w: UpdateWorkspaceDto) =>
    request<WorkspaceDto>("PUT", `/api/workspaces/${id}`, { body: w }),
  deleteWorkspace: (id: number) => request<void>("DELETE", `/api/workspaces/${id}`),
  jobs: () => request<JobDto[]>("GET", "/api/jobs", { query: { active: "true" } }),
  cancelJob: (id: number) => request<void>("DELETE", `/api/jobs/${id}`),
  status: () => request<StatusDto>("GET", "/api/status"),
  probe: (req: ProbeRequestDto) => request<ProbeResponseDto>("POST", "/api/probe", { body: req }),
  counterparties: (addr: string, p: CounterpartiesParams = {}) =>
    request<CounterpartyPageDto>("GET", `/api/address/${encodeURIComponent(addr)}/counterparties`, {
      query: { sort: p.sort, limit: num(p.limit), offset: num(p.offset), kind: p.kind, from: p.from, to: p.to },
    }),
  /** Releases a batch's jobs; only jobs left without any other owner are cancelled. */
  cancelBatch: (id: string) => request<CancelledDto>("DELETE", `/api/batches/${encodeURIComponent(id)}`),
  /** Cancels every active job that is not interactive. */
  cancelBackground: () => request<CancelledDto>("DELETE", "/api/jobs", { query: { scope: "background" } }),
};
