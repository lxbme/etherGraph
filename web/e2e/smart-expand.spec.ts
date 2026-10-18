import type { Page } from "@playwright/test";
import type { EdgeDto } from "../src/api/generated/EdgeDto";
import type { GraphRequestDto } from "../src/api/generated/GraphRequestDto";
import type { GraphResponseDto } from "../src/api/generated/GraphResponseDto";
import type { NodeSummaryDto } from "../src/api/generated/NodeSummaryDto";
import { snapshot, tapNode } from "./cy";
import { A, C, expect, fixtures, test, type MockApi } from "./mockApi";

/** A wallet with 120 stored neighbours (fixtures/counterparties.json). */
const W = "0xb16000000000000000000000000000000000beef";
const GRAPH = "POST /api/graph/edges";
const SYNC = "POST /api/sync";
/** src/graph/budget.ts PER_NODE_PX. */
const PER_NODE_PX = 96;

/** The big wallet's lowest-count neighbours: a contract and a whale (see fixtures/counterparties.json). */
const CONTRACT = "0x" + (0x100000 + 119).toString(16).padStart(40, "0");
const WHALE = "0x" + (0x100000 + 118).toString(16).padStart(40, "0");

const neighbours = fixtures.counterparties.items;

function summary(address: string): NodeSummaryDto {
  const known = neighbours.find((i) => i.node.address === address)?.node ?? fixtures.graph.nodes.find((n) => n.address === address);
  return known ?? { ...fixtures.address.node, address, synced: false };
}

/** The big wallet's graph, honouring the per-center limit like the server (highest count first). */
function mockBigWallet(mock: MockApi) {
  mock.on("GET /api/address/*", (_req, url) => {
    const addr = decodeURIComponent(url.pathname.split("/").pop() ?? "").toLowerCase();
    return { json: { ...fixtures.address, node: summary(addr) } };
  });
  mock.on("GET /api/address/*/counterparties", (_req, url) => {
    const addr = url.pathname.split("/")[3]!.toLowerCase();
    const sort = url.searchParams.get("sort");
    if (addr === C) return { json: fixtures.counterpartiesContract };
    if (addr !== W) return { json: { items: [], total: 0 } };
    const items = [...neighbours].sort((a, b) => (sort === "count_asc" ? a.count - b.count : b.count - a.count));
    return { json: { items, total: items.length } };
  });
  mock.on(GRAPH, (req) => {
    const body = req.postDataJSON() as GraphRequestDto;
    const nodes = new Map<string, NodeSummaryDto>();
    const edges: EdgeDto[] = [];
    const omitted: Record<string, number> = {};
    for (const raw of body.addresses) {
      const center = raw.toLowerCase();
      nodes.set(center, summary(center));
      if (center !== W) continue;
      const limit = body.limits?.[center] ?? body.limit_per_address ?? 200;
      const sorted = [...neighbours].sort((a, b) => b.count - a.count);
      for (const n of sorted.slice(0, limit)) {
        nodes.set(n.node.address, n.node);
        edges.push({
          from: center, to: n.node.address, asset: null, asset_kind: "native", count: n.count,
          sum: "1000000000000000000", first_ts: "2026-01-01T00:00:00Z", last_ts: n.last_ts, decimals: 18, symbol: null,
          trust: { level: "listed", impersonates: null, reason: null },
        });
      }
      if (sorted.length > limit) omitted[center] = sorted.length - limit;
    }
    return { json: { nodes: [...nodes.values()], edges, omitted, coverage: {} } satisfies GraphResponseDto };
  });
}

/** Real (non "+N more") node ids of the address graph, the "+N more" labels, and the in-page canvas capacity. */
async function canvas(page: Page) {
  const s = await snapshot(page, "main");
  const more = await page.evaluate(() => {
    const cy = (window as unknown as { __etherGraphCy?: import("cytoscape").Core | null }).__etherGraphCy;
    return cy ? cy.nodes(".more").map((n) => String(n.data("label"))) : [];
  });
  const real = (s?.nodes ?? []).filter((n) => !n.id.startsWith("more:")).map((n) => n.id);
  // The app measures the root element (ResizeObserver), which can be fractionally taller than cytoscape's integer size.
  const capacity = await page.getByTestId("address-graph").evaluate(
    (el, px) => {
      const r = el.getBoundingClientRect();
      return Math.floor((r.width * r.height) / (px * px));
    },
    PER_NODE_PX,
  );
  return { real, more, capacity };
}

async function openBig(page: Page, mock: MockApi) {
  mockBigWallet(mock);
  await page.goto("/?e2e=1");
  await page.getByRole("searchbox", { name: "Search" }).fill(W);
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");
  await expect.poll(() => mock.count(GRAPH)).toBeGreaterThan(0);
  await expect.poll(async () => (await canvas(page)).real.length).toBeGreaterThan(1);
}

/** Opens the node's context menu the way a right click does (a `cxttap`). */
async function rightClick(page: Page, id: string) {
  await page.evaluate((id) => {
    const cy = (window as unknown as { __etherGraphCy?: import("cytoscape").Core | null }).__etherGraphCy!;
    const n = cy.$id(id);
    (n as unknown as { emit(e: object): void }).emit({ type: "cxttap", renderedPosition: n.renderedPosition() });
  }, id);
}

test("a wallet with 120 neighbours opens within the canvas capacity, with +N more", async ({ page, mock }) => {
  await openBig(page, mock);
  const { real, more, capacity } = await canvas(page);
  expect(capacity).toBeGreaterThan(10);
  expect(real.length).toBeLessThanOrEqual(capacity);
  expect(real.length).toBeLessThan(121);
  expect(more).toHaveLength(1);
  const n = Number(/\d+/.exec(more[0]!)![0]);
  // Every neighbour is either on the canvas or counted in "+N more".
  expect(real.length - 1 + n).toBe(120);
  const req = mock.requests(GRAPH)[0]!.postDataJSON() as GraphRequestDto;
  expect(req.limits?.[W]).toBeGreaterThan(0);
  expect(mock.unhandled).toEqual([]);
});

test("expand: contracts and Heavy start unchecked; Undo restores the canvas and cancels the batch once", async ({ page, mock }) => {
  await openBig(page, mock);
  const before = (await canvas(page)).real.slice().sort();

  await rightClick(page, W);
  await page.getByRole("menuitem", { name: "Expand neighbors…" }).click();
  const dialog = page.getByRole("dialog", { name: /^Expand neighbors of/ });
  await expect(dialog.getByText("Heavy").first()).toBeVisible();

  // The whale is Heavy and unchecked; other wallets are checked; the contract group is collapsed.
  await expect(dialog.getByRole("checkbox", { name: "Heavy Whale" })).not.toBeChecked();
  await expect(dialog.getByRole("checkbox", { checked: true }).first()).toBeVisible();
  await dialog.getByRole("button", { name: /^Contracts \(1\)/ }).click();
  await expect(dialog.getByRole("checkbox", { name: CONTRACT })).not.toBeChecked();
  expect(mock.count("POST /api/probe")).toBeGreaterThan(0);

  await dialog.getByRole("button", { name: "Expand", exact: true }).click();
  await expect(dialog).toBeHidden();
  const sync = mock.requests(SYNC).at(-1)!.postDataJSON() as { addresses: string[]; batch: string; depth: string };
  expect(sync.depth).toBe("shallow");
  expect(sync.batch).toBeTruthy();
  expect(sync.addresses).not.toContain(WHALE);
  expect(sync.addresses).not.toContain(CONTRACT);

  await expect.poll(async () => (await canvas(page)).real.length).toBeGreaterThan(before.length);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => (await canvas(page)).real.slice().sort()).toEqual(before);
  await expect.poll(() => mock.count("DELETE /api/batches/*")).toBe(1);
  await page.waitForTimeout(500);
  expect(mock.count("DELETE /api/batches/*")).toBe(1);
  expect(mock.requests("DELETE /api/batches/*")[0]!.url()).toContain(`/api/batches/${sync.batch}`);
  expect(mock.unhandled).toEqual([]);
});

test("contract: Browse interactions…, pick 2 counterparties and expand them", async ({ page, mock }) => {
  mockBigWallet(mock);
  mock.on(GRAPH, () => ({ json: fixtures.graph }));
  await page.goto("/?e2e=1");
  await page.getByRole("searchbox", { name: "Search" }).fill(A);
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");
  await expect.poll(async () => (await canvas(page)).real.includes(C)).toBe(true);

  await tapNode(page, "main", C);
  await rightClick(page, C);
  await expect(page.getByRole("menuitem", { name: "Expand neighbors…" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Browse interactions…" }).click();
  const list = page.getByRole("dialog", { name: /UniswapV2Router02/ });
  const [one, two] = fixtures.counterpartiesContract.items;
  await list.getByRole("checkbox", { name: one!.node.address }).check();
  await list.getByRole("checkbox", { name: two!.node.address }).check();
  await list.getByRole("button", { name: "Expand selected (2)" }).click();

  const dialog = page.getByRole("dialog", { name: /^Expand neighbors of/ });
  await expect(dialog.getByRole("checkbox", { checked: true })).toHaveCount(2);
  await dialog.getByRole("button", { name: "Expand", exact: true }).click();
  await expect(dialog).toBeHidden();
  const sync = mock.requests(SYNC).at(-1)!.postDataJSON() as { addresses: string[]; batch: string };
  expect([...sync.addresses].sort()).toEqual([one!.node.address, two!.node.address].sort());
  expect(sync.batch).toBeTruthy();
  expect(mock.unhandled).toEqual([]);
});
