import { t } from "../i18n";

export type ApiErrorCode =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "quota_exhausted"
  | "upstream_error"
  | "internal"
  | "user_quota_exhausted"
  | "network";

export class ApiError extends Error {
  code: ApiErrorCode;
  status: number;
  constructor(code: ApiErrorCode, status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export function messageFor(err: unknown): string {
  if (!(err instanceof ApiError)) return t("error.unknown");
  switch (err.code) {
    case "network":
      return t("error.network");
    case "quota_exhausted":
      return t("error.quota");
    case "not_found":
      return t("error.notFound");
    case "conflict":
      return t("error.conflict");
    case "upstream_error":
      return t("error.upstream");
    case "internal":
      return t("error.internal");
    case "invalid_input":
      return t("error.invalidInput", { message: err.message });
    default:
      return t("error.unknown");
  }
}
