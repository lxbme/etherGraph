import { test as base, type Page, type Request, type Route } from "@playwright/test";
import type { AddressProfileDto } from "../src/api/generated/AddressProfileDto";
import type { CancelledDto } from "../src/api/generated/CancelledDto";
import type { CounterpartyPageDto } from "../src/api/generated/CounterpartyPageDto";
import type { Event } from "../src/api/generated/Event";
import type { GraphResponseDto } from "../src/api/generated/GraphResponseDto";
import type { IdentifyRequestDto } from "../src/api/generated/IdentifyRequestDto";
import type { IdentifyResponseDto } from "../src/api/generated/IdentifyResponseDto";
import type { JobDto } from "../src/api/generated/JobDto";
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
import type { WorkspaceDto } from "../src/api/generated/WorkspaceDto";
import addressJson from "./fixtures/address.json" with { type: "json" };
import counterpartiesJson from "./fixtures/counterparties.json" with { type: "json" };
import counterpartiesContractJson from "./fixtures/counterparties-contract.json" with { type: "json" };
import graphJson from "./fixtures/graph.json" with { type: "json" };
import longTextJson from "./fixtures/long-text.json" with { type: "json" };
import probeContractJson from "./fixtures/probe-contract.json" with { type: "json" };
import probeWalletJson from "./fixtures/probe-wallet.json" with { type: "json" };
import statusJson from "./fixtures/status.json" with { type: "json" };
import transfersJson from "./fixtures/transfers.json" with { type: "json" };
import txJson from "./fixtures/tx.json" with { type: "json" };
import txRawJson from "./fixtures/tx-raw.json" with { type: "json" };

export const A = "0xa11ce00000000000000000000000000000000001";
export const B = "0xb0b0000000000000000000000000000000000002";
export const C = "0xc0ffee0000000000000000000000000000000003";
export const D = "0xd00d000000000000000000000000000000000004";
export const E = "0xe0e0000000000000000000000000000000000005";
export const TX = "0x7e57000000000000000000000000000000000000000000000000000000000001";

export const fixtures = {
  graph: graphJson as GraphResponseDto,
  address: addressJson as AddressProfileDto,
  status: statusJson as StatusDto,
  transfers: transfersJson as TransferPageDto,
  tx: txJson as TxResponseDto,
  txRaw: txRawJson as TxRawDto,
  /** The 120 neighbours of the big wallet (count descending; last two: a whale and a contract). */
  counterparties: counterpartiesJson as CounterpartyPageDto,
  /** Three wallets that interacted with a contract. */
  counterpartiesContract: counterpartiesContractJson as CounterpartyPageDto,
  /** Probe facts by address for the two counterparty sets above. */
  probe: { ...probeWalletJson, ...probeContractJson } as Record<string, ProbeItemDto>,
  /** Long ENS / contract name / error strings for the overflow checks. */
  longText: longTextJson as { ens: string; contractName: string; invalidInput: string; job: JobDto },
};

export interface Reply {
  status?: number;
  json?: unknown;
}
/** Answers one request; `url` is the parsed request URL. */
export type Handler = (req: Request, url: URL) => Reply | Promise<Reply>;

/** `METHOD /path` with the path's dynamic segment replaced by `*` (e.g. `GET /api/tx/*`). */
export type RouteKey = string;

const notFound = (message: string): Reply => ({ status: 404, json: { error: { code: "not_found", message } } });

function defaultHandlers(): Map<RouteKey, Handler> {
  let nextWorkspaceId = 1;
  const nodes = new Map(fixtures.graph.nodes.map((n) => [n.address, n]));
  return new Map<RouteKey, Handler>([
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
    ["GET /api/transfers", () => ({ json: fixtures.transfers })],
    ["GET /api/tx/*/raw", () => ({ json: fixtures.txRaw })],
    [
      "GET /api/tx/*",
      (_req, url) =>
        url.pathname.toLowerCase().endsWith(TX) ? { json: fixtures.tx } : notFound("unknown transaction"),
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
              website: "https://tether.to",
            }
          : {
              address, standard: "unknown", name: null, symbol: null, decimals: null, contract_name: null,
              identified: false, source_verified: null, lists: { uniswap: false, coingecko: false }, tags: [], website: null,
            };
        return { json };
      },
    ],
    ["GET /api/workspaces", () => ({ json: [] })],
    [
      "POST /api/workspaces",
      (req) => {
        const body = req.postDataJSON() as { name: string; state: WorkspaceDto["state"] };
        const now = new Date().toISOString();
        const w: WorkspaceDto = {
          id: nextWorkspaceId++,
          name: body.name,
          schema_version: 1,
          state: body.state,
          created_at: now,
          updated_at: now,
        };
        return { status: 201, json: w };
      },
    ],
  ]);
}

/** `/api/address/0xabc` → `GET /api/address/*`; fixed paths map to themselves. */
function routeKey(method: string, path: string): RouteKey {
  const m = /^(\/api\/(?:address|tx|jobs|workspaces|labels|batches|token))\/[^/]+(\/raw|\/counterparties)?$/.exec(path);
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
