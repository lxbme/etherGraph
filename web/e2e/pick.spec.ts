import type { Locator, Page } from "@playwright/test";
import type { GraphRequestDto } from "../src/api/generated/GraphRequestDto";
import { expectLaidOut, snapshot, tapNode } from "./cy";
import { A, expect, installWorld, summary, test, transfer, type MockApi, type World } from "./mockApi";

const GRAPH = "POST /api/graph/edges";
const SYNC = "POST /api/sync";
const PROFILE = "GET /api/address/*";
/** An address never synced: no stored transfers until the spec "finishes" its sync. */
const X = "0x7a7a000000000000000000000000000000000007";
const peer = (i: number) => "0x9e" + (i + 1).toString(16).padStart(38, "0");
const peerName = (i: number) => `Peer ${String(i + 1).padStart(2, "0")}`;
/** X's counterparties, stored once its sync is done. */
const FRESH = [0, 1, 2, 3, 4].map((i) => "0x5a" + (i + 1).toString(16).padStart(38, "0"));
const freshName = (i: number) => `Fresh ${i + 1}`;

/**
 * A (synced, "Alice") with `peers` neighbours ranked by transfer count (Peer 01 the most), and X ("Xavier") not synced.
 */
function makeWorld(peers = 12): World {
  const nodes = new Map([
    [A, summary(A, { display_name: "Alice", synced: true })],
    [X, summary(X, { display_name: "Xavier" })],
  ]);
  const edges = [];
  for (let i = 0; i < peers; i++) {
    nodes.set(peer(i), summary(peer(i), { display_name: peerName(i) }));
    // Both directions occur; the count decides the rank.
    edges.push(i % 2 ? transfer(peer(i), A, 100 - i) : transfer(A, peer(i), 100 - i));
  }
  FRESH.forEach((a, i) => nodes.set(a, summary(a, { display_name: freshName(i) })));
  return { nodes, edges, filtered: {} };
}

/** X's sync is done: it is synced and its transfers are stored (the server then reports the change). */
async function finishSync(mock: MockApi, world: World) {
  world.nodes.set(X, { ...world.nodes.get(X)!, synced: true });
  FRESH.forEach((a, i) => world.edges.push(transfer(X, a, 50 - i)));
  await mock.pushEvents([{ type: "AddressDataChanged", address: X }]);
}

/** Bodies of the canvas's own graph requests (not the picker's dry runs). */
const liveBodies = (mock: MockApi) =>
  mock.requests(GRAPH).map((r) => r.postDataJSON() as GraphRequestDto).filter((b) => !b.dry_run);

/** Address nodes on the canvas ("+N more" placeholders left out), sorted. */
async function real(page: Page): Promise<string[]> {
  const s = await snapshot(page, "main");
  return (s?.nodes ?? []).map((n) => n.id).filter((id) => !id.startsWith("more:")).sort();
}

async function search(page: Page, addr: string) {
  await page.goto("/?e2e=1");
  await page.getByRole("searchbox", { name: "Search" }).fill(addr);
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");
}

/** The rows' checkboxes in list order, as booleans. */
function checks(dialog: Locator): Promise<boolean[]> {
  return dialog.getByRole("checkbox").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).checked));
}

/** Waits for the list to be filled (not busy) with `n` neighbours (long lists render only the rows near view). */
async function listed(dialog: Locator, n: number) {
  await expect(dialog.getByRole("group", { name: "Neighbours" })).toHaveAttribute("aria-busy", "false");
  await expect(dialog.getByText(new RegExp(`^${n} neighbours · `))).toBeVisible();
  if (n <= 12) await expect(dialog.getByRole("checkbox")).toHaveCount(n);
}

/** Whether the row named `name` is checked. */
const isChecked = (dialog: Locator, name: string) => dialog.getByRole("checkbox", { name: new RegExp(name) }).isChecked();

/** Unchecks every row, then checks the rows named `names`. */
async function pickOnly(dialog: Locator, names: string[]) {
  await dialog.getByRole("button", { name: "Select none" }).click();
  await expect(dialog.getByText(/^0 checked/)).toBeVisible();
  for (const name of names) await dialog.getByRole("checkbox", { name: new RegExp(name) }).check();
  await expect(dialog.getByText(new RegExp(`^${names.length} checked`))).toBeVisible();
}

test("search_new_address_confirm_sync_pick_two: an unsynced address alone, sync after a confirm, then exactly two picked", async ({ page, mock }) => {
  const world = makeWorld();
  installWorld(mock, world);
  await search(page, X);

  // Only the address itself, with no neighbours and no sync asked yet.
  await expectLaidOut(page, "main", 1);
  expect(await real(page)).toEqual([X]);
  const dialog = page.getByRole("dialog", { name: "Expand Xavier" });
  await expect(dialog.getByText("Sync first to list its neighbours (about 6–26 calls)")).toBeVisible();
  await expect(dialog.getByText(/99,?880 calls left today/)).toBeVisible();
  expect(mock.count(SYNC)).toBe(0);

  await dialog.getByRole("button", { name: "Sync", exact: true }).click();
  await expect.poll(() => mock.count(SYNC)).toBe(1);
  expect(mock.requests(SYNC)[0]!.postDataJSON()).toEqual({ addresses: [X], depth: "shallow", batch: expect.any(String) });
  await expect(dialog.getByText("Syncing…")).toBeVisible();

  // The sync is done while the dialog is open: it turns into the list, top k checked; the canvas gains nothing.
  await finishSync(mock, world);
  await listed(dialog, FRESH.length);
  const k = Number(await dialog.getByRole("spinbutton").inputValue());
  expect(k).toBeGreaterThan(0);
  const top = Math.min(k, FRESH.length);
  expect(await checks(dialog)).toEqual(FRESH.map((_, i) => i < top));
  await expect(dialog.getByText(`${FRESH.length} neighbours · 0 on the canvas`)).toBeVisible();
  expect(await real(page)).toEqual([X]);

  await pickOnly(dialog, [freshName(1), freshName(3)]);
  await expect(dialog.getByRole("button", { name: "Expand 2 checked" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Expand 2 checked" }).click();
  await expect(dialog).toBeHidden();

  // Exactly three nodes: the center and its two picks; the request says so.
  await expect.poll(() => real(page)).toEqual([X, FRESH[1]!, FRESH[3]!].sort());
  expect(liveBodies(mock).at(-1)!.picks).toEqual({ [X]: expect.arrayContaining([FRESH[1], FRESH[3]]) });
  expect(liveBodies(mock).at(-1)!.picks![X]).toHaveLength(2);
  expect(mock.count(SYNC)).toBe(1);
  expect(mock.requests(PROFILE).some((r) => r.url().includes("sync="))).toBe(false);
  expect(mock.unhandled).toEqual([]);
});

test("not_now_queues_nothing: Not now leaves the address alone and spends no call", async ({ page, mock }) => {
  installWorld(mock, makeWorld());
  await search(page, X);
  const dialog = page.getByRole("dialog", { name: "Expand Xavier" });
  await dialog.getByRole("button", { name: "Not now" }).click();
  await expect(dialog).toBeHidden();

  await expectLaidOut(page, "main", 1);
  // Long enough for any queued follow-up (profile, events) to have gone out.
  await page.waitForTimeout(1500);
  expect(mock.count(SYNC)).toBe(0);
  expect(mock.count(PROFILE)).toBeGreaterThan(0);
  expect(mock.requests(PROFILE).filter((r) => r.url().includes("sync="))).toEqual([]);
  expect(liveBodies(mock).every((b) => JSON.stringify(b.picks) === JSON.stringify({ [X]: [] }))).toBe(true);
  expect(await real(page)).toEqual([X]);
  expect(mock.unhandled).toEqual([]);
});

test("synced_address_opens_picker_directly: the list is there at once, k re-checks the top k, the filter's hidden count shows", async ({ page, mock }) => {
  const world = makeWorld();
  world.filtered[A] = 2;
  installWorld(mock, world);
  await search(page, A);

  const dialog = page.getByRole("dialog", { name: "Expand Alice" });
  await listed(dialog, 12);
  // The center alone on the canvas, its neighbours folded into "+12 more".
  expect(await real(page)).toEqual([A]);
  expect((await snapshot(page, "main"))!.nodes.map((n) => n.id)).toContain(`more:${A}`);
  await expect(dialog.getByText("12 neighbours · 0 on the canvas")).toBeVisible();
  await expect(dialog.getByText("The current filter hides 2 neighbours")).toBeVisible();
  await expect(dialog.getByText(/^Last synced: /)).toBeVisible();

  // The rows come in the graph's rank; k = 3 checks exactly the top three.
  await expect(dialog.getByRole("checkbox").first()).toHaveAccessibleName(/Peer 01/);
  await dialog.getByRole("spinbutton").fill("3");
  await expect.poll(() => checks(dialog)).toEqual([...Array(12).keys()].map((i) => i < 3));
  await dialog.getByRole("button", { name: "Expand 3 checked" }).click();
  await expect(dialog).toBeHidden();

  const three = [A, peer(0), peer(1), peer(2)].sort();
  await expect.poll(() => real(page)).toEqual(three);
  expect(mock.count(SYNC)).toBe(0);

  // New data for the center brings no other neighbour (spec §4): the refetch keeps exactly the three.
  const before = mock.count(GRAPH);
  await mock.pushEvents([{ type: "AddressDataChanged", address: A }]);
  await expect.poll(() => mock.count(GRAPH)).toBeGreaterThan(before);
  await expect(page.getByRole("status", { name: "Updating" })).toHaveCount(0);
  expect(await real(page)).toEqual(three);
  expect(mock.unhandled).toEqual([]);
});

test("more_node_reopens_with_current_picks: +N more opens the picker with the picks checked", async ({ page, mock }) => {
  installWorld(mock, makeWorld());
  await search(page, A);
  let dialog = page.getByRole("dialog", { name: "Expand Alice" });
  await listed(dialog, 12);
  await pickOnly(dialog, [peerName(4), peerName(8)]);
  await dialog.getByRole("button", { name: "Expand 2 checked" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => real(page)).toEqual([A, peer(4), peer(8)].sort());

  await tapNode(page, "main", `more:${A}`);
  dialog = page.getByRole("dialog", { name: "Expand Alice" });
  await listed(dialog, 12);
  await expect(dialog.getByText("12 neighbours · 2 on the canvas")).toBeVisible();
  await expect(dialog.getByText(/^2 checked/)).toBeVisible();
  // The rows on the canvas rank first (the graph's prefer), still checked; nothing else is.
  await expect(dialog.getByRole("checkbox").nth(0)).toHaveAccessibleName(new RegExp(peerName(4)));
  await expect(dialog.getByRole("checkbox").nth(1)).toHaveAccessibleName(new RegExp(peerName(8)));
  expect(await checks(dialog)).toEqual([...Array(12).keys()].map((i) => i < 2));
  expect(await isChecked(dialog, peerName(0))).toBe(false);
  // Adding one more keeps the other two.
  await dialog.getByRole("checkbox", { name: new RegExp(peerName(0)) }).check();
  await dialog.getByRole("button", { name: "Expand 3 checked" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => real(page)).toEqual([A, peer(0), peer(4), peer(8)].sort());
  expect(mock.count(SYNC)).toBe(0);
  expect(mock.unhandled).toEqual([]);
});

test("undo_restores_before_pick: one Ctrl+Z takes the picked neighbours back off", async ({ page, mock }) => {
  installWorld(mock, makeWorld());
  await search(page, A);
  const dialog = page.getByRole("dialog", { name: "Expand Alice" });
  await listed(dialog, 12);
  await pickOnly(dialog, [peerName(2), peerName(5)]);
  await dialog.getByRole("button", { name: "Expand 2 checked" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => real(page)).toEqual([A, peer(2), peer(5)].sort());

  await page.keyboard.press("Control+z");
  await expect.poll(() => real(page)).toEqual([A]);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => real(page)).toEqual([A, peer(2), peer(5)].sort());
  expect(mock.unhandled).toEqual([]);
});

test("saved_picks_survive_reload: a saved workspace reopens with the same picked neighbours", async ({ page, mock }) => {
  installWorld(mock, makeWorld());
  await search(page, A);
  const dialog = page.getByRole("dialog", { name: "Expand Alice" });
  await listed(dialog, 12);
  await pickOnly(dialog, [peerName(3), peerName(7)]);
  await dialog.getByRole("button", { name: "Expand 2 checked" }).click();
  await expect(dialog).toBeHidden();
  const picked = [A, peer(3), peer(7)].sort();
  await expect.poll(() => real(page)).toEqual(picked);

  await page.getByRole("button", { name: "Workspace menu" }).click();
  await page.getByRole("menuitem", { name: "Save", exact: true }).click();
  await page.getByRole("textbox", { name: "Workspace name" }).fill("picked");
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.getByText("Workspace: Saved")).toBeVisible();
  const saved = mock.requests("POST /api/workspaces")[0]!.postDataJSON() as {
    state: { graph: { centers: string[]; picks?: Record<string, string[]> } };
  };
  expect(saved.state.graph.centers).toEqual([A]);
  expect([...saved.state.graph.picks![A]!].sort()).toEqual([peer(3), peer(7)].sort());

  // A fresh page has an empty graph until the workspace is opened; then the same nodes, and no picker.
  await page.goto("/?e2e=1");
  await expect(page.getByRole("tab", { name: "Graph" })).toBeVisible();
  const before = mock.count(GRAPH);
  await page.getByRole("button", { name: "Workspace menu" }).click();
  await page.getByRole("menuitem", { name: "Open…" }).click();
  await page.getByRole("dialog", { name: "Open workspace" }).getByRole("button", { name: "picked", exact: true }).click();
  await expect.poll(() => real(page)).toEqual(picked);
  expect(mock.count(GRAPH)).toBeGreaterThan(before);
  expect([...liveBodies(mock).at(-1)!.picks![A]!].sort()).toEqual([peer(3), peer(7)].sort());
  await expect(page.getByRole("dialog", { name: "Expand Alice" })).toHaveCount(0);
  expect(mock.unhandled).toEqual([]);
});

/**
 * The picker's controls as Tab reaches them (`presses` times, or until `until` matches one): each must be visible, and
 * a row inside the list's visible part.
 */
async function tabThrough(page: Page, dialog: Locator, presses: number, until?: (tag: string) => boolean) {
  const list = dialog.getByRole("group", { name: "Neighbours" });
  const reached: string[] = [];
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        inDialog: !!el.closest('[role="dialog"]'),
        row: el.dataset.pickRow === "1",
        tag: `${el.tagName}:${el.getAttribute("type") ?? ""}:${el.textContent?.trim().slice(0, 20) ?? ""}`,
        box: { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height },
        vw: window.innerWidth,
        vh: window.innerHeight,
      };
    });
    expect(info, "something has focus").not.toBeNull();
    expect(info!.inDialog, `focus stays in the dialog (${info!.tag})`).toBe(true);
    expect(info!.box.width * info!.box.height, `${info!.tag} has a size`).toBeGreaterThan(0);
    expect(info!.box.top, `${info!.tag} top`).toBeGreaterThanOrEqual(0);
    expect(info!.box.bottom, `${info!.tag} bottom`).toBeLessThanOrEqual(info!.vh);
    expect(info!.box.right, `${info!.tag} right`).toBeLessThanOrEqual(info!.vw);
    if (info!.row) {
      const l = (await list.boundingBox())!;
      expect(info!.box.top, "row inside the list").toBeGreaterThanOrEqual(l.y - 1);
      expect(info!.box.bottom, "row inside the list").toBeLessThanOrEqual(l.y + l.height + 1);
    }
    reached.push(info!.tag);
    if (until?.(info!.tag)) break;
  }
  return reached;
}

const isConfirm = (tag: string) => /^BUTTON:button:Expand \d+ checked/.test(tag);
/** The footer's buttons in Tab order. */
const FOOTER = ["BUTTON:button:Select none", "BUTTON:button:Restore default chec", "BUTTON:button:Cancel"];

test.describe("narrow", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("the picker at 360×740 has no sideways scroll, its confirm button is visible, and the keyboard works it", async ({ page, mock }) => {
    installWorld(mock, makeWorld(30));
    await search(page, A);
    const dialog = page.getByRole("dialog", { name: "Expand Alice" });
    await listed(dialog, 30);

    const overflow = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]') as HTMLElement;
      const list = d.querySelector(".pick__list") as HTMLElement;
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        dialog: d.scrollWidth - d.clientWidth,
        list: list.scrollWidth - list.clientWidth,
        right: d.getBoundingClientRect().right,
      };
    });
    expect(overflow.page).toBeLessThanOrEqual(0);
    expect(overflow.dialog).toBeLessThanOrEqual(0);
    expect(overflow.list).toBeLessThanOrEqual(0);
    expect(overflow.right).toBeLessThanOrEqual(360);
    const confirm = dialog.getByRole("button", { name: /^Expand \d+ checked$/ });
    await expect(confirm).toBeInViewport({ ratio: 1 });
    for (const name of ["Select none", "Restore default checks", "Cancel"]) {
      await expect(dialog.getByRole("button", { name })).toBeInViewport({ ratio: 1 });
    }

    // Tab walks the tools, then the list (one stop for its 30 rows), then the footer up to the confirm button; every
    // focus is visible and every row in the list's visible part.
    const reached = await tabThrough(page, dialog, 20, isConfirm);
    expect(reached.some((t) => t.startsWith("INPUT:search"))).toBe(true);
    expect(reached.some((t) => t.startsWith("SELECT"))).toBe(true);
    expect(reached.some((t) => t.startsWith("INPUT:number"))).toBe(true);
    expect(reached.filter((t) => t.startsWith("INPUT:checkbox"))).toHaveLength(1);
    expect(reached.slice(-4, -1)).toEqual(FOOTER);
    expect(isConfirm(reached.at(-1)!)).toBe(true);

    // Space toggles the focused row.
    await dialog.getByRole("checkbox").first().focus();
    const was = await dialog.getByRole("checkbox").first().isChecked();
    await page.keyboard.press("Space");
    await expect(dialog.getByRole("checkbox").first()).toBeChecked({ checked: !was });

    // Arrow keys go down past the list's visible part: the list scrolls along, focus stays inside it.
    const list = dialog.getByRole("group", { name: "Neighbours" });
    // A frame between presses, as key repeat leaves (~30 ms): the list renders the rows the scroll brought near.
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("ArrowDown");
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    }
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      return { row: el.dataset.pickRow === "1", text: el.closest("label")?.textContent ?? "", box: el.getBoundingClientRect().toJSON() };
    });
    expect(focused.row).toBe(true);
    expect(focused.text).toContain(peerName(20));
    const l = (await list.boundingBox())!;
    expect(focused.box.top).toBeGreaterThanOrEqual(l.y - 1);
    expect(focused.box.bottom).toBeLessThanOrEqual(l.y + l.height + 1);
    await page.keyboard.press("Space");
    await expect(dialog.getByRole("checkbox", { name: new RegExp(peerName(20)) })).toBeChecked();
    await expect(confirm).toBeInViewport({ ratio: 1 });

    // From a row deep in the list, Tab leaves it for the footer at once; Shift+Tab comes back to that row.
    const out = await tabThrough(page, dialog, 4);
    expect(out.slice(0, 3)).toEqual(FOOTER);
    expect(isConfirm(out[3]!)).toBe(true);
    for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => document.activeElement?.closest("label")?.textContent ?? "")).toContain(peerName(20));
    expect(mock.unhandled).toEqual([]);
  });

  test("the sync question's buttons are reached by Tab and work from the keyboard", async ({ page, mock }) => {
    installWorld(mock, makeWorld());
    await search(page, X);
    const dialog = page.getByRole("dialog", { name: "Expand Xavier" });
    await expect(dialog.getByText("Sync first to list its neighbours (about 6–26 calls)")).toBeVisible();
    await expect(dialog).toBeFocused();
    const reached = await tabThrough(page, dialog, 2);
    expect(reached).toEqual(["BUTTON:button:Not now", "BUTTON:button:Sync"]);
    await page.keyboard.press("Enter");
    await expect.poll(() => mock.count(SYNC)).toBe(1);
    await expect(dialog.getByText("Syncing…")).toBeVisible();
    expect(mock.unhandled).toEqual([]);
  });
});

/** Relative luminance of a CSS `rgb()`/`rgba()` colour. */
function luminance(css: string): number {
  const [r, g, b] = (css.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

/** Computed colours of the picker's surfaces and text. */
function colours(dialog: Locator) {
  return dialog.evaluate((d) => {
    const el = (sel: string) => d.querySelector(sel) as HTMLElement;
    /** The colour painted behind `e`: its own background, else the nearest ancestor's that is not transparent. */
    const bg = (e: HTMLElement | null): string => {
      for (let x = e; x; x = x.parentElement) {
        const c = getComputedStyle(x).backgroundColor;
        if (!/^rgba\(.*,\s*0\)$/.test(c) && c !== "transparent") return c;
      }
      return "rgb(255, 255, 255)";
    };
    return {
      bg: bg(d as HTMLElement),
      fg: getComputedStyle(d).color,
      row: getComputedStyle(el(".pick__label")).color,
      searchBg: bg(el(".pick__search")),
      searchFg: getComputedStyle(el(".pick__search")).color,
      selectBg: bg(el(".pick__tools select")),
      selectFg: getComputedStyle(el(".pick__tools select")).color,
    };
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`the picker is readable in the ${theme} theme`, async ({ page, mock }) => {
    await page.addInitScript((t) => localStorage.setItem("eg.theme", t), theme);
    installWorld(mock, makeWorld());
    await search(page, A);
    const dialog = page.getByRole("dialog", { name: "Expand Alice" });
    await listed(dialog, 12);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

    const c = await colours(dialog);
    // Dark surfaces in the dark theme, light ones in the light theme.
    if (theme === "dark") expect(luminance(c.bg)).toBeLessThan(0.2);
    else expect(luminance(c.bg)).toBeGreaterThan(0.6);
    // No control left with the browser's default (white field / black text) colours.
    expect(contrast(c.fg, c.bg)).toBeGreaterThan(4.5);
    expect(contrast(c.row, c.bg)).toBeGreaterThan(4.5);
    expect(contrast(c.searchFg, c.searchBg)).toBeGreaterThan(4.5);
    expect(contrast(c.selectFg, c.selectBg)).toBeGreaterThan(4.5);
    if (theme === "dark") {
      expect(luminance(c.searchBg)).toBeLessThan(0.2);
      expect(luminance(c.selectBg)).toBeLessThan(0.2);
    }
    expect(mock.unhandled).toEqual([]);
  });
}
