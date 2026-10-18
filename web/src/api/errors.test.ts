import { act } from "@testing-library/react";
import { useLocale } from "../i18n";
import { ApiError, messageFor } from "./errors";

afterEach(() => act(() => useLocale.getState().setLocale("en")));

test("messageFor maps codes to localized text (English by default)", () => {
  expect(messageFor(new ApiError("quota_exhausted", 429, "x"))).toContain("quota");
  expect(messageFor(new ApiError("network", 0, "x"))).toBe("Cannot reach the server");
  expect(messageFor(new ApiError("invalid_input", 400, "bad addr"))).toBe("Invalid input: bad addr");
  expect(messageFor(new Error("boom"))).toBe("Something went wrong");
});

test("messageFor follows the active locale", () => {
  act(() => useLocale.getState().setLocale("zh"));
  expect(messageFor(new ApiError("network", 0, "x"))).toBe("无法连接到服务器");
});

test("messageFor has its own text for session, rate-limit and per-user quota errors", () => {
  expect(messageFor(new ApiError("unauthorized", 401, "no_session"))).toBe("Your session has ended. Sign in again.");
  expect(messageFor(new ApiError("rate_limited", 429, "x"))).toBe("Too many attempts. Try again in a minute.");
  expect(messageFor(new ApiError("user_quota_exhausted", 429, "x"))).toBe(
    "Your daily Etherscan quota is used up; it resets at midnight UTC",
  );
  expect(messageFor(new ApiError("quota_exhausted", 429, "x"))).not.toBe(
    messageFor(new ApiError("user_quota_exhausted", 429, "x")),
  );
  act(() => useLocale.getState().setLocale("zh"));
  expect(messageFor(new ApiError("user_quota_exhausted", 429, "x"))).toBe("你今日的 Etherscan 额度已用完，将于 UTC 零点重置");
});
