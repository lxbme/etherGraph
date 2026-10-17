import type { Page } from "@playwright/test";
import { expectLaidOut, tapNode } from "./cy";
import { A, D, expect, test } from "./mockApi";

/** No horizontal page scroll, and the element is fully inside the viewport. */
async function expectFits(page: Page, what: string, box: { x: number; width: number } | null) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, "no horizontal page scroll").toBeLessThanOrEqual(client);
  expect(box, what).not.toBeNull();
  expect(box!.x, `${what} left`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${what} right`).toBeLessThanOrEqual(client);
}

test.use({ viewport: { width: 380, height: 800 } });

test("at 380px the top bar fits and selecting a node opens the detail overlay", async ({ page, mock }) => {
  await page.goto("/?e2e=1");
  for (const name of ["Search"]) await expectFits(page, name, await page.getByRole("searchbox", { name }).boundingBox());
  for (const name of [/Filter/, "Workspace menu", "Details"]) {
    await expectFits(page, String(name), await page.getByRole("button", { name }).boundingBox());
  }
  // The detail panel starts closed on narrow screens.
  await expect(page.locator(".main__right")).toHaveCount(0);

  await page.getByRole("searchbox", { name: "Search" }).fill(A);
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");
  // Searching selects the address: the overlay opens with its detail.
  await expect(page.locator(".main__right")).toBeVisible();
  await page.getByRole("button", { name: "Details" }).click();
  await expect(page.locator(".main__right")).toHaveCount(0);
  await expectLaidOut(page, "main", 4);

  await tapNode(page, "main", D);
  await expect(page.locator(".main__right")).toBeVisible();
  await expect(page.locator(".main__right").getByText(D, { exact: true })).toBeVisible();

  // Popovers stay on screen too.
  await page.getByRole("button", { name: /Filter/ }).click();
  await expectFits(page, "filter popover", await page.getByRole("dialog", { name: "Filter" }).boundingBox());
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Workspace menu" }).click();
  await expectFits(page, "workspace menu", await page.getByRole("menu").boundingBox());
  expect(mock.unhandled).toEqual([]);
});
