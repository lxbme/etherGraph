import { request } from "./client";
import type { CallTraceResponseDto } from "./generated/CallTraceResponseDto";
import type { AddressProfileDto } from "./generated/AddressProfileDto";
import type { AdminAction } from "./generated/AdminAction";
import type { AdminActionNonceDto } from "./generated/AdminActionNonceDto";
import type { AdminActionRequestDto } from "./generated/AdminActionRequestDto";
import type { AdminActionResultDto } from "./generated/AdminActionResultDto";
import type { AdminOverviewDto } from "./generated/AdminOverviewDto";
import type { AdminSessionDto } from "./generated/AdminSessionDto";
import type { AdminUserDto } from "./generated/AdminUserDto";
import type { AuditPageDto } from "./generated/AuditPageDto";
import type { CancelledDto } from "./generated/CancelledDto";
import type { CounterpartyPageDto } from "./generated/CounterpartyPageDto";
import type { GraphRequestDto } from "./generated/GraphRequestDto";
import type { GraphResponseDto } from "./generated/GraphResponseDto";
import type { IdentifyRequestDto } from "./generated/IdentifyRequestDto";
import type { IdentifyResponseDto } from "./generated/IdentifyResponseDto";
import type { JobDto } from "./generated/JobDto";
import type { LabelDto } from "./generated/LabelDto";
import type { LoginDto } from "./generated/LoginDto";
import type { MeDto } from "./generated/MeDto";
import type { NewLabelDto } from "./generated/NewLabelDto";
import type { NewWorkspaceDto } from "./generated/NewWorkspaceDto";
import type { NodeSummaryDto } from "./generated/NodeSummaryDto";
import type { NodesRequestDto } from "./generated/NodesRequestDto";
import type { ProbeRequestDto } from "./generated/ProbeRequestDto";
import type { ProbeResponseDto } from "./generated/ProbeResponseDto";
import type { SearchResultDto } from "./generated/SearchResultDto";
import type { SiweFieldsDto } from "./generated/SiweFieldsDto";
import type { StatusDto } from "./generated/StatusDto";
import type { SyncRequestDto } from "./generated/SyncRequestDto";
import type { SyncResponseDto } from "./generated/SyncResponseDto";
import type { TokenDetailDto } from "./generated/TokenDetailDto";
import type { TransferPageDto } from "./generated/TransferPageDto";
import type { TxRawDto } from "./generated/TxRawDto";
import type { TxResponseDto } from "./generated/TxResponseDto";
import type { UpdateWorkspaceDto } from "./generated/UpdateWorkspaceDto";
import type { WorkspaceDto } from "./generated/WorkspaceDto";
import type { WhitelistEntryDto } from "./generated/WhitelistEntryDto";
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

/** `GET /api/admin/audit` filters; times are RFC 3339. */
export interface AuditParams {
  actor?: string;
  action?: string;
  from?: string;
  to?: string;
  /** `next_cursor` of the previous page. */
  cursor?: number;
}

const num = (n: number | undefined) => (n === undefined ? undefined : String(n));

export const api = {
  /** The fields of a login message for `address` (D1: the client builds the text from exactly these). */
  authNonce: (address: string) => request<SiweFieldsDto>("GET", "/api/auth/nonce", { query: { address } }),
  /** A 401 here is a refused attempt (its reason is the message). */
  login: (body: LoginDto) => request<MeDto>("POST", "/api/auth/login", { body }),
  logout: () => request<void>("POST", "/api/auth/logout"),
  /** The signed-in user; 401 without a session. */
  me: () => request<MeDto>("GET", "/api/auth/me"),
  /** Admin mode of this login session; 401 `no_admin_session` when it is off. */
  adminSession: () => request<AdminSessionDto>("GET", "/api/admin/session"),
  /** The fields of the admin-mode message (built like the login message). */
  adminSessionNonce: () => request<SiweFieldsDto>("GET", "/api/admin/session/nonce"),
  /** A 401 here is a refused attempt (its reason is the message). */
  adminEnter: (body: LoginDto) => request<AdminSessionDto>("POST", "/api/admin/session", { body }),
  adminExit: () => request<void>("DELETE", "/api/admin/session"),
  /** The server's message describing `action`, to be signed with its nonce. */
  adminActionNonce: (action: AdminAction) => request<AdminActionNonceDto>("POST", "/api/admin/actions/nonce", { body: { action } }),
  adminAction: (body: AdminActionRequestDto) => request<AdminActionResultDto>("POST", "/api/admin/actions", { body }),
  adminOverview: () => request<AdminOverviewDto>("GET", "/api/admin/overview"),
  adminUsers: () => request<AdminUserDto[]>("GET", "/api/admin/users"),
  adminWhitelist: () => request<WhitelistEntryDto[]>("GET", "/api/admin/whitelist"),
  adminAudit: (p: AuditParams) =>
    request<AuditPageDto>("GET", "/api/admin/audit", {
      query: { actor: p.actor, action: p.action, from: p.from, to: p.to, cursor: num(p.cursor) },
    }),
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
  token: (addr: string, kind?: string) =>
    request<TokenDetailDto>("GET", `/api/token/${encodeURIComponent(addr)}`, kind ? { query: { kind } } : undefined),
  tx: (hash: string) => request<TxResponseDto>("GET", `/api/tx/${encodeURIComponent(hash)}`),
  txTrace: (hash: string) => request<CallTraceResponseDto>("GET", `/api/tx/${encodeURIComponent(hash)}/trace`),
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
  /** The receiver's own summaries of 1 to 2000 addresses, in request order; no side effects. */
  nodes: (addresses: string[]) =>
    request<NodeSummaryDto[]>("POST", "/api/nodes", { body: { addresses } satisfies NodesRequestDto }),
  /** Queues type/name lookups for the given addresses (1 to 500). */
  identify: (body: IdentifyRequestDto) => request<IdentifyResponseDto>("POST", "/api/identify", { body }),
  /** Releases a batch's jobs; only jobs left without any other owner are cancelled. */
  cancelBatch: (id: string) => request<CancelledDto>("DELETE", `/api/batches/${encodeURIComponent(id)}`),
  /** Cancels every active job that is not interactive. */
  cancelBackground: () => request<CancelledDto>("DELETE", "/api/jobs", { query: { scope: "background" } }),
};
