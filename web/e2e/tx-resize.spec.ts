import type { Locator, Page } from "@playwright/test";
import { expectLaidOut } from "./cy";
import { TX, expect, fixtures, test } from "./mockApi";

const SEPARATOR = "Resize the details panel height";

async function openTx(page: Page) {
  await page.goto("/?e2e=1");
  await page.getByRole("searchbox", { name: "Search" }).fill(TX);
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");
  await expect(page.getByRole("tab", { name: /^Tx 0x7e57/ })).toHaveAttribute("aria-selected", "true");
  await expectLaidOut(page, { tx: TX }, 3);
}

/** Whether the topmost element at the centre of `target` is `target` itself (or inside it). */
async function onTop(target: Locator): Promise<boolean> {
  const box = (await target.boundingBox())!;
  return target.evaluate(
    (el, p) => {
      const hit = document.elementFromPoint(p.x, p.y);
      return !!hit && (hit === el || el.contains(hit));
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
}

/** Nothing covers the separator or the detail tabs, and both still work with the mouse. */
async function expectSeparatorAndTabsReachable(page: Page) {
  const txView = page.getByTestId("tx-view");
  const sep = txView.getByRole("separator", { name: SEPARATOR });
  const tabs = txView.getByRole("group", { name: "Transaction details" });
  const overview = tabs.getByRole("button", { name: "Overview" });
  const input = tabs.getByRole("button", { name: "Input" });

  expect(await onTop(sep), "the separator is not covered").toBe(true);
  expect(await onTop(overview), "the Overview tab is not covered").toBe(true);
  // The view above ends at the separator.
  const stage = (await txView.locator(".split__top").boundingBox())!;
  const handle = (await sep.boundingBox())!;
  expect(stage.y + stage.height).toBeLessThanOrEqual(handle.y + 0.5);

  await input.click();
  await expect(input).toHaveAttribute("aria-pressed", "true");
  await overview.click();
  await expect(overview).toHaveAttribute("aria-pressed", "true");

  // A mouse drag on the separator still moves it: down (shorter panel), or up when already at its 120 px minimum.
  const bottom = txView.locator(".split__bottom");
  const before = (await bottom.boundingBox())!.height;
  const dy = before > 121 ? 40 : -40;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 + dy, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await bottom.boundingBox())!.height).not.toBe(before);
}

/** The canvas tools' Export menu opens over the panel and its last item ("File…") can be clicked. */
async function expectExportMenuReachable(page: Page) {
  const txView = page.getByTestId("tx-view");
  const tools = txView.locator(".canvas-tools:visible");
  await tools.getByRole("button", { name: "Export" }).click();
  const file = page.getByRole("menuitem", { name: "File…" });
  await expect(file).toBeVisible();
  expect(await onTop(file), "the Export menu's File… item is not covered").toBe(true);
  await page.keyboard.press("Escape");
  await expect(file).toBeHidden();
}

test("the detail panel maximised with the keyboard never covers its separator or tabs, also after a reload", async ({ page, mock }) => {
  mock.on("GET /api/tx/*/trace", () => ({ json: fixtures.trace }));
  await openTx(page);
  const txView = page.getByTestId("tx-view");
  const sep = txView.getByRole("separator", { name: SEPARATOR });
  await sep.focus();
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowUp");
  // The view above keeps its minimum (switch, banner and some graph).
  expect((await txView.locator(".split__top").boundingBox())!.height).toBeGreaterThanOrEqual(199);
  await expectSeparatorAndTabsReachable(page);

  // Maximised again and remembered: still reachable after a reload, in both views.
  await sep.focus();
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowUp");
  expect(Number(await page.evaluate(() => localStorage.getItem("ethergraph.txDetailHeight")))).toBeGreaterThan(400);
  await openTx(page);
  await expectSeparatorAndTabsReachable(page);
  await txView.getByRole("group", { name: "Transaction view" }).getByRole("button", { name: "Call tree" }).click();
  await expect(txView.getByRole("tree", { name: "Call tree" }).getByRole("treeitem")).toHaveCount(9);
  await sep.focus();
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowUp");
  await expectSeparatorAndTabsReachable(page);

  expect(mock.unhandled).toEqual([]);
});

test("with the view above at its minimum the Export menu still opens over the panel, in both views", async ({ page, mock }) => {
  mock.on("GET /api/tx/*/trace", () => ({ json: fixtures.trace }));
  await page.addInitScript(() => localStorage.setItem("ethergraph.txDetailHeight", "5000"));
  await openTx(page);
  const txView = page.getByTestId("tx-view");
  // The remembered height squeezes the view above to its 200 px minimum, so the menu reaches below the separator.
  expect((await txView.locator(".split__top").boundingBox())!.height).toBeLessThan(210);
  await expectExportMenuReachable(page);
  await txView.getByRole("group", { name: "Transaction view" }).getByRole("button", { name: "Call tree" }).click();
  await expect(txView.getByRole("tree", { name: "Call tree" }).getByRole("treeitem")).toHaveCount(9);
  await expectExportMenuReachable(page);
  expect(mock.unhandled).toEqual([]);
});

for (const [width, height] of [
  [1000, 560],
  [700, 560],
] as const) {
  test(`at ${width}×${height} a large remembered detail height covers nothing, in both views`, async ({ page, mock }) => {
    mock.on("GET /api/tx/*/trace", () => ({ json: fixtures.trace }));
    await page.setViewportSize({ width, height });
    await page.addInitScript(() => localStorage.setItem("ethergraph.txDetailHeight", "5000"));
    await openTx(page);
    await expectSeparatorAndTabsReachable(page);

    const txView = page.getByTestId("tx-view");
    await txView.getByRole("group", { name: "Transaction view" }).getByRole("button", { name: "Call tree" }).click();
    await expect(txView.getByRole("tree", { name: "Call tree" }).getByRole("treeitem").first()).toBeAttached();
    // The tree column (beside the graph, or under it when stacked) ends above the separator.
    const side = (await txView.locator(".rside__side").boundingBox())!;
    const sep = (await txView.getByRole("separator", { name: SEPARATOR }).boundingBox())!;
    expect(side.y + side.height).toBeLessThanOrEqual(sep.y + 0.5);
    await expectSeparatorAndTabsReachable(page);

    expect(mock.unhandled).toEqual([]);
  });
}

const RECIPIENT = "0xa11ce00000000000000000000000000000000001";
const erc20 = (n: number, amount: string, decimals: number, symbol: string) => ({
  seq: 10 + n, from: "0xb0b0000000000000000000000000000000000002", to: RECIPIENT,
  asset: `0x${String(n).repeat(40)}`, amount, token_id: null, kind: "erc20" as const, trace_path: null, log_index: n,
  decimals, symbol, trust: { level: "listed" as const, impersonates: null, reason: null },
});
const HUGE = (2n ** 256n - 1n).toString();
/** Extra token flows (they sort before the fixture's own USDT transfer). */
const DATASETS: Record<string, ReturnType<typeof erc20>[]> = {
  "four long amounts": [1, 2, 3, 4].map((n) => erc20(n, HUGE, 18, `LONGSYMBOL${n}`)),
  // Long enough that two lines side by side must squeeze, short enough that each keeps part of its recipient's room.
  "four mid-length amounts": [1, 2, 3, 4].map((n) => erc20(n, "123456789012345678901234", 18, `TOKEN${n}`)),
  "a swap": [erc20(1, "4699465952", 6, "USDC"), erc20(2, "1500000000000000000", 18, "WETH")],
  "an unknown token with a very long symbol": [erc20(1, "4699465952", 6, "AVERYLONGUNKNOWNTOKENSYMBOLTHATGOESON")],
};

for (const [width, height] of [
  [1000, 560],
  [360, 740],
  [1440, 900],
  [1920, 1080],
] as const) {
  for (const [name, extra] of Object.entries(DATASETS)) {
    test(`at ${width}×${height} ${name} leave the graph area above 100 px and the first transfer readable`, async ({ page, mock }) => {
      const tx = { ...fixtures.tx, flow: { ...fixtures.tx.flow!, flows: [...fixtures.tx.flow!.flows, ...extra] } };
      mock.on("GET /api/tx/*", () => ({ json: tx }));
      mock.on("GET /api/tx/*/trace", () => ({ json: fixtures.trace }));
      await page.setViewportSize({ width, height });
      await page.goto("/?e2e=1");
      await page.getByRole("searchbox", { name: "Search" }).fill(TX);
      await page.getByRole("searchbox", { name: "Search" }).press("Enter");
      const bar = page.getByTestId("tx-summary-bar");
      await expect(bar.getByTestId("tx-summary-transfer").first()).toBeVisible();
      // The transfers add at most one line, and nothing in the bar spills sideways.
      expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await expect.poll(async () => (await page.getByTestId("tx-view").locator(".txview__graph").boundingBox())!.height).toBeGreaterThan(100);
      await expectFirstTransferReadable(page);
      await expectNoTransferPieceCut(page);
      await expectTransferTabStopsVisible(page);
      expect(mock.unhandled).toEqual([]);
    });
  }
}

/**
 * Every displayed transfer line (and the "+N" button) shows each of its pieces whole or not at all: nothing is cut by
 * the box that clips it, the address name is never shortened, the "Transfer" label is whole or ends in an ellipsis,
 * and the arrow and the address buttons never show without the address they belong to.
 */
async function expectNoTransferPieceCut(page: Page) {
  const area = page.getByTestId("tx-summary-bar").locator(".txbar__transfers");
  await expect
    .poll(async () =>
      area.evaluate((root) => {
        const bad: string[] = [];
        /** The part of `el` left on screen by its clipping ancestors up to the transfers area: "whole", "none" or "cut". */
        const shown = (el: Element): "whole" | "none" | "cut" => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return "none";
          let [left, top, right, bottom] = [r.left, r.top, r.right, r.bottom];
          for (let a = el.parentElement; a; a = a.parentElement) {
            if (getComputedStyle(a).overflow !== "visible") {
              const c = a.getBoundingClientRect();
              [left, top, right, bottom] = [Math.max(left, c.left), Math.max(top, c.top), Math.min(right, c.right), Math.min(bottom, c.bottom)];
            }
            if (a === root) break;
          }
          if (right - left <= 0.5 || bottom - top <= 0.5) return "none";
          return right - left >= r.width - 0.5 && bottom - top >= r.height - 0.5 ? "whole" : "cut";
        };
        const lines = [...root.querySelectorAll<HTMLElement>(".txbar__transfer")].filter((l) => shown(l) !== "none");
        lines.forEach((line, i) => {
          const tag = (what: string) => `line ${i + 1} ${what}`;
          const label = line.querySelector<HTMLElement>(".txbar__transfer-label")!;
          const labelShown = shown(label);
          if (labelShown === "cut") bad.push(tag("label cut"));
          if (labelShown === "whole" && label.scrollWidth > label.clientWidth + 1 && getComputedStyle(label).textOverflow !== "ellipsis")
            bad.push(tag("label clipped without an ellipsis"));
          for (const sel of [".txbar__amt", ".asset-link", ".txbar__sym", ".tag"]) {
            const el = line.querySelector(sel);
            if (el && shown(el) === "cut") bad.push(tag(`${sel} cut`));
          }
          const to = line.querySelector<HTMLElement>(".txbar__to")!;
          const name = to.querySelector<HTMLElement>(".addr-cell__name")!;
          const nameShown = shown(name);
          if (nameShown === "cut") bad.push(tag("address cut"));
          if (nameShown === "whole" && name.scrollWidth > name.clientWidth + 1) bad.push(tag("address shortened"));
          for (const el of [to.querySelector(".txbar__arrow")!, ...to.querySelectorAll("button")]) {
            const s = shown(el);
            if (s === "cut") bad.push(tag(`recipient ${el.getAttribute("aria-label") ?? "arrow"} cut`));
            if (s === "whole" && nameShown !== "whole") bad.push(tag(`recipient ${el.getAttribute("aria-label") ?? "arrow"} without its address`));
          }
        });
        for (const more of root.querySelectorAll(".txbar__more")) if (shown(more) === "cut") bad.push("+N button cut");
        return bad;
      }),
    { message: "no transfer piece is partly hidden", timeout: 5000 })
    .toEqual([]);
}

/**
 * Tabbing through the transfers area stops only on what is fully on screen (the line clips its recipient whole, so the
 * recipient offers no copy / add buttons to land on), and focus does leave the area again.
 */
async function expectTransferTabStopsVisible(page: Page) {
  const area = page.getByTestId("tx-summary-bar").locator(".txbar__transfers");
  await expect(area.getByRole("button", { name: /^(Copy|Add to graph)$/ })).toHaveCount(0);
  // Start from the bar's last focusable control before the transfers area.
  await area.evaluate((root) => {
    const before = [...root.closest(".txbar")!.querySelectorAll<HTMLElement>("button, a[href], [tabindex]")].filter(
      (el) => !!(root.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) && el.getClientRects().length > 0,
    );
    before.at(-1)!.focus();
  });
  const stops: string[] = [];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const stop = await area.evaluate((root) => {
      const el = document.activeElement;
      if (!el || !root.contains(el)) return null;
      const r = el.getBoundingClientRect();
      let [left, top, right, bottom] = [r.left, r.top, r.right, r.bottom];
      for (let a = el.parentElement; a && a !== root.parentElement; a = a.parentElement) {
        if (getComputedStyle(a).overflow === "visible") continue;
        const c = a.getBoundingClientRect();
        [left, top, right, bottom] = [Math.max(left, c.left), Math.max(top, c.top), Math.min(right, c.right), Math.min(bottom, c.bottom)];
      }
      const whole = r.width > 0 && r.height > 0 && right - left >= r.width - 0.5 && bottom - top >= r.height - 0.5;
      return `${el.getAttribute("aria-label") ?? el.textContent}: ${whole ? "whole" : "not whole"}`;
    });
    if (stop === null) {
      if (stops.length > 0) break;
      continue;
    }
    stops.push(stop);
  }
  expect(stops.length, "Tab reaches the transfers area").toBeGreaterThan(0);
  expect(stops.filter((s) => !s.endsWith(": whole")), `tab stops ${JSON.stringify(stops)}`).toEqual([]);
}

/**
 * The first transfer line keeps its amount and symbol on screen once the layout has settled: inside the row that clips
 * them, the symbol whole (or ending in an ellipsis at its cap), and the amount untruncated whenever the recipient shows.
 */
async function expectFirstTransferReadable(page: Page) {
  const line = page.getByTestId("tx-summary-transfer").first();
  await expect
    .poll(async () => {
      const m = await line.evaluate((row) => {
        const area = row.closest(".txbar__transfers")!.getBoundingClientRect();
        const rr = row.getBoundingClientRect();
        const limit = Math.min(area.right, rr.right);
        const box = (sel: string) => {
          const el = row.querySelector<HTMLElement>(sel)!;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return { el, width: r.width, right: r.right, scroll: el.scrollWidth, client: el.clientWidth, cap: cs.maxWidth, ellipsis: cs.textOverflow === "ellipsis" };
        };
        const amt = box(".txbar__amt");
        const sym = box(".asset-link");
        const to = row.querySelector<HTMLElement>(".txbar__to")!.getBoundingClientRect().width;
        return {
          amtInside: amt.width > 0 && amt.right <= limit + 0.5,
          symInside: sym.width > 0 && sym.right <= limit + 0.5,
          // Whole, or deliberately ellipsised (its own scroll width exceeds its box) - never cut by an ancestor.
          symWhole: sym.scroll <= sym.client + 1 || sym.ellipsis,
          amtWhole: to === 0 || amt.scroll <= amt.client + 1,
        };
      });
      return JSON.stringify(m);
    }, { message: "first transfer's amount and symbol are readable", timeout: 5000 })
    .toBe(JSON.stringify({ amtInside: true, symInside: true, symWhole: true, amtWhole: true }));
}

test("at 1000×560 a single transfer still shows its amount and symbol", async ({ page, mock }) => {
  mock.on("GET /api/tx/*/trace", () => ({ json: fixtures.trace }));
  await page.setViewportSize({ width: 1000, height: 560 });
  await openTx(page);
  await expectFirstTransferReadable(page);
  await expectNoTransferPieceCut(page);
  await expectTransferTabStopsVisible(page);
  await expect(page.getByTestId("tx-summary-transfer").first().locator(".txbar__amt")).toHaveText("6,400");
  expect(mock.unhandled).toEqual([]);
});
