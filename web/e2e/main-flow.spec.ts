import graphFiltered from "./fixtures/graph-filtered.json" with { type: "json" };
import graphRefreshed from "./fixtures/graph-refreshed.json" with { type: "json" };
import { expectLaidOut, snapshot, tapEdge, tapNode } from "./cy";
import type { GraphResponseDto } from "../src/api/generated/GraphResponseDto";
import { A, B, C, D, E, TX, expect, fixtures, installWorld, liveGraphRequests, searchAndPick, test, type MockApi, type World } from "./mockApi";
import type { Page } from "@playwright/test";

const GRAPH = "POST /api/graph/edges";
/** The app merges SSE data events over a 500ms window (src/api/useEvents.ts COALESCE_MS). */
const COALESCE_MS = 500;
/** Long enough that a second (wrongly un-merged) refetch would have fired: 3× the merge window. */
const NO_MORE_REFETCH_MS = 3 * COALESCE_MS;

/** Model position of a node on the address graph (null when absent). */
function nodePos(page: Page, id: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((id) => {
    const cy = (window as unknown as { __etherGraphCy?: import("cytoscape").Core | null }).__etherGraphCy;
    const n = cy?.$id(id);
    return n && n.nonempty() ? { ...n.position() } : null;
  }, id);
}

/** The node's position once it stopped moving (the incremental layout animates small graphs). */
async function settledPos(page: Page, id: string): Promise<{ x: number; y: number }> {
  let last = await nodePos(page, id);
  await expect(async () => {
    await page.waitForTimeout(250);
    const cur = await nodePos(page, id);
    const same = !!cur && !!last && cur.x === last.x && cur.y === last.y;
    last = cur;
    expect(same, `${id} settled`).toBe(true);
  }).toPass({ timeout: 5000 });
  return last!;
}

/** Searches `addr` and expands it with the picker's default checks; returns once the canvas asked for them. */
async function searchAddress(page: Page, mock: MockApi, addr: string) {
  await searchAndPick(page, addr);
  await expect.poll(() => liveGraphRequests(mock).at(-1)?.postDataJSON().picks?.[addr]?.length ?? 0).toBeGreaterThan(0);
}

/** How many graph requests the canvas itself made (dry runs left out). */
const live = (mock: MockApi) => liveGraphRequests(mock).length;

test("search → edge → transfers → tx tab → back → filter → save", async ({ page, mock }) => {
  await searchAddress(page, mock, A);
  // Searching never syncs or refreshes by itself (spec §5.6); the first graph showed A alone, then its picks.
  expect(mock.requests("GET /api/address/*").filter((r) => r.url().includes("sync="))).toEqual([]);
  expect(mock.count("POST /api/sync")).toBe(0);
  expect(liveGraphRequests(mock)[0]!.postDataJSON()).toMatchObject({ addresses: [A], picks: { [A]: [] } });
  expect([...liveGraphRequests(mock).at(-1)!.postDataJSON().picks[A]].sort()).toEqual([B, C, D].sort());

  // (1) The canvas has a real size and shows the center with its neighbours.
  const graph = page.getByTestId("address-graph");
  const box = await graph.locator("canvas").first().boundingBox();
  expect(box!.width).toBeGreaterThan(100);
  expect(box!.height).toBeGreaterThan(100);
  const first = await expectLaidOut(page, "main", 4);
  expect(first.nodes.map((n) => n.id).sort()).toEqual([A, B, C, D].sort());

  // Click the A→B edge: the bottom table groups the pair's transfers by direction and asset.
  await tapEdge(page, A, B);
  const groups = page.getByTestId("transfer-group");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toContainText("3 transfers");
  await expect(groups.nth(1)).toContainText("USDT");
  const rows = page.getByTestId("transfer-row");
  await expect(rows).toHaveCount(3);
  const transfers = new URL(mock.requests("GET /api/transfers").at(-1)!.url()).searchParams;
  expect([transfers.get("from"), transfers.get("to"), transfers.get("asset")]).toEqual([A, B, "eth"]);

  // Click a tx hash: a tx tab opens with the fund-flow graph and its banner.
  await rows.first().getByRole("button", { name: /0x7e57/ }).click();
  const txTab = page.getByRole("tab", { name: /^Tx 0x7e57/ });
  await expect(txTab).toHaveAttribute("aria-selected", "true");
  const txView = page.getByTestId("tx-view");
  await expect(txView.getByText("This is a fund-flow graph, not a full call tree", { exact: false })).toBeVisible();
  await expectLaidOut(page, { tx: TX }, 3);
  await expect(graph).toBeHidden();

  // (2) Back to the graph: still visible and correctly sized, not a zero-size/tiny graph.
  await page.getByRole("tab", { name: "Graph" }).click();
  await expect(graph).toBeVisible();
  const back = await expectLaidOut(page, "main", 4);
  expect(back.zoom).toBeCloseTo(first.zoom, 5);

  // Filter: ETH only, at least 1 ETH.
  await page.getByRole("button", { name: /Filter/ }).click();
  const dialog = page.getByRole("dialog", { name: "Filter" });
  await dialog.getByLabel("ETH", { exact: true }).check();
  await dialog.getByLabel("ETH min amount").fill("1");
  mock.on(GRAPH, () => ({ json: graphFiltered }));
  const beforeFilter = live(mock);
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect.poll(() => live(mock)).toBe(beforeFilter + 1);
  expect(liveGraphRequests(mock).at(-1)!.postDataJSON()).toMatchObject({
    addresses: [A],
    filter: { assets: [{ asset: null, min_amount: "1" }] },
  });
  await expect(page.getByTestId("filter-active")).toBeVisible();
  await expect.poll(async () => (await snapshot(page, "main"))?.edges.length).toBe(2);
  await expectLaidOut(page, "main", 3);

  // Save the canvas.
  await page.getByRole("button", { name: "Workspace menu" }).click();
  await page.getByRole("menuitem", { name: "Save", exact: true }).click();
  await page.getByRole("textbox", { name: "Workspace name" }).fill("e2e workspace");
  await page.getByRole("button", { name: "OK" }).click();
  await expect(page.getByText("Workspace: Saved")).toBeVisible();
  const saved = mock.requests("POST /api/workspaces");
  expect(saved).toHaveLength(1);
  const body = saved[0]!.postDataJSON() as {
    name: string;
    state: {
      graph: { centers: string[]; filter: unknown; picks: Record<string, string[]>; nodes: { address: string }[] };
      tabs: { hash: string }[];
    };
  };
  expect(body.name).toBe("e2e workspace");
  expect(body.state.graph.centers).toEqual([A]);
  expect(body.state.graph.filter).toEqual({ assets: [{ asset: null, min_amount: "1" }] });
  expect([...body.state.graph.picks[A]!].sort()).toEqual([B, C, D].sort());
  expect(body.state.graph.nodes.map((n) => n.address).sort()).toEqual([A, B, D].sort());
  // The tx tab opened above is saved with the workspace.
  expect(body.state.tabs.map((t) => t.hash)).toEqual([TX]);

  expect(mock.unhandled).toEqual([]);
});

test("AddressDataChanged over SSE refreshes the graph exactly once; the new neighbour stays out of the picked graph", async ({ page, mock }) => {
  // The server's rules over the stored transfers: the fixture graph now, the refreshed one after the event.
  const world: World = { nodes: new Map(fixtures.graph.nodes.map((n) => [n.address, n])), edges: [...fixtures.graph.edges], filtered: {} };
  installWorld(mock, world);
  await searchAddress(page, mock, A);
  await expectLaidOut(page, "main", 4);
  // Let the initial load settle (no fetch in flight that the refresh would be deferred behind).
  await expect(page.getByRole("status", { name: "Updating" })).toHaveCount(0);

  const refreshed = graphRefreshed as GraphResponseDto;
  for (const n of refreshed.nodes) world.nodes.set(n.address, n);
  world.edges = [...refreshed.edges];
  const before = mock.count(GRAPH);
  const unrelated = "0x9999999999999999999999999999999999999999";
  await mock.pushEvents([
    { type: "AddressDataChanged", address: A },
    { type: "AddressDataChanged", address: B },
    { type: "AddressDataChanged", address: A.toUpperCase().replace("0X", "0x") },
    { type: "AddressDataChanged", address: unrelated },
  ]);

  // The burst is merged into one refetch; A shows exactly its picks, the new neighbour E only counts in "+1 more".
  await expect.poll(() => mock.count(GRAPH)).toBe(before + 1);
  await expect.poll(async () => (await snapshot(page, "main"))?.nodes.map((n) => n.id).sort()).toEqual([A, B, C, D, `more:${A}`].sort());
  expect((await snapshot(page, "main"))!.nodes.map((n) => n.id)).not.toContain(E);
  // No further refetch follows (and the SSE reconnect does not trigger a Lagged resync).
  await page.waitForTimeout(NO_MORE_REFETCH_MS);
  expect(mock.count(GRAPH)).toBe(before + 1);
  expect(mock.count("GET /api/events")).toBeGreaterThanOrEqual(2);

  expect(mock.unhandled).toEqual([]);
});

test("a node dropped by a filter returns to its previous position on undo", async ({ page, mock }) => {
  await searchAddress(page, mock, A);
  await expectLaidOut(page, "main", 4);
  const before = await settledPos(page, C);

  mock.on(GRAPH, () => ({ json: graphFiltered }));
  await page.getByRole("button", { name: /Filter/ }).click();
  const dialog = page.getByRole("dialog", { name: "Filter" });
  await dialog.getByLabel("ETH", { exact: true }).check();
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect.poll(async () => (await snapshot(page, "main"))?.nodes.map((n) => n.id).sort()).toEqual([A, B, D].sort());

  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await snapshot(page, "main"))?.nodes.length).toBe(4);
  const after = await settledPos(page, C);
  expect(after!.x).toBeCloseTo(before!.x, 3);
  expect(after!.y).toBeCloseTo(before!.y, 3);
  expect(mock.unhandled).toEqual([]);
});

test("under Inbound the node transfer table asks for the side the canvas shows", async ({ page, mock }) => {
  await searchAddress(page, mock, A);
  await expectLaidOut(page, "main", 4);
  await page.getByRole("button", { name: /Filter/ }).click();
  const dialog = page.getByRole("dialog", { name: "Filter" });
  await dialog.getByLabel("Inbound", { exact: true }).check();
  const before = live(mock);
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect.poll(() => live(mock)).toBe(before + 1);

  const asked = () =>
    mock.requests("GET /api/transfers").map((r) => {
      const p = new URL(r.url()).searchParams;
      return `${p.get("address")}:${p.get("direction")}`;
    });
  // A (the selected center) keeps the filter's direction.
  await expect.poll(asked).toContain(`${A}:in`);
  // D is not a center: the canvas shows D→A, so D's table asks for its outgoing side.
  await tapNode(page, "main", D);
  await expect.poll(asked).toContain(`${D}:out`);
  expect(asked()).not.toContain(`${D}:in`);
  expect(mock.unhandled).toEqual([]);
});

for (const query of ["", "?e2e=0"]) {
  test(`the cytoscape e2e hook is inert without ?e2e=1 (url "/${query}")`, async ({ page, mock }) => {
    await searchAndPick(page, A, `/${query}`);
    await expect.poll(() => live(mock)).toBeGreaterThan(1);
    await expect(page.getByTestId("address-graph").locator("canvas").first()).toBeVisible();
    // Also mount a tx graph, the other registration point.
    await page.getByRole("searchbox", { name: "Search" }).fill(TX);
    await page.getByRole("searchbox", { name: "Search" }).press("Enter");
    await expect(page.getByTestId("tx-view").locator("canvas").first()).toBeVisible();
    const exposed = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return { main: typeof w.__etherGraphCy, tx: typeof w.__etherGraphTxCy };
    });
    expect(exposed).toEqual({ main: "undefined", tx: "undefined" });
    expect(mock.unhandled).toEqual([]);
  });
}
