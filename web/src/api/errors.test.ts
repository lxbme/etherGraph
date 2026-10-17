import { ApiError, messageFor } from "./errors";

test("messageFor maps codes to Chinese text", () => {
  expect(messageFor(new ApiError("quota_exhausted", 429, "x"))).toContain("quota");
  expect(messageFor(new ApiError("network", 0, "x"))).toBe("Cannot reach the server");
  expect(messageFor(new ApiError("invalid_input", 400, "bad addr"))).toBe("Invalid input: bad addr");
  expect(messageFor(new Error("boom"))).toBe("Something went wrong");
});
