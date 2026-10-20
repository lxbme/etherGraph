import type { Page } from "@playwright/test";
import type { GraphRequestDto } from "../src/api/generated/GraphRequestDto";
import { expectLaidOut, snapshot } from "./cy";
import { A, B, C, D, expect, fixtures, installWorld, liveGraphRequests, searchAndPick, summary, test, transfer, type MockApi, type World } from "./mockApi";

const GRAPH = "POST /api/graph/edges";
const SYNC = "POST /api/sync";
/** B's stored counterparties that are not on the canvas yet. */
const FRESH = [1, 2, 3].map((i) => "0xf0" + i.toString(16).padStart(38, "0"));

/** The fixture graph's transfers, plus B's with FRESH once B is `synced` (else B has only what A's sync stored). */
function makeWorld(synced: boolean): World {
  const nodes = new Map(fixtures.graph.nodes.map((n) => [n.address, n.address === B ? { ...n, synced } : n]));
  FRESH.forEach((a, i) => nodes.set(a, summary(a, { display_name: `Fresh ${i + 1}` })));
  const edges = [...fixtures.graph.edges, ...(synced ? FRESH.map((a, i) => transfer(B, a, 9 - i)) : [])];
  return { nodes, edges, filtered: {} };
}

/** B's sync is done: its transfers are stored and the server says so. */
async function finishSync(mock: MockApi, world: World) {
  world.nodes.set(B, { ...world.nodes.get(B)!, synced: true });
  FRESH.forEach((a, i) => world.edges.push(transfer(B, a, 9 - i)));
  await mock.pushEvents([{ type: "AddressDataChanged", address: B }]);
}

const bodies = (mock: MockApi) => mock.requests(GRAPH).map((r) => r.postDataJSON() as GraphRequestDto);

/** Real (non "+N more") node ids on the address graph, sorted. */
async function real(page: Page): Promise<string[]> {
  const s = await snapshot(page, "main");
  return (s?.nodes ?? []).map((n) => n.id).filter((id) => !id.startsWith("more:")).sort();
}

/** A searched and expanded with the picker's defaults (A, B, C, D), once the new nodes' glide is over. */
async function openGraph(page: Page) {
  await searchAndPick(page, A);
  await expectLaidOut(page, "main", 4);
  // A moving viewport closes a context menu: let the incremental layout settle first.
  const boxes = async () => JSON.stringify((await snapshot(page, "main"))?.nodes);
  let last = await boxes();
  await expect(async () => {
    await page.waitForTimeout(250);
    const cur = await boxes();
    const same = cur === last;
    last = cur;
    expect(same, "layout settled").toBe(true);
  }).toPass({ timeout: 5000 });
}

/** Opens the node's context menu the way a right click does (a `cxttap`). */
async function rightClick(page: Page, id: string) {
  await page.evaluate((id) => {
    const cy = (window as unknown as { __etherGraphCy?: import("cytoscape").Core | null }).__etherGraphCy!;
    const n = cy.$id(id);
    (n as unknown as { emit(e: object): void }).emit({ type: "cxttap", renderedPosition: n.renderedPosition() });
  }, id);
}

test("Expand… on a synced node lists its neighbours, top k checked; confirming makes it a picked center without a sync; Ctrl+Z undoes it", async ({ page, mock }) => {
  installWorld(mock, makeWorld(true));
  await openGraph(page);

  await rightClick(page, B);
  await page.getByRole("menuitem", { name: "Expand…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Expand Binance 14" });
  // A is a center: never a row. The list comes from dry runs for B alone.
  await expect(dialog.getByText("3 neighbours · 0 on the canvas")).toBeVisible();
  await expect(dialog.getByRole("checkbox")).toHaveCount(3);
  const dry = bodies(mock).filter((b) => b.dry_run);
  expect(dry.length).toBeGreaterThan(0);
  expect(dry.at(-1)!.addresses).toEqual([B]);

  await dialog.getByRole("button", { name: "Expand 3 checked" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => real(page)).toEqual([A, B, C, D, ...FRESH].sort());
  const last = liveGraphRequests(mock).at(-1)!.postDataJSON() as GraphRequestDto;
  expect(last.addresses).toEqual([A, B]);
  expect([...last.picks![B]!].sort()).toEqual([...FRESH].sort());
  expect(mock.count(SYNC)).toBe(0);

  await page.keyboard.press("Control+z");
  await expect.poll(() => real(page)).toEqual([A, B, C, D].sort());
  expect(mock.count(SYNC)).toBe(0);
  expect(mock.unhandled).toEqual([]);
});

test("Expand as centers opens the picker grouped by address; an unsynced one asks to sync; Cancel changes nothing", async ({ page, mock }) => {
  installWorld(mock, makeWorld(true));
  await openGraph(page);
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
  const seen = mock.count(GRAPH);
  await bar.getByRole("button", { name: "Expand as centers" }).click();

  const dialog = page.getByRole("dialog", { name: "Expand 2 addresses" });
  await expect(dialog).toBeVisible();
  await expect(bar).toBeHidden();
  await expect(dialog.getByRole("button", { name: /Binance 14 · 3 total · 3 checked$/ })).toBeVisible();
  // D is not synced: its group offers the sync instead of a list.
  await expect(dialog.getByText("Sync first to list its neighbours (about 6 calls)")).toBeVisible();
  // Only the synced target is dry-run; nothing is a center until the dialog is confirmed.
  const dry = bodies(mock).slice(seen).filter((b) => b.dry_run);
  expect(dry.length).toBeGreaterThan(0);
  expect(dry.every((b) => b.addresses.join() === B)).toBe(true);
  expect(liveGraphRequests(mock).some((r) => (r.postDataJSON() as GraphRequestDto).addresses.includes(B))).toBe(false);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(liveGraphRequests(mock).some((r) => (r.postDataJSON() as GraphRequestDto).addresses.includes(B))).toBe(false);
  expect(mock.count(SYNC)).toBe(0);
  expect(mock.unhandled).toEqual([]);
});

test("Expand… on an unsynced node asks first, syncs just it (shallow), then lists it to pick from", async ({ page, mock }) => {
  const world = makeWorld(false);
  installWorld(mock, world);
  await openGraph(page);

  await rightClick(page, B);
  await page.getByRole("menuitem", { name: "Expand…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Expand Binance 14" });
  await expect(dialog.getByText("Sync first to list its neighbours (about 6 calls)")).toBeVisible();
  expect(mock.count(SYNC)).toBe(0);

  await dialog.getByRole("button", { name: "Sync", exact: true }).click();
  await expect.poll(() => mock.count(SYNC)).toBe(1);
  const sync = mock.requests(SYNC)[0]!.postDataJSON() as { addresses: string[]; batch: string; depth: string };
  expect(sync).toEqual({ addresses: [B], batch: expect.any(String), depth: "shallow" });

  await finishSync(mock, world);
  await expect(dialog.getByText("3 neighbours · 0 on the canvas")).toBeVisible();
  // The sync alone added nothing to the canvas.
  expect(await real(page)).toEqual([A, B, C, D].sort());
  await dialog.getByRole("button", { name: "Select none" }).click();
  await dialog.getByRole("checkbox", { name: /Fresh 2/ }).check();
  await dialog.getByRole("button", { name: "Expand 1 checked" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => real(page)).toEqual([A, B, C, D, FRESH[1]!].sort());
  expect(mock.count(SYNC)).toBe(1);
  expect(mock.unhandled).toEqual([]);
});
