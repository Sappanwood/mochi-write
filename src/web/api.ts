import type { AuthClient } from "./auth.js";
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export type Api = <T>(
  path: string,
  body?: unknown,
  method?: string,
) => Promise<T>;
export function apiClient(auth: AuthClient): Api {
  return async <T>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(`/api${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${await auth.token()}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("登录"))
        throw error;
      throw new ApiError("网络连接失败，当前内容未丢弃，请重试", 0);
    }
    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      throw new ApiError(
        `${problem.error ?? "请求失败"}${problem.diagnostics?.length ? "：" + problem.diagnostics.join("；") : ""}`,
        response.status,
      );
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  };
}
export function message(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请重试";
}
