import { expect, test } from "./mockApi";

test.use({ tourDone: false });

test("first load shows the tour; Next/Done finishes it; reload shows none", async ({ page, mock }) => {
  await page.goto("/?e2e=1");
  const tour = page.getByRole("dialog", { name: "Search an address" });
  await expect(tour).toBeVisible();
  await expect(tour.getByRole("button", { name: "Next" })).toBeFocused();
  await tour.getByRole("button", { name: "Next" }).click();
  const legend = page.getByRole("dialog", { name: "Legend" });
  // The legend only exists with a graph; without one the step is skipped to Help.
  const help = page.getByRole("dialog", { name: "Help" });
  await expect(legend.or(help)).toBeVisible();
  if (await legend.isVisible()) await legend.getByRole("button", { name: "Next" }).click();
  await expect(help).toBeVisible();
  await help.getByRole("button", { name: "Done" }).click();
  await expect(page.locator(".tour__bubble")).toHaveCount(0);

  await page.reload();
  await page.waitForTimeout(1000);
  await expect(page.locator(".tour__bubble")).toHaveCount(0);
  expect(mock.unhandled).toEqual([]);
});

test("Help → Replay tour restarts it with focus on Next", async ({ page, mock }) => {
  await page.addInitScript(() => localStorage.setItem("eg.tour.done", "1"));
  await page.goto("/?e2e=1");
  await page.getByRole("button", { name: "Help", exact: true }).click();
  await page.getByRole("button", { name: "Replay tour" }).click();
  const tour = page.getByRole("dialog", { name: "Search an address" });
  await expect(tour).toBeVisible();
  await expect(tour.getByRole("button", { name: "Next" })).toBeFocused();
  expect(mock.unhandled).toEqual([]);
});
