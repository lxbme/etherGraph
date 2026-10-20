import type { Page } from "@playwright/test";
import type { EdgeDto } from "../src/api/generated/EdgeDto";
import type { GraphRequestDto } from "../src/api/generated/GraphRequestDto";
import type { GraphResponseDto } from "../src/api/generated/GraphResponseDto";
import type { NodeSummaryDto } from "../src/api/generated/NodeSummaryDto";
import { expectLaidOut, nodeScreenPos, snapshot, tapNode } from "./cy";
import { A, C, expect, fixtures, test, type MockApi, confirmPicker, liveGraphRequests, pickerDialog, searchAndPick } from "./mockApi";

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
  // The big wallet is synced (its neighbours are stored); every other unknown address is not.
  return known ?? { ...fixtures.address.node, address, synced: address === W };
}

/**
 * The big wallet's graph like the server builds it: a picked center (`picks`) shows exactly its picks plus `prefer`,
 * any other the top `limits[c]` by count; the rest is counted in `omitted`.
 */
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
      const picked = body.picks?.[center];
      const keep = picked ? new Set([...picked, ...(body.prefer ?? [])].map((a) => a.toLowerCase())) : null;
      const shown = keep ? sorted.filter((n) => keep.has(n.node.address)) : sorted.slice(0, limit);
      for (const n of shown) {
        nodes.set(n.node.address, n.node);
        edges.push({
          from: center, to: n.node.address, asset: null, asset_kind: "native", count: n.count,
          sum: "1000000000000000000", first_ts: "2026-01-01T00:00:00Z", last_ts: n.last_ts, decimals: 18, symbol: null,
          trust: { level: "listed", impersonates: null, reason: null },
        });
      }
      if (sorted.length > shown.length) omitted[center] = sorted.length - shown.length;
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

/** The big wallet searched and expanded with the picker's default checks (its top k). */
async function openBig(page: Page, mock: MockApi) {
  mockBigWallet(mock);
  await searchAndPick(page, W);
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
  // The first neighbours of the lone center are fitted like a first load: every node, "+N more" too, is in view.
  await expectLaidOut(page, "main", real.length + 1);
  // The picker's default checks were the top k, sized to the canvas: the canvas shows exactly those.
  const req = liveGraphRequests(mock).at(-1)!.postDataJSON() as GraphRequestDto;
  expect(req.picks?.[W]?.length).toBe(real.length - 1);
  expect(req.limits?.[W]).toBeUndefined();
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
  await searchAndPick(page, A);
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

/** Model position of a node on the address graph. */
async function modelPos(page: Page, id: string) {
  return page.evaluate((id) => {
    const cy = (window as unknown as { __etherGraphCy?: import("cytoscape").Core | null }).__etherGraphCy!;
    const p = cy.$id(id).position();
    return { x: Math.round(p.x), y: Math.round(p.y) };
  }, id);
}

test("the +N more node can be dragged without revealing, and stays where it was dropped after a reveal", async ({ page, mock }) => {
  await openBig(page, mock);
  const proxy = `more:${W}`;
  // Let the first layout's glide (ANIMATION_MS) finish before grabbing: a running glide would carry the node on.
  await page.waitForTimeout(900);
  const last = await modelPos(page, proxy);
  const requests = mock.count(GRAPH);
  const realBefore = (await canvas(page)).real.length;

  const from = await nodeScreenPos(page, proxy);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 90, from.y + 70, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await modelPos(page, proxy)).x).not.toBe(last.x);
  const dropped = await modelPos(page, proxy);
  // A drag is not a click: nothing was revealed.
  await page.waitForTimeout(400);
  expect(mock.count(GRAPH)).toBe(requests);
  expect((await canvas(page)).real.length).toBe(realBefore);

  // A click opens the picker for W (spec §4), its picks checked and listed first; k one higher adds the next one.
  await tapNode(page, "main", proxy);
  const picker = pickerDialog(page);
  await expect(picker.locator(".dialog__summary")).toHaveText(new RegExp(`^${realBefore - 1} checked`));
  await picker.getByRole("spinbutton").fill(String(realBefore));
  await expect(picker.locator(".dialog__summary")).toHaveText(new RegExp(`^${realBefore} checked`));
  await confirmPicker(page);
  await expect.poll(async () => (await canvas(page)).real.length).toBe(realBefore + 1);
  await page.waitForTimeout(700);
  expect(await modelPos(page, proxy)).toEqual(dropped);
  expect(mock.unhandled).toEqual([]);
});

test("a dragged +N more node is saved with the workspace and returns to where it was dropped on open", async ({ page, mock }) => {
  await openBig(page, mock);
  const proxy = `more:${W}`;
  // Let the first layout's glide (ANIMATION_MS) finish before grabbing: a running glide would carry the node on.
  await page.waitForTimeout(900);
  const last = await modelPos(page, proxy);
  const from = await nodeScreenPos(page, proxy);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 90, from.y + 70, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await modelPos(page, proxy)).x).not.toBe(last.x);
  const dropped = await modelPos(page, proxy);

  await page.getByRole("button", { name: "Workspace menu" }).click();
  await page.getByRole("menuitem", { name: "Save", exact: true }).click();
  await page.getByRole("textbox", { name: "Workspace name" }).fill("big wallet");
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.getByText("Workspace: Saved")).toBeVisible();
  const body = mock.requests("POST /api/workspaces")[0]!.postDataJSON() as {
    state: { graph: { proxies?: Record<string, { x: number; y: number }> } };
  };
  const saved = body.state.graph.proxies?.[W];
  expect(saved && { x: Math.round(saved.x), y: Math.round(saved.y) }).toEqual(dropped);

  // A fresh page: the graph query has no result yet when the workspace is opened.
  await page.goto("/?e2e=1");
  await page.getByRole("button", { name: "Workspace menu" }).click();
  await page.getByRole("menuitem", { name: "Open…" }).click();
  await page.getByRole("dialog", { name: "Open workspace" }).getByRole("button", { name: "big wallet", exact: true }).click();
  // The proxy appears once the graph result arrives (`modelPos` needs it on the canvas).
  await expect.poll(async () => ((await canvas(page)).more.length > 0 ? modelPos(page, proxy) : null)).toEqual(dropped);
  expect(mock.unhandled).toEqual([]);
});
