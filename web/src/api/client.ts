import { ApiError, type ApiErrorCode } from "./errors";
import type { ErrorBody } from "./generated/ErrorBody";

type Method = "GET" | "POST" | "PUT" | "DELETE";

const KNOWN: ApiErrorCode[] = [
  "invalid_input", "not_found", "conflict", "quota_exhausted", "upstream_error", "internal",
];

export async function request<T>(
  method: Method,
  path: string,
  opts: { query?: Record<string, string | undefined>; body?: unknown } = {},
): Promise<T> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) params.set(k, v);
  }
  const qs = params.toString();
  const url = qs ? `${path}?${qs}` : path;
  const init: RequestInit = { method };
  if (opts.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new ApiError("network", 0, e instanceof Error ? e.message : "network error");
  }

  if (!res.ok) {
    let code: ApiErrorCode = "internal";
    let message = res.statusText;
    try {
      const body = (await res.json()) as ErrorBody;
      if (KNOWN.includes(body.error.code)) code = body.error.code;
      message = body.error.message;
    } catch {
      // non-JSON error body: keep defaults
    }
    throw new ApiError(code, res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
