export type ApiErrorCode =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "quota_exhausted"
  | "upstream_error"
  | "internal"
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
  if (!(err instanceof ApiError)) return "发生未知错误";
  switch (err.code) {
    case "network":
      return "无法连接到服务器";
    case "quota_exhausted":
      return "今日 Etherscan 调用额度已用完";
    case "not_found":
      return "未找到";
    case "conflict":
      return "数据已被修改";
    case "upstream_error":
      return "上游数据源出错";
    case "internal":
      return "服务器内部错误";
    case "invalid_input":
      return "输入有误：" + err.message;
    default:
      return "发生未知错误";
  }
}
