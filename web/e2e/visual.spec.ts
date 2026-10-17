import type { Page } from "@playwright/test";
import { expectLaidOut, tapNode } from "./cy";
import { A, B, expect, test } from "./mockApi";

const THEMES = ["light", "dark"] as const;
const LOCALES = ["en", "zh"] as const;
const SIZES = [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

/** Elements that must not overflow: real selectors for topbar / statusbar / right panel / transfers, plus every .btn. */
const CONTAINERS = [".topbar", ".statusbar", ".main__right", ".transfers"];

/** Names of elements whose content is wider than their box (1px tolerance). Intentional ellipsis (overflow hidden + title) is skipped for buttons. */
function findOverflows(page: Page): Promise<string[]> {
  return page.evaluate((containers) => {
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
    document.querySelectorAll(".btn").forEach((el) => check(el, true));
    return out;
  }, CONTAINERS);
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
        await tapNode(page, "main", B);
        await expect(page.locator(".main__right").getByText(B, { exact: true })).toBeVisible();
        await expect(page.getByTestId("transfer-row").first()).toBeVisible();
        await expectNoOverflow(page, "node selected");
        await expectAligned(page, "node selected");

        // Jobs popover.
        await page.locator(".statusbar__jobs").click();
        await expect(page.locator(".jobs__popover")).toBeVisible();
        await expectNoOverflow(page, "jobs popover");
        await page.locator(".statusbar__jobs").click();

        // Settings menu stays open for the screenshot.
        await page.locator(".topbar button[aria-haspopup=dialog]").last().click();
        await expect(page.locator(".settings")).toBeVisible();
        await expectNoOverflow(page, "settings menu");
        await expectAligned(page, "settings menu");

        await page.screenshot({ path: `test-results/visual/${theme}-${locale}-${size.width}.png` });
        expect(mock.unhandled).toEqual([]);
      });
    }
  }
}
