import { ApiError, type ApiErrorCode } from "./errors";
import type { ErrorBody } from "./generated/ErrorBody";

type Method = "GET" | "POST" | "PUT" | "DELETE";

const KNOWN: ApiErrorCode[] = [
  "invalid_input", "not_found", "conflict", "quota_exhausted", "upstream_error", "internal",
  "unauthorized", "rate_limited", "user_quota_exhausted",
];

// The server may send codes the client does not handle yet; those stay "internal".
const isKnown = (c: string): c is ApiErrorCode => (KNOWN as string[]).includes(c);

let unauthorizedHandler: (() => void) | null = null;

/** Called on every 401 (the session is gone), except for a refused login attempt. */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

export async function request<T>(
  method: Method,
  path: string,
  opts: {
    query?: Record<string, string | undefined>;
    body?: unknown;
    signal?: AbortSignal;
    /** A 401 refuses this login attempt; it does not end a session. */
    loginAttempt?: boolean;
  } = {},
): Promise<T> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) params.set(k, v);
  }
  const qs = params.toString();
  const url = qs ? `${path}?${qs}` : path;
  const init: RequestInit = { method };
  if (opts.signal) init.signal = opts.signal;
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
      if (isKnown(body.error.code)) code = body.error.code;
      message = body.error.message;
    } catch {
      // non-JSON error body: keep defaults
    }
    if (res.status === 401 && !opts.loginAttempt) unauthorizedHandler?.();
    throw new ApiError(code, res.status, message);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (text === "") return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError("internal", res.status, "invalid response body");
  }
}
