import { test as base, expect, type Page, type Request, type Route } from "@playwright/test";
import type { AddressAssetDto } from "../src/api/generated/AddressAssetDto";
import type { AddressProfileDto } from "../src/api/generated/AddressProfileDto";
import type { CallTraceResponseDto } from "../src/api/generated/CallTraceResponseDto";
import type { CancelledDto } from "../src/api/generated/CancelledDto";
import type { CounterpartyPageDto } from "../src/api/generated/CounterpartyPageDto";
import type { EdgeDto } from "../src/api/generated/EdgeDto";
import type { Event } from "../src/api/generated/Event";
import type { GraphRequestDto } from "../src/api/generated/GraphRequestDto";
import type { GraphResponseDto } from "../src/api/generated/GraphResponseDto";
import type { IdentifyRequestDto } from "../src/api/generated/IdentifyRequestDto";
import type { IdentifyResponseDto } from "../src/api/generated/IdentifyResponseDto";
import type { JobDto } from "../src/api/generated/JobDto";
import type { MeDto } from "../src/api/generated/MeDto";
import type { NodeSummaryDto } from "../src/api/generated/NodeSummaryDto";
import type { NodesRequestDto } from "../src/api/generated/NodesRequestDto";
import type { ProbeItemDto } from "../src/api/generated/ProbeItemDto";
import type { ProbeRequestDto } from "../src/api/generated/ProbeRequestDto";
import type { ProbeResponseDto } from "../src/api/generated/ProbeResponseDto";
import type { SearchResultDto } from "../src/api/generated/SearchResultDto";
import type { StatusDto } from "../src/api/generated/StatusDto";
import type { SyncResponseDto } from "../src/api/generated/SyncResponseDto";
import type { TokenDetailDto } from "../src/api/generated/TokenDetailDto";
import type { TransferPageDto } from "../src/api/generated/TransferPageDto";
import type { TxRawDto } from "../src/api/generated/TxRawDto";
import type { TxResponseDto } from "../src/api/generated/TxResponseDto";
import type { NewWorkspaceDto } from "../src/api/generated/NewWorkspaceDto";
import type { UpdateWorkspaceDto } from "../src/api/generated/UpdateWorkspaceDto";
import type { WorkspaceDto } from "../src/api/generated/WorkspaceDto";
import type { WorkspaceMetaDto } from "../src/api/generated/WorkspaceMetaDto";
import addressJson from "./fixtures/address.json" with { type: "json" };
import counterpartiesJson from "./fixtures/counterparties.json" with { type: "json" };
import counterpartiesContractJson from "./fixtures/counterparties-contract.json" with { type: "json" };
import graphJson from "./fixtures/graph.json" with { type: "json" };
import longTextJson from "./fixtures/long-text.json" with { type: "json" };
import probeContractJson from "./fixtures/probe-contract.json" with { type: "json" };
import probeWalletJson from "./fixtures/probe-wallet.json" with { type: "json" };
import statusJson from "./fixtures/status.json" with { type: "json" };
import traceJson from "./fixtures/trace-ens.json" with { type: "json" };
import transfersJson from "./fixtures/transfers.json" with { type: "json" };
import txJson from "./fixtures/tx.json" with { type: "json" };
import tx7702Json from "./fixtures/tx-7702.json" with { type: "json" };
import txRawJson from "./fixtures/tx-raw.json" with { type: "json" };

export const A = "0xa11ce00000000000000000000000000000000001";
export const B = "0xb0b0000000000000000000000000000000000002";
export const C = "0xc0ffee0000000000000000000000000000000003";
export const D = "0xd00d000000000000000000000000000000000004";
export const E = "0xe0e0000000000000000000000000000000000005";
export const TX = "0x7e57000000000000000000000000000000000000000000000000000000000001";
/** An EIP-7702 batch self-call modelled on mainnet tx 0x4f85…bb8c: one authorization, USDT only emits Transfer logs. */
export const TX7702 = "0x4f85000000000000000000000000000000000000000000000000000000007702";

/** The signed-in user every spec runs as unless it overrides `GET /api/auth/me` (auth.spec.ts). */
export const ME: MeDto = {
  address: "0x5e55100000000000000000000000000000000006",
  is_admin: false,
  quota: { used: 120, limit: 5000, reset_at: "2026-10-18T00:00:00Z" },
};

export const fixtures = {
  graph: graphJson as GraphResponseDto,
  address: addressJson as AddressProfileDto,
  status: statusJson as StatusDto,
  transfers: transfersJson as TransferPageDto,
  tx: txJson as TxResponseDto,
  tx7702: tx7702Json as TxResponseDto,
  txRaw: txRawJson as TxRawDto,
  /** A ready call trace: ENS registration 0x461e68…45a3, decoded (17 frames, 8 of them read-only). */
  trace: traceJson as CallTraceResponseDto,
  /** The 120 neighbours of the big wallet (count descending; last two: a whale and a contract). */
  counterparties: counterpartiesJson as CounterpartyPageDto,
  /** Three wallets that interacted with a contract. */
  counterpartiesContract: counterpartiesContractJson as CounterpartyPageDto,
  /** Probe facts by address for the two counterparty sets above. */
  probe: { ...probeWalletJson, ...probeContractJson } as Record<string, ProbeItemDto>,
  /** Long ENS / contract name / error strings for the overflow checks. */
  longText: longTextJson as { ens: string; contractName: string; invalidInput: string; job: JobDto },
};

/**
 * `GET /api/address/{addr}/assets[?with=]` over `edges`: one row per asset of the edges touching `addr`, or with
 * `withAddr` one row per direction and asset between the two; by count descending.
 */
export function assetRows(edges: EdgeDto[], addr: string, withAddr?: string): AddressAssetDto[] {
  const a = addr.toLowerCase();
  const b = withAddr?.toLowerCase();
  const rows = new Map<string, AddressAssetDto>();
  for (const e of edges) {
    const f = e.from.toLowerCase();
    const t = e.to.toLowerCase();
    const hit = b === undefined ? f === a || t === a : (f === a && t === b) || (f === b && t === a);
    if (!hit) continue;
    const key = `${b === undefined ? "" : `${f}>${t}`}|${e.asset ?? "eth"}`;
    const cur = rows.get(key);
    if (cur) {
      cur.count += e.count;
      cur.sum = (BigInt(cur.sum) + BigInt(e.sum)).toString();
    } else {
      rows.set(key, {
        from: b === undefined ? null : f, to: b === undefined ? null : t, asset: e.asset, asset_kind: e.asset_kind,
        count: e.count, sum: e.sum, decimals: e.decimals, symbol: e.symbol, trust: e.trust,
      });
    }
  }
  return [...rows.values()].sort((x, y) => y.count - x.count);
}

export interface Reply {
  status?: number;
  json?: unknown;
}
/** Answers one request; `url` is the parsed request URL. */
export type Handler = (req: Request, url: URL) => Reply | Promise<Reply>;

/** `METHOD /path` with the path's dynamic segment replaced by `*` (e.g. `GET /api/tx/*`). */
export type RouteKey = string;

export const notFound = (message: string): Reply => ({ status: 404, json: { error: { code: "not_found", message } } });
/** 401 `unauthorized` with its reason, as the backend sends it (no session, refused login). */
export const unauthorized = (reason: string): Reply => ({ status: 401, json: { error: { code: "unauthorized", message: reason } } });

function defaultHandlers(): Map<RouteKey, Handler> {
  let nextWorkspaceId = 1;
  /** Saved workspaces (kept across page reloads within a test). */
  const workspaces = new Map<number, WorkspaceDto>();
  const workspaceId = (url: URL) => Number(url.pathname.split("/").pop());
  const nodes = new Map(fixtures.graph.nodes.map((n) => [n.address, n]));
  return new Map<RouteKey, Handler>([
    ["GET /api/auth/me", () => ({ json: ME })],
    ["POST /api/auth/logout", () => ({ status: 204 })],
    ["GET /api/status", () => ({ json: fixtures.status })],
    ["GET /api/jobs", () => ({ json: [] })],
    [
      "GET /api/search",
      (_req, url) => {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        const kind = q.length === 66 ? "tx" : "address";
        return { json: { kind, value: q, resolved_address: null } satisfies SearchResultDto };
      },
    ],
    [
      "GET /api/address/*",
      (_req, url) => {
        const addr = decodeURIComponent(url.pathname.split("/").pop() ?? "").toLowerCase();
        const node = nodes.get(addr);
        return node ? { json: { ...fixtures.address, node } satisfies AddressProfileDto } : notFound("unknown address");
      },
    ],
    ["POST /api/graph/edges", () => ({ json: fixtures.graph })],
    [
      // The backend's own summaries of a snapshot's nodes (the ones it knows).
      "POST /api/nodes",
      (req) => {
        const body = req.postDataJSON() as NodesRequestDto;
        return { json: body.addresses.flatMap((a) => nodes.get(a.toLowerCase()) ?? []) };
      },
    ],
    ["GET /api/address/*/counterparties", () => ({ json: { items: [], total: 0 } satisfies CounterpartyPageDto })],
    [
      "POST /api/probe",
      (req) => {
        const body = req.postDataJSON() as ProbeRequestDto;
        const items = body.addresses.map((a) => fixtures.probe[a.toLowerCase()]).filter((i): i is ProbeItemDto => !!i);
        return { json: { items, calls: items.length * 2 } satisfies ProbeResponseDto };
      },
    ],
    [
      "POST /api/sync",
      (req) => {
        const body = req.postDataJSON() as { addresses: string[] };
        const jobs = body.addresses.map((_, i) => i + 1);
        return { json: { estimated_calls: null, estimated_seconds: null, per_address: null, jobs } satisfies SyncResponseDto };
      },
    ],
    [
      "POST /api/identify",
      (req) => {
        const body = req.postDataJSON() as IdentifyRequestDto;
        return { json: { queued: body.addresses.length, jobs: [1] } satisfies IdentifyResponseDto };
      },
    ],
    ["DELETE /api/batches/*", () => ({ json: { cancelled: [] } satisfies CancelledDto })],
    ["DELETE /api/jobs", () => ({ json: { cancelled: [] } satisfies CancelledDto })],
    [
      // The transfer table's asset lists, from the fixture graph's edges.
      "GET /api/address/*/assets",
      (_req, url) => {
        const addr = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        return { json: assetRows(fixtures.graph.edges, addr, url.searchParams.get("with") ?? undefined) };
      },
    ],
    ["GET /api/transfers", () => ({ json: fixtures.transfers })],
    ["GET /api/tx/*/raw", () => ({ json: fixtures.txRaw })],
    ["GET /api/tx/*/trace", () => ({ json: fixtures.trace })],
    [
      "GET /api/tx/*",
      (_req, url) => {
        const path = url.pathname.toLowerCase();
        if (path.endsWith(TX)) return { json: fixtures.tx };
        return path.endsWith(TX7702) ? { json: fixtures.tx7702 } : notFound("unknown transaction");
      },
    ],
    [
      "GET /api/token/*",
      (_req, url) => {
        const address = decodeURIComponent(url.pathname.split("/").pop() ?? "").toLowerCase();
        const usdt = address === "0xdac17f958d2ee523a2206206994597c13d831ec7";
        const json: TokenDetailDto = usdt
          ? {
              address, standard: "erc20", name: "Tether USD", symbol: "USDT", decimals: 6, contract_name: "TetherToken",
              identified: true, source_verified: true, lists: { uniswap: true, coingecko: true }, tags: ["stablecoin"],
              website: "https://tether.to", trust: { level: "listed", impersonates: null, reason: null },
            }
          : {
              address, standard: "unknown", name: null, symbol: null, decimals: null, contract_name: null,
              identified: false, source_verified: null, lists: { uniswap: false, coingecko: false }, tags: [], website: null,
              trust: { level: "unknown", impersonates: null, reason: null },
            };
        return { json };
      },
    ],
    [
      "GET /api/workspaces",
      () => ({
        json: [...workspaces.values()].map(({ id, name, updated_at }) => ({ id, name, updated_at }) satisfies WorkspaceMetaDto),
      }),
    ],
    [
      "GET /api/workspaces/*",
      (_req, url) => {
        const w = workspaces.get(workspaceId(url));
        return w ? { json: w } : notFound("unknown workspace");
      },
    ],
    [
      "POST /api/workspaces",
      (req) => {
        const body = req.postDataJSON() as NewWorkspaceDto;
        const now = new Date().toISOString();
        const w: WorkspaceDto = {
          id: nextWorkspaceId++,
          name: body.name,
          schema_version: body.schema_version ?? 1,
          state: body.state,
          created_at: now,
          updated_at: now,
        };
        workspaces.set(w.id, w);
        return { status: 201, json: w };
      },
    ],
    [
      "PUT /api/workspaces/*",
      (req, url) => {
        const cur = workspaces.get(workspaceId(url));
        if (!cur) return notFound("unknown workspace");
        const body = req.postDataJSON() as UpdateWorkspaceDto;
        if (body.expected_updated_at !== cur.updated_at) {
          return { status: 409, json: { error: { code: "conflict", message: "changed elsewhere" } } };
        }
        const w: WorkspaceDto = {
          ...cur,
          name: body.name,
          schema_version: body.schema_version ?? cur.schema_version,
          state: body.state,
          updated_at: new Date(Date.parse(cur.updated_at) + 1).toISOString(),
        };
        workspaces.set(w.id, w);
        return { json: w };
      },
    ],
  ]);
}

/** `/api/address/0xabc` → `GET /api/address/*`, with a raw/trace/counterparties/assets sub-path kept after the `*`; fixed paths map to themselves. */
function routeKey(method: string, path: string): RouteKey {
  const m = /^(\/api\/(?:address|tx|jobs|workspaces|labels|batches|token))\/[^/]+(\/raw|\/trace|\/counterparties|\/assets)?$/.exec(path);
  return `${method} ${m ? `${m[1]}/*${m[2] ?? ""}` : path}`;
}

export interface MockApi {
  /** Requests seen so far for a route key (e.g. `POST /api/graph/edges`). */
  requests(key: RouteKey): Request[];
  count(key: RouteKey): number;
  /** Replaces the handler of a route key for the rest of the test. */
  on(key: RouteKey, handler: Handler): void;
  /** Holds responses for `key` until the returned function is called. */
  hold(key: RouteKey): () => void;
  /**
   * Answers the open `/api/events` connection with these events as one `text/event-stream` body
   * (they arrive together). EventSource then sees the stream end and reconnects; reconnects are
   * left pending, so they never open (no `Lagged` resync is triggered).
   */
  pushEvents(events: Event[]): Promise<void>;
  /** Route keys that had no handler (answered 404); tests assert this stays empty. */
  unhandled: string[];
  /** Teardown: aborts held `/api/events` requests (else they leak to the preview server's proxy). */
  dispose(): Promise<void>;
}

/**
 * Mocks the whole backend with `page.route("**\/api/**")`: JSON fixtures by method + path, with
 * per-route request recording. `/api/events` requests are held open (EventSource stays
 * "connecting", so no disconnect banner) until a test pushes events.
 */
export async function installMockApi(page: Page, opts: { tourDone?: boolean } = {}): Promise<MockApi> {
  const handlers = defaultHandlers();
  const seen = new Map<RouteKey, Request[]>();
  const holds = new Map<RouteKey, Promise<void>>();
  const sse: Route[] = [];
  const unhandled: string[] = [];
  // The first-run tour would cover the page under test.
  if (opts.tourDone !== false) await page.addInitScript(() => localStorage.setItem("eg.tour.done", "1"));

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const key = routeKey(req.method(), url.pathname);
    seen.set(key, [...(seen.get(key) ?? []), req]);
    if (key === "GET /api/events") {
      sse.push(route);
      return;
    }
    await holds.get(key);
    const handler = handlers.get(key);
    if (!handler) {
      unhandled.push(key);
      await route.fulfill({ ...jsonReply(notFound(`no mock for ${key}`)) });
      return;
    }
    await route.fulfill(jsonReply(await handler(req, url)));
  });

  return {
    requests: (key) => seen.get(key) ?? [],
    count: (key) => seen.get(key)?.length ?? 0,
    on: (key, handler) => void handlers.set(key, handler),
    hold: (key) => {
      let release!: () => void;
      holds.set(key, new Promise<void>((r) => (release = r)));
      return () => {
        holds.delete(key);
        release();
      };
    },
    pushEvents: async (events) => {
      await expectSoon(() => sse.length > 0, "no open /api/events connection");
      const route = sse.shift()!;
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
      });
    },
    unhandled,
    dispose: async () => {
      for (const route of sse.splice(0)) await route.abort().catch(() => {});
    },
  };
}

function jsonReply(r: Reply) {
  return {
    status: r.status ?? 200,
    contentType: "application/json",
    body: r.json === undefined ? "" : JSON.stringify(r.json),
  };
}

async function expectSoon(cond: () => boolean, message: string, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error(message);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** `test` with a `mock` fixture: the API is mocked before the page loads. */
export const test = base.extend<{ mock: MockApi; tourDone: boolean }>({
  /** Set false (`test.use({ tourDone: false })`) to let the first-run tour show. */
  tourDone: [true, { option: true }],
  mock: async ({ page, tourDone }, use) => {
    const mock = await installMockApi(page, { tourDone });
    await use(mock);
    await mock.dispose();
    // Close while still routed, so an EventSource reconnect never reaches the network.
    await page.close();
  },
});
export { expect } from "@playwright/test";

const lc = (s: string) => s.toLowerCase();

/**
 * A backend with stored transfers, for the specs that need the server's neighbour rules (spec §4): the graph
 * endpoint answers from `edges` the way the server does, so what the canvas shows depends on the request.
 */
export interface World {
  /** Node summaries by lowercase address; flip `synced` (and add `edges`) to model a finished sync. */
  nodes: Map<string, NodeSummaryDto>;
  /** Every stored transfer aggregate (lowercase addresses). */
  edges: EdgeDto[];
  /** Counterparties of a center that the graph's filter hides (added to its counterparties total). */
  filtered: Record<string, number>;
}

/** A node summary for `address` (an unknown EOA unless `over` says otherwise). */
export function summary(address: string, over: Partial<NodeSummaryDto> = {}): NodeSummaryDto {
  return {
    address: lc(address), kind: "eoa", display_name: null, ens: null, contract_name: null, labels: [],
    partial: false, syncing: false, synced: false, hot: false, identified: true, nonce: null, balance: null,
    ...over,
  };
}

/** One ETH transfer aggregate `from → to` with `count` transfers (the latest at `last`) of `eth` ETH in all (default `count`). */
export function transfer(from: string, to: string, count: number, last = "2024-03-02T12:30:00Z", eth = count): EdgeDto {
  return {
    from: lc(from), to: lc(to), asset: null, asset_kind: "native", count, sum: `${eth}000000000000000000`,
    first_ts: "2024-01-10T08:00:00Z", last_ts: last, decimals: 18, symbol: null,
    trust: { level: "listed", impersonates: null, reason: null },
  };
}

/** Distinct neighbours of `center` in `edges`, ranked like the server: transfer count descending, then address. */
export function rankedNeighbours(edges: EdgeDto[], center: string): string[] {
  const c = lc(center);
  const count = new Map<string, number>();
  for (const e of edges) {
    const other = e.from === c ? e.to : e.to === c ? e.from : null;
    if (other === null || other === c) continue;
    count.set(other, (count.get(other) ?? 0) + e.count);
  }
  return [...count].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).map(([a]) => a);
}

/**
 * Answers `POST /api/graph/edges`, `POST /api/nodes`, the address profile and the counterparties total from `world`.
 * The graph follows the server's rules: a picked center (`picks`, even empty) shows exactly its picked neighbours
 * plus `prefer` and the other centers; any other center its top `limits[c]` (default `limit_per_address`, else 200)
 * with `prefer` ranked first; `omitted` counts the rest. Only edges at a center are returned.
 */
export function installWorld(mock: MockApi, world: World): void {
  const node = (a: string) => world.nodes.get(a) ?? summary(a);
  mock.on("POST /api/graph/edges", (req) => {
    const body = req.postDataJSON() as GraphRequestDto;
    const centers = [...new Set(body.addresses.map(lc))];
    const isCenter = new Set(centers);
    const prefer = new Set((body.prefer ?? []).map(lc));
    const picks = new Map(Object.entries(body.picks ?? {}).map(([k, v]) => [lc(k), new Set(v.map(lc))]));
    const limits = new Map(Object.entries(body.limits ?? {}).map(([k, v]) => [lc(k), v]));
    const shown = new Set(centers);
    const omitted: Record<string, number> = {};
    for (const c of centers) {
      const others = rankedNeighbours(world.edges, c).filter((a) => !isCenter.has(a));
      const picked = picks.get(c);
      const take = picked
        ? others.filter((a) => picked.has(a) || prefer.has(a))
        : [...others.filter((a) => prefer.has(a)), ...others.filter((a) => !prefer.has(a))].slice(
            0,
            limits.get(c) ?? body.limit_per_address ?? 200,
          );
      for (const a of take) shown.add(a);
      if (others.length > take.length) omitted[c] = others.length - take.length;
    }
    const edges = world.edges.filter((e) => (isCenter.has(e.from) && shown.has(e.to)) || (isCenter.has(e.to) && shown.has(e.from)));
    const coverage = Object.fromEntries(centers.filter((c) => node(c).synced).map((c) => [c, fixtures.address.coverage]));
    return { json: { nodes: [...shown].map(node), edges, omitted, coverage } satisfies GraphResponseDto };
  });
  mock.on("POST /api/nodes", (req) => {
    const body = req.postDataJSON() as NodesRequestDto;
    return { json: body.addresses.flatMap((a) => world.nodes.get(lc(a)) ?? []) };
  });
  mock.on("GET /api/address/*", (_req, url) => {
    const a = lc(decodeURIComponent(url.pathname.split("/").pop() ?? ""));
    const n = world.nodes.get(a);
    if (!n) return notFound("unknown address");
    return { json: { ...fixtures.address, node: n, coverage: n.synced ? fixtures.address.coverage : [] } satisfies AddressProfileDto };
  });
  mock.on("GET /api/address/*/counterparties", (_req, url) => {
    const a = lc(url.pathname.split("/").at(-2) ?? "");
    const total = rankedNeighbours(world.edges, a).length + (world.filtered[a] ?? 0);
    return { json: { items: [], total } satisfies CounterpartyPageDto };
  });
}

/**
 * Searches `addr` from the top bar and confirms the neighbour picker that opens with its default checks (the top k):
 * how a user puts an address on the graph with its first neighbours now (a search alone shows the address only).
 * Selectors are language-neutral, so it works in either locale. `url` is the page to start from.
 */
export async function searchAndPick(page: Page, addr: string, url = "/?e2e=1"): Promise<void> {
  await page.goto(url);
  const search = page.getByRole("searchbox").first();
  await search.fill(addr);
  await search.press("Enter");
  await confirmPicker(page);
}

/** Confirms the open neighbour picker with its current checks, once it has listed them. */
export async function confirmPicker(page: Page): Promise<void> {
  const dialog = pickerDialog(page);
  const confirm = dialog.locator(".pick__actions .btn--primary");
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog).toHaveCount(0);
}

/** The neighbour picker (either language). */
export const pickerDialog = (page: Page) => page.locator('.dialog.pick[role="dialog"]');

/** The graph requests of the canvas itself (the picker's and the expand dialogs' dry runs left out). */
export const liveGraphRequests = (mock: MockApi): Request[] =>
  mock.requests("POST /api/graph/edges").filter((r) => !(r.postDataJSON() as GraphRequestDto).dry_run);
