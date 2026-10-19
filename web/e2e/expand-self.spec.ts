import type { Page } from "@playwright/test";
import type { EdgeDto } from "../src/api/generated/EdgeDto";
import type { GraphRequestDto } from "../src/api/generated/GraphRequestDto";
import type { GraphResponseDto } from "../src/api/generated/GraphResponseDto";
import type { NodeSummaryDto } from "../src/api/generated/NodeSummaryDto";
import { expectLaidOut, snapshot } from "./cy";
import { A, B, D, expect, fixtures, test, type MockApi } from "./mockApi";

const GRAPH = "POST /api/graph/edges";
const SYNC = "POST /api/sync";
/** B's stored counterparties that are not on the canvas yet. */
const FRESH = [1, 2, 3].map((i) => "0xf0" + i.toString(16).padStart(38, "0"));

/**
 * The fixture graph around the requested centers, with B `synced` as given; once B is a center (in a dry run or
 * the real query) it brings its first `fresh` stored counterparties and folds `omitted` more into "+N more".
 */
function mockGraph(mock: MockApi, opts: { synced: boolean; fresh: number; omitted: number }) {
  const base = fixtures.graph;
  const nodes = base.nodes.map((n) => (n.address === B ? { ...n, synced: opts.synced } : n));
  const template = base.nodes.find((n) => n.address === D)!;
  const fresh: NodeSummaryDto[] = FRESH.slice(0, opts.fresh).map((address) => ({ ...template, address }));
  const edges: EdgeDto[] = fresh.map((n) => ({ ...base.edges[0]!, from: B, to: n.address }));
  mock.on(GRAPH, (req) => {
    const body = req.postDataJSON() as GraphRequestDto;
    const withB = body.addresses.some((a) => a.toLowerCase() === B);
    const json: GraphResponseDto = withB
      ? { nodes: [...nodes, ...fresh], edges: [...base.edges, ...edges], omitted: { [B]: opts.omitted }, coverage: {} }
      : { ...base, nodes };
    return { json };
  });
}

const bodies = (mock: MockApi) => mock.requests(GRAPH).map((r) => r.postDataJSON() as GraphRequestDto);

/** Real (non "+N more") node ids on the address graph. */
async function real(page: Page): Promise<string[]> {
  const s = await snapshot(page, "main");
  return (s?.nodes ?? []).map((n) => n.id).filter((id) => !id.startsWith("more:"));
}

async function openGraph(page: Page, mock: MockApi) {
  await page.goto("/?e2e=1");
  await page.getByRole("searchbox", { name: "Search" }).fill(A);
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");
  await expect.poll(() => mock.count(GRAPH)).toBeGreaterThan(0);
  await expectLaidOut(page, "main", 4);
}

/** Opens the node's context menu the way a right click does (a `cxttap`). */
async function rightClick(page: Page, id: string) {
  await page.evaluate((id) => {
    const cy = (window as unknown as { __etherGraphCy?: import("cytoscape").Core | null }).__etherGraphCy!;
    const n = cy.$id(id);
    (n as unknown as { emit(e: object): void }).emit({ type: "cxttap", renderedPosition: n.renderedPosition() });
  }, id);
}

test("Expand… on a synced node: the dialog estimates 3 new nodes; Expand makes it a center without a sync; Ctrl+Z undoes it", async ({ page, mock }) => {
  mockGraph(mock, { synced: true, fresh: 3, omitted: 4 });
  await openGraph(page, mock);

  await rightClick(page, B);
  await page.getByRole("menuitem", { name: "Expand…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Expand Binance 14" });
  await expect(dialog.getByText("About 3 new nodes")).toBeVisible();
  await expect(dialog.getByText("No calls needed")).toBeVisible();
  const dry = bodies(mock).filter((b) => b.dry_run);
  expect(dry.length).toBeGreaterThan(0);
  expect(dry.at(-1)!.addresses).toEqual([B]);
  const k = Number(await dialog.getByLabel("Show at most per address").inputValue());
  expect(k).toBeGreaterThan(0);

  await dialog.getByRole("button", { name: "Expand", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => bodies(mock).some((b) => !b.dry_run && b.addresses.includes(B))).toBe(true);
  const live = bodies(mock).find((b) => !b.dry_run && b.addresses.includes(B))!;
  expect(live.addresses).toEqual([A, B]);
  expect(live.limits?.[B]).toBe(k);
  await expect.poll(async () => (await real(page)).sort()).toEqual([A, B, "0xc0ffee0000000000000000000000000000000003", D, ...FRESH].sort());
  expect(mock.count(SYNC)).toBe(0);

  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await real(page)).some((id) => FRESH.includes(id))).toBe(false);
  expect(mock.count(SYNC)).toBe(0);
  expect(mock.unhandled).toEqual([]);
});

test("Expand as centers opens the confirm dialog for the selected non-centers instead of expanding at once", async ({ page, mock }) => {
  mockGraph(mock, { synced: true, fresh: 3, omitted: 4 });
  await openGraph(page, mock);
  // The canvas's native selection, as a box over the two nodes makes it.
  await page.evaluate(
    (ids) => {
      const cy = (window as unknown as { __etherGraphCy?: import("cytoscape").Core | null }).__etherGraphCy!;
      for (const id of ids) cy.$id(id).select();
    },
    [B, D],
  );
  const bar = page.getByRole("toolbar", { name: "Batch actions" });
  await expect(bar).toContainText("2 nodes selected");
  await bar.getByRole("button", { name: "Expand as centers" }).click();

  const dialog = page.getByRole("dialog", { name: "Expand 2 addresses as centers" });
  await expect(dialog).toBeVisible();
  await expect(bar).toBeHidden();
  await expect.poll(() => bodies(mock).some((b) => b.dry_run && [...b.addresses].sort().join() === [B, D].sort().join())).toBe(true);
  // Nothing is a center until the dialog is confirmed.
  expect(bodies(mock).some((b) => !b.dry_run && b.addresses.includes(B))).toBe(false);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(bodies(mock).some((b) => !b.dry_run && b.addresses.includes(B))).toBe(false);
  expect(mock.count(SYNC)).toBe(0);
  expect(mock.unhandled).toEqual([]);
});

test("an unsynced target shows a range and Expand syncs just it, shallow", async ({ page, mock }) => {
  mockGraph(mock, { synced: false, fresh: 1, omitted: 0 });
  await openGraph(page, mock);

  await rightClick(page, B);
  await page.getByRole("menuitem", { name: "Expand…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Expand Binance 14" });
  await dialog.getByLabel("Show at most per address").fill("5");
  // 1 stored counterparty is new; up to k − 1 (A is on the canvas and takes a slot) after the sync.
  await expect(dialog.getByText("About 1–4 new nodes")).toBeVisible();
  await expect(dialog.getByText("1 address is synced first, about 6 calls")).toBeVisible();

  await dialog.getByRole("button", { name: "Expand", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => mock.count(SYNC)).toBe(1);
  const sync = mock.requests(SYNC)[0]!.postDataJSON() as { addresses: string[]; batch: string; depth: string };
  expect(sync).toEqual({ addresses: [B], batch: expect.any(String), depth: "shallow" });
  await expect.poll(() => bodies(mock).find((b) => !b.dry_run && b.addresses.includes(B))?.limits?.[B]).toBe(5);
  expect(mock.unhandled).toEqual([]);
});
