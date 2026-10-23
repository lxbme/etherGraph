import { ApiError } from "./errors";
import { queryClient, qk } from "./queryClient";

test("retry policy skips non-retryable ApiErrors", () => {
  const retry = queryClient.getDefaultOptions().queries!.retry as (n: number, e: unknown) => boolean;
  expect(retry(0, new ApiError("not_found", 404, "x"))).toBe(false);
  expect(retry(0, new ApiError("quota_exhausted", 429, "x"))).toBe(false);
  expect(retry(0, new ApiError("upstream_error", 502, "x"))).toBe(true);
  expect(retry(2, new ApiError("upstream_error", 502, "x"))).toBe(false);
});

test("qk keys are stable arrays", () => {
  expect(qk.address("0xa")).toEqual(["address", "0xa"]);
  expect(qk.status()).toEqual(["status"]);
});

test("local data keys sit under the admin keys: signed actions refresh them, leaving admin mode drops them", () => {
  expect(qk.localData()).toEqual(["admin", "localData"]);
  expect(qk.localDataProgress()).toEqual(["admin", "localDataProgress"]);
});
