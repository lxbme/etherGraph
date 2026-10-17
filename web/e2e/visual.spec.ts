import type { Page } from "@playwright/test";
import { expectLaidOut, tapNode } from "./cy";
import { A, B, C, D, TX, expect, fixtures, type MockApi, test } from "./mockApi";

const THEMES = ["light", "dark"] as const;
const LOCALES = ["en", "zh"] as const;
const SIZES = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

/** Elements that must not overflow: topbar / statusbar / right panel (and its scrolling bodies) / transfers / jobs popover / kv keys. */
const CONTAINERS = [".topbar", ".statusbar", ".main__right", ".main__right-body", ".detail", ".transfers", ".jobs__popover", ".kv > dt", ".txbar", ".txdetail__tabs", ".txdetail__tabs .seg", ".txdetail__body", ".txdetail__kv"];
/** Checked too, but an intentional ellipsis (overflow hidden + title) is allowed: buttons, key/value values, job cells. */
const ELLIPSIS_OK = [".btn", ".kv > dd", ".jobs__popover td"];

/** Names of elements whose content is wider than their box (1px tolerance). */
function findOverflows(page: Page): Promise<string[]> {
  return page.evaluate(([containers, ellipsisOk]) => {
    const out: string[] = [];
    const name = (el: Element) => `${el.tagName.toLowerCase()}.${(el.className as string).toString().trim().replace(/\s+/g, ".")}[${(el.textContent ?? "").trim().slice(0, 30)}]`;
    const check = (el: Element, skipEllipsis: boolean) => {
      const h = el as HTMLElement;
      if (h.offsetParent === null && getComputedStyle(h).position !== "fixed") return; // not rendered
      if (skipEllipsis) {
        const cs = getComputedStyle(h);
        if (cs.textOverflow === "ellipsis" && cs.overflowX === "hidden" && h.hasAttribute("title")) return;
      }
      if (h.scrollWidth > h.clientWidth + 1) out.push(`${name(h)} scrollWidth=${h.scrollWidth} clientWidth=${h.clientWidth}`);
    };
    for (const sel of containers) document.querySelectorAll(sel).forEach((el) => check(el, false));
    for (const sel of ellipsisOk) document.querySelectorAll(sel).forEach((el) => check(el, true));
    return out;
  }, [CONTAINERS, ELLIPSIS_OK] as const);
}

/**
 * Long strings (40-char ENS on B, long contract name on C, long invalid_input error for D, a recent
 * job with a long error) served instead of the plain fixtures.
 */
function serveLongText(mock: MockApi) {
  const lt = fixtures.longText;
  const nodes = fixtures.graph.nodes.map((n) =>
    n.address === B ? { ...n, ens: lt.ens } : n.address === C ? { ...n, display_name: lt.contractName, contract_name: lt.contractName } : n,
  );
  mock.on("POST /api/graph/edges", () => ({ json: { ...fixtures.graph, nodes } }));
  mock.on("GET /api/address/*", (_req, url) => {
    const addr = decodeURIComponent(url.pathname.split("/").pop() ?? "").toLowerCase();
    if (addr === D) return { status: 400, json: { error: { code: "invalid_input", message: lt.invalidInput } } };
    const node = nodes.find((n) => n.address === addr);
    return node ? { json: { ...fixtures.address, node } } : { status: 404, json: { error: { code: "not_found", message: addr } } };
  });
  mock.on("GET /api/jobs", (_req, url) => ({ json: url.searchParams.get("active") === "false" ? [lt.job] : [] }));
}

/** Vertical centres of the visible top-bar controls (popover contents excluded). */
function topbarCentres(page: Page): Promise<{ name: string; cy: number }[]> {
  return page.evaluate(() => {
    const els = document.querySelectorAll(".topbar button, .topbar input, .topbar .chip, .topbar__logo");
    const res: { name: string; cy: number }[] = [];
    els.forEach((el) => {
      if (el.closest(".popover, .filter__popover")) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      res.push({ name: `${el.tagName.toLowerCase()}.${(el.className as string).toString().trim().replace(/\s+/g, ".")}`, cy: r.top + r.height / 2 });
    });
    return res;
  });
}

async function expectAligned(page: Page, when: string) {
  const c = await topbarCentres(page);
  expect(c.length, "topbar controls found").toBeGreaterThan(4);
  const min = Math.min(...c.map((x) => x.cy));
  const max = Math.max(...c.map((x) => x.cy));
  expect(max - min, `${when}: topbar vertical centres ${JSON.stringify(c)}`).toBeLessThanOrEqual(1);
}

async function expectNoOverflow(page: Page, when: string) {
  expect(await findOverflows(page), `${when}: overflowing elements`).toEqual([]);
}

for (const theme of THEMES) {
  for (const locale of LOCALES) {
    for (const size of SIZES) {
      test(`visual ${theme}-${locale}-${size.width}`, async ({ page, mock }) => {
        serveLongText(mock);
        await page.setViewportSize(size);
        await page.addInitScript(
          ([th, lo]) => {
            localStorage.setItem("eg.theme", th!);
            localStorage.setItem("eg.locale", lo!);
          },
          [theme, locale],
        );
        await page.goto("/?e2e=1");
        const search = page.getByRole("searchbox");
        await search.fill(A);
        await search.press("Enter");
        await expectLaidOut(page, "main", 4);
        const right = page.locator(".main__right");

        // Long contract name (title + key/value row).
        await tapNode(page, "main", C);
        await expect(right.locator(".detail__title")).toHaveText(fixtures.longText.contractName);
        await expectNoOverflow(page, "long contract name");

        // Long invalid_input error in the panel.
        await tapNode(page, "main", D);
        await expect(right.getByRole("alert")).toContainText(fixtures.longText.invalidInput.slice(0, 20));
        await expectNoOverflow(page, "long error");

        // 40-char ENS in the key/value grid; the key column keeps its width.
        await tapNode(page, "main", B);
        const ens = right.locator(".kv dd", { hasText: fixtures.longText.ens });
        await expect(ens).toHaveAttribute("title", fixtures.longText.ens);
        await expect(page.locator(".main__right").getByText(B, { exact: true })).toBeVisible();
        await expect(page.getByTestId("transfer-row").first()).toBeVisible();
        await expectNoOverflow(page, "node selected");
        await expectAligned(page, "node selected");

        // Jobs popover.
        await page.locator(".statusbar__jobs").click();
        await expect(page.locator(".jobs__popover")).toBeVisible();
        await expect(page.locator(".jobs__err")).toHaveAttribute("title", fixtures.longText.job.error!);
        await expectNoOverflow(page, "jobs popover");
        await page.locator(".statusbar__jobs").click();

        // Settings menu stays open for the screenshot.
        await page.locator(".topbar button[aria-haspopup=dialog]").last().click();
        await expect(page.locator(".settings")).toBeVisible();
        await expectNoOverflow(page, "settings menu");
        await expectAligned(page, "settings menu");

        await page.screenshot({ path: `test-results/visual/${theme}-${locale}-${size.width}.png` });
        // Transaction tab, Overview active: summary bar, tab group and kv grid.
        await page.keyboard.press("Escape");
        await page.locator(".settings").waitFor({ state: "hidden" }).catch(() => {});
        await search.fill(TX);
        await search.press("Enter");
        const txView = page.getByTestId("tx-view");
        await expect(txView.getByTestId("tx-summary-bar")).toBeVisible();
        await expectLaidOut(page, { tx: TX }, 3);
        const tabGroup = txView.locator(".txdetail__tabs .seg");
        await expect(tabGroup.getByRole("button").first()).toHaveAttribute("aria-pressed", "true");
        await expect(txView.locator(".txdetail__kv")).toBeVisible();
        await expectNoOverflow(page, "tx tab");
        await expectAligned(page, "tx tab");
        await page.screenshot({ path: `test-results/visual/tx-${theme}-${locale}-${size.width}.png` });

        expect(mock.unhandled).toEqual([]);
      });
    }
  }
}
