import { AppError } from "../shared/model.js";
import type { Run } from "../shared/writing.js";
export interface Mochi {
  request<T>(path: string, body?: unknown): Promise<T>;
}
export class MochiClient implements Mochi {
  constructor(
    private origin: string,
    private token: () => Promise<string>,
  ) {}
  async request<T>(path: string, body?: unknown): Promise<T> {
    try {
      const response = await fetch(this.origin + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw new AppError(
          [400, 403, 404, 409, 413, 429].includes(response.status)
            ? response.status
            : 503,
          "Mochi 请求失败，请查询任务状态后重试",
        );
      return (await response.json()) as T;
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(503, "Mochi 暂不可用；提交结果未知，请恢复查询");
    }
  }
}
export function terminal(run: Run) {
  return !["queued", "running"].includes(run.status);
}
