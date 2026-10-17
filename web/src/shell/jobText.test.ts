import type { JobDto } from "../api/generated/JobDto";
import { kindName, progressText, statusName } from "./jobText";

test("job kinds and statuses are localised", () => {
  expect(kindName("resolve_names")).toBe("ENS resolve");
  expect(statusName("paused_quota")).toBe("Quota paused");
});

test("values outside the DTO union (a newer server) are shown raw", () => {
  expect(kindName("future_kind" as JobDto["kind"])).toBe("future_kind");
  expect(kindName("toString" as JobDto["kind"])).toBe("toString");
  expect(statusName("archived" as JobDto["status"])).toBe("archived");
});

test("fetched counts are grouped", () => {
  const e = { type: "JobProgress", job_id: 1, kind: "sync_address", fetched: 12345, cursor_block: null, status: "running", error: null } as const;
  expect(progressText(e)).toBe("Sync · 12,345 fetched");
});
