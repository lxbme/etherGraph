import type { Page } from "@playwright/test";
import type { CallTraceResponseDto } from "../src/api/generated/CallTraceResponseDto";
import { expectLaidOut } from "./cy";
import { TX, expect, fixtures, notFound, test } from "./mockApi";

type Core = import("cytoscape").Core;

const TRACE = "GET /api/tx/*/trace";
/** ENS registration (fixtures/trace-ens.json): the controller calls the NameWrapper once, frame [3]. */
const CONTROLLER = "0x253553366da8546fc250f225fe3d25d0c782303b";
const NAME_WRAPPER = "0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401";
const JOB = 41;
const pending: CallTraceResponseDto = { status: "pending", frames: null, job_id: JOB, undecoded: [] };

/** The call graph's edges, through the `?e2e=1` hook (null before it is drawn). */
function callEdges(page: Page) {
  return page.evaluate((tx) => {
    const cy = (window as unknown as { __etherGraphCallCy?: Record<string, Core> }).__etherGraphCallCy?.[tx];
    if (!cy || cy.destroyed()) return null;
    return cy.edges().map((e) => ({ id: e.id(), label: String(e.data("label")), highlighted: e.hasClass("highlighted") }));
  }, TX);
}

/** Emits a `tap` on a call-graph edge, as a click on it would. */
async function tapCallEdge(page: Page, id: string): Promise<void> {
  const ok = await page.evaluate(
    ({ tx, id }) => {
      const cy = (window as unknown as { __etherGraphCallCy?: Record<string, Core> }).__etherGraphCallCy?.[tx];
      const e = cy?.$id(id);
      if (!e || e.empty()) return false;
      e.emit("tap");
      return true;
    },
    { tx: TX, id },
  );
  expect(ok, `call edge ${id} exists`).toBe(true);
}

/** Remembers each blob the page turns into a download URL; `lastBlobText` reads the latest. */
function catchBlobs(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __lastBlob?: Blob; __origCreate?: typeof URL.createObjectURL };
    w.__origCreate ??= URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b: Blob | MediaSource) => {
      w.__lastBlob = b as Blob;
      return w.__origCreate!(b);
    };
  });
}
const lastBlobText = (page: Page) => page.evaluate(() => (window as unknown as { __lastBlob: Blob }).__lastBlob.text());

async function openTx(page: Page) {
  await page.goto("/?e2e=1");
  await page.getByRole("searchbox", { name: "Search" }).fill(TX);
  await page.getByRole("searchbox", { name: "Search" }).press("Enter");
  await expect(page.getByRole("tab", { name: /^Tx 0x7e57/ })).toHaveAttribute("aria-selected", "true");
  await expectLaidOut(page, { tx: TX }, 3);
}

test("call tree: fetched once opened, graph and tree linked, saved with the workspace and carried in its file", async ({ page, mock }) => {
  let traced = false;
  mock.on(TRACE, () => ({ json: traced ? fixtures.trace : pending }));
  await openTx(page);
  expect(mock.count(TRACE)).toBe(0);

  const txView = page.getByTestId("tx-view");
  const views = txView.getByRole("group", { name: "Transaction view" });
  await views.getByRole("button", { name: "Call tree" }).click();
  await expect(views.getByRole("button", { name: "Call tree" })).toHaveAttribute("aria-pressed", "true");
  await expect(txView.getByText("Fetching call trace…")).toBeVisible();
  await expect.poll(() => mock.count(TRACE)).toBeGreaterThan(0);

  // The server's fetch job reports in, then the trace is ready.
  await mock.pushEvents([
    { type: "JobProgress", job_id: JOB, kind: "fetch_trace", fetched: 0, cursor_block: null, status: "pending", error: null },
  ]);
  await expect(txView.getByText("Call trace queued…")).toBeVisible();
  traced = true;
  await mock.pushEvents([{ type: "TraceReady", hash: TX }]);

  const tree = txView.getByRole("tree", { name: "Call tree" });
  const rows = tree.getByRole("treeitem");
  // Read-only calls are hidden: 9 of the 17 frames.
  await expect(rows).toHaveCount(9);

  // The controller → NameWrapper edge carries the decoded method; tapping it selects its call in the tree.
  const edgeId = `${CONTROLLER}>${NAME_WRAPPER}`;
  await expect.poll(async () => (await callEdges(page))?.find((e) => e.id === edgeId)?.label).toContain("registerAndWrapETH2LD");
  await tapCallEdge(page, edgeId);
  const row = tree.locator('[data-frame="3"]');
  await expect(row).toHaveAttribute("aria-selected", "true");
  await expect(row).toContainText("registerAndWrapETH2LD");
  await expect(tree.getByRole("treeitem", { selected: true })).toHaveCount(1);
  await expect.poll(async () => (await callEdges(page))?.find((e) => e.id === edgeId)?.highlighted).toBe(true);

  await txView.getByRole("checkbox", { name: "Show read-only calls" }).check();
  await expect(rows).toHaveCount(17);

  // Save: the tab is stored on the call tree.
  await page.getByRole("button", { name: "Workspace menu" }).click();
  await page.getByRole("menuitem", { name: "Save", exact: true }).click();
  await page.getByRole("textbox", { name: "Workspace name" }).fill("calls");
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.getByText("Workspace: Saved")).toBeVisible();
  const body = mock.requests("POST /api/workspaces")[0]!.postDataJSON() as { state: { tabs: { hash: string; view?: string }[] } };
  expect(body.state.tabs).toEqual([expect.objectContaining({ hash: TX, view: "calls" })]);

  // Reopened on a fresh page, the tab opens on the call tree.
  await page.goto("/?e2e=1");
  await expect(page.getByRole("tab", { name: /^Tx 0x7e57/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Workspace menu" }).click();
  await page.getByRole("menuitem", { name: "Open…" }).click();
  await page.getByRole("dialog", { name: "Open workspace" }).getByRole("button", { name: "calls", exact: true }).click();
  await expect(page.getByRole("tab", { name: /^Tx 0x7e57/ })).toHaveAttribute("aria-selected", "true");
  await expect(views.getByRole("button", { name: "Call tree" })).toHaveAttribute("aria-pressed", "true");
  await expect(rows).toHaveCount(9);

  // The workspace file carries the cached trace.
  await catchBlobs(page);
  await page.getByRole("button", { name: "Workspace menu" }).click();
  await page.getByRole("menuitem", { name: "Export workspace file…" }).click();
  const dialog = page.getByRole("dialog", { name: "Export file" });
  const [dl] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Export" }).click()]);
  const file = JSON.parse(await lastBlobText(page)) as {
    kind: string;
    state: { tabs: { hash: string; view?: string; snapshot: { trace?: unknown[] } }[] };
  };
  expect(file.kind).toBe("workspace");
  expect(file.state.tabs).toHaveLength(1);
  expect(file.state.tabs[0]).toMatchObject({ hash: TX, view: "calls" });
  expect(file.state.tabs[0]!.snapshot.trace).toHaveLength(17);

  // Opened where nothing is known of the tx: the tree comes from the file, nothing is requested.
  mock.on("GET /api/tx/*", () => notFound("unknown transaction"));
  mock.on(TRACE, () => notFound("unknown transaction"));
  await page.goto("/?e2e=1");
  const traceRequests = mock.count(TRACE);
  await page.getByRole("button", { name: "Workspace menu" }).click();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("menuitem", { name: "Import file…" }).click()]);
  await chooser.setFiles((await dl.path())!);
  await expect(page.getByRole("tab", { name: /^Tx 0x7e57/ })).toHaveAttribute("aria-selected", "true");
  await expect(txView.getByTestId("snapshot-banner")).toBeVisible();
  await expect(rows).toHaveCount(9);
  expect(mock.count(TRACE)).toBe(traceRequests);

  expect(mock.unhandled).toEqual([]);
});

/** A call-graph node's model position and its page position (null before it is drawn). */
function callNode(page: Page, id: string) {
  return page.evaluate(
    ({ tx, id }) => {
      const cy = (window as unknown as { __etherGraphCallCy?: Record<string, Core> }).__etherGraphCallCy?.[tx];
      const n = cy?.$id(id);
      if (!cy || cy.destroyed() || !n || n.empty() || cy.width() < 100) return null;
      const r = cy.container()!.getBoundingClientRect();
      const rp = n.renderedPosition();
      return { model: { ...n.position() }, page: { x: r.left + rp.x, y: r.top + rp.y } };
    },
    { tx: TX, id },
  );
}

test("dragged call-graph nodes stay through view switches and filters, and are saved with the workspace", async ({ page, mock }) => {
  mock.on(TRACE, () => ({ json: fixtures.trace }));
  await openTx(page);
  const txView = page.getByTestId("tx-view");
  const views = txView.getByRole("group", { name: "Transaction view" });
  const rows = txView.getByRole("tree", { name: "Call tree" }).getByRole("treeitem");
  await page.getByRole("button", { name: "Workspace menu" }).click();
  await page.getByRole("menuitem", { name: "Save", exact: true }).click();
  await page.getByRole("textbox", { name: "Workspace name" }).fill("call layout");
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.getByText("Workspace: Saved")).toBeVisible();

  await views.getByRole("button", { name: "Call tree" }).click();
  await expect(rows).toHaveCount(9);
  await expect.poll(() => callNode(page, CONTROLLER)).not.toBeNull();
  // Let the first layout and fit settle before grabbing.
  await page.waitForTimeout(900);
  const before = (await callNode(page, CONTROLLER))!;
  await page.mouse.move(before.page.x, before.page.y);
  await page.mouse.down();
  await page.mouse.move(before.page.x + 60, before.page.y + 40, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await callNode(page, CONTROLLER))?.model.x).not.toBe(before.model.x);
  const dragged = (await callNode(page, CONTROLLER))!.model;
  await expect(page.getByText("Workspace: Unsaved changes")).toBeVisible();

  // The call canvas is unmounted while the asset flow shows; back on the call tree the node is where it was left.
  await views.getByRole("button", { name: "Asset flow" }).click();
  await expect.poll(() => callNode(page, CONTROLLER)).toBeNull();
  await views.getByRole("button", { name: "Call tree" }).click();
  await expect.poll(async () => (await callNode(page, CONTROLLER))?.model).toEqual(dragged);
  // Showing the read-only calls lays out the new parties around it.
  await txView.getByRole("checkbox", { name: "Show read-only calls" }).check();
  await expect(rows).toHaveCount(17);
  await expect.poll(async () => (await callNode(page, CONTROLLER))?.model).toEqual(dragged);

  await page.getByRole("button", { name: "Workspace menu" }).click();
  await page.getByRole("menuitem", { name: "Save", exact: true }).click();
  await expect(page.getByText("Workspace: Saved")).toBeVisible();
  const reqs = mock.requests("PUT /api/workspaces/*");
  const body = reqs[reqs.length - 1]!.postDataJSON() as {
    state: { tabs: { hash: string; call_positions?: Record<string, { x: number; y: number }> }[] };
  };
  expect(body.state.tabs[0]!.call_positions?.[CONTROLLER]).toEqual(dragged);

  // Reopened on a fresh page, the call graph puts the node at its saved position.
  await page.goto("/?e2e=1");
  await page.getByRole("button", { name: "Workspace menu" }).click();
  await page.getByRole("menuitem", { name: "Open…" }).click();
  await page.getByRole("dialog", { name: "Open workspace" }).getByRole("button", { name: "call layout", exact: true }).click();
  await expect(views.getByRole("button", { name: "Call tree" })).toHaveAttribute("aria-pressed", "true");
  await expect(rows).toHaveCount(9);
  await expect.poll(async () => (await callNode(page, CONTROLLER))?.model).toEqual(dragged);
  await expect(page.getByText("Workspace: Saved")).toBeVisible();

  expect(mock.unhandled).toEqual([]);
});

test("viewing and exporting only the asset flow never requests a call trace", async ({ page, mock }) => {
  await openTx(page);
  const txView = page.getByTestId("tx-view");
  await expect(txView.getByRole("group", { name: "Transaction view" }).getByRole("button", { name: "Asset flow" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await txView.getByTestId("tx-detail").getByRole("button", { name: "Internal Calls" }).click();

  await catchBlobs(page);
  await txView.getByRole("toolbar", { name: "Canvas tools" }).getByRole("button", { name: "Export" }).click();
  await page.getByRole("menu", { name: "Export" }).getByRole("menuitem", { name: "File…" }).click();
  const dialog = page.getByRole("dialog", { name: "Export file" });
  await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", { name: "Export" }).click()]);
  const file = JSON.parse(await lastBlobText(page)) as { state: { tabs: { snapshot: object }[] } };
  expect(file.state.tabs[0]!.snapshot).not.toHaveProperty("trace");

  expect(mock.count(TRACE)).toBe(0);
  expect(mock.unhandled).toEqual([]);
});
