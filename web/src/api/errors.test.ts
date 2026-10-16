import { ApiError, messageFor } from "./errors";

test("messageFor maps codes to Chinese text", () => {
  expect(messageFor(new ApiError("quota_exhausted", 429, "x"))).toContain("额度");
  expect(messageFor(new ApiError("network", 0, "x"))).toBe("无法连接到服务器");
  expect(messageFor(new ApiError("invalid_input", 400, "bad addr"))).toBe("输入有误：bad addr");
  expect(messageFor(new Error("boom"))).toBe("发生未知错误");
});
