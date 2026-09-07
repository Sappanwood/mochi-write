import { randomUUID } from "node:crypto";
import { AppError } from "../../src/shared/model.js";
import type { Run } from "../../src/shared/writing.js";
import type { Mochi } from "../../src/server/mochi-client.js";
export class FakeMochi implements Mochi {
  runs = new Map<string, Run>();
  calls: string[] = [];
  loseResponse = false;
  status: Run["status"] = "succeeded";
  async request<T>(path: string, body?: unknown): Promise<T> {
    this.calls.push(path);
    const b = body as Record<string, string>;
    let value: unknown;
    if (path === "/v1/sessions") value = { session_id: randomUUID() };
    else if (path === "/v1/models")
      value = {
        models: [
          {
            provider: "deepseek",
            id: "model",
            name: "测试模型",
            context_window: 64000,
            max_output_tokens: 4000,
          },
        ],
      };
    else if (path.endsWith("/history")) value = { messages: [] };
    else if (path.startsWith("/v1/runs/by-key")) {
      value = this.runs.get(decodeURIComponent(path.split("key=")[1]!));
      if (!value) throw new AppError(404, "不存在");
    } else if (path.endsWith("/runs")) {
      const run: Run = {
        run_id: randomUUID(),
        session_id: path.split("/")[3]!,
        status: this.status,
        result: this.status === "succeeded" ? { text: "完整的新章节。" } : null,
        error: null,
      };
      this.runs.set(b.idempotency_key!, run);
      value = run;
      if (this.loseResponse) {
        this.loseResponse = false;
        throw new AppError(503, "未知");
      }
    } else if (path.includes("/events?")) {
      value = {
        events: [
          { cursor: 1, type: "text_delta", data: { text: "不完整的片段" } },
        ],
        next_cursor: 1,
      };
    } else {
      const run = [...this.runs.values()].find((r) => path.includes(r.run_id));
      if (!run) throw new AppError(404, "不存在");
      if (path.endsWith("/cancel")) {
        run.status = "cancelled";
        run.result = null;
      }
      value = run;
    }
    return structuredClone(value) as T;
  }
}
