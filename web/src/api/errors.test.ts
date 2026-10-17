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
