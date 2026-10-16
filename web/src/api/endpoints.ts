import { request } from "./client";
import type { AddressProfileDto } from "./generated/AddressProfileDto";
import type { GraphRequestDto } from "./generated/GraphRequestDto";
import type { GraphResponseDto } from "./generated/GraphResponseDto";
import type { JobDto } from "./generated/JobDto";
import type { LabelDto } from "./generated/LabelDto";
import type { NewLabelDto } from "./generated/NewLabelDto";
import type { NewWorkspaceDto } from "./generated/NewWorkspaceDto";
import type { SearchResultDto } from "./generated/SearchResultDto";
import type { StatusDto } from "./generated/StatusDto";
import type { SyncRequestDto } from "./generated/SyncRequestDto";
import type { SyncResponseDto } from "./generated/SyncResponseDto";
import type { TransferPageDto } from "./generated/TransferPageDto";
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
  kinds?: string[];
  timeFrom?: string;
  timeTo?: string;
  cursor?: string;
  limit?: number;
}

export const api = {
  search: (q: string) => request<SearchResultDto>("GET", "/api/search", { query: { q } }),
  graphEdges: (req: GraphRequestDto) =>
    request<GraphResponseDto>("POST", "/api/graph/edges", { body: req }),
  transfers: (p: TransfersParams) =>
    request<TransferPageDto>("GET", "/api/transfers", {
      query: {
        address: p.address,
        from: p.from,
        to: p.to,
        asset: p.asset === null ? "eth" : p.asset,
        min_amount: p.minAmount,
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
};
