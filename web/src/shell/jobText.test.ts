import type { JobDto } from "../api/generated/JobDto";
import { useLocale } from "../i18n";
import { shortAddr } from "../lib/address";
import { kindName, progressText, statusName, targetText } from "./jobText";

test("job kinds and statuses are localised", () => {
  expect(kindName("resolve_names")).toBe("ENS resolve");
  expect(statusName("paused_quota")).toBe("Quota paused");
  expect(statusName("paused_user_quota")).toBe("Waiting for tomorrow's quota");
});

test("a job over its user's quota reads as waiting for tomorrow in Chinese too", () => {
  useLocale.getState().setLocale("zh");
  try {
    expect(statusName("paused_user_quota")).toBe("等待明日额度");
  } finally {
    useLocale.getState().setLocale("en");
  }
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

test("an NFT metadata fetch is named and targets its token and id", () => {
  expect(kindName("fetch_nft")).toBe("Fetch NFT metadata");
  const token = "0x" + "a7".repeat(20);
  expect(targetText({ kind: "fetch_nft", params: { token, token_id: "7" } })).toBe(`${shortAddr(token)} #7`);
  expect(targetText({ kind: "fetch_nft", params: {} })).toBe("—");
});

test("a call-trace fetch is named and targets its transaction", () => {
  expect(kindName("fetch_trace")).toBe("Fetch call trace");
  const hash = "0x461e681fd0ab400c16e06f617d2afa952af0b3569aef4c11ca73eed6bd9d45a3";
  expect(targetText({ kind: "fetch_trace", params: { hash } })).toBe(shortAddr(hash));
});
