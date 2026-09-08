import { randomUUID } from "node:crypto";
import { AppError } from "../../src/shared/model.js";
import type { CreativeIntent } from "../../src/shared/creative.js";
import type { Run } from "../../src/shared/writing.js";
import type { Mochi } from "../../src/server/mochi-client.js";
export class FakeCreativeMochi implements Mochi {
  readonly sessions = new Map<
    string,
    { tools?: unknown; system_prompt?: string }
  >();
  readonly runs = new Map<string, Run>();
  readonly keys = new Map<string, string>();
  readonly calls: { path: string; body?: Record<string, unknown> }[] = [];
  intent: CreativeIntent = "draft";
  holdIntent = false;
  loseCreativePost = false;
  hideKeys = false;
  modelBarrier?: () => Promise<void>;
  async request<T>(path: string, raw?: unknown): Promise<T> {
    const body = raw as Record<string, unknown> | undefined;
    this.calls.push({ path, body });
    if (path === "/v1/models") {
      await this.modelBarrier?.();
      return { models: [{ provider: "deepseek", id: "test" }] } as T;
    }
    if (path === "/v1/sessions") {
      const session_id = randomUUID();
      this.sessions.set(session_id, body!);
      return { session_id } as T;
    }
    if (path.startsWith("/v1/runs/by-key")) {
      const key = new URL(path, "https://mochi.invalid").searchParams.get(
        "key",
      )!;
      const id = this.keys.get(key);
      if (!id || this.hideKeys) throw new AppError(404, "not found");
      return structuredClone(this.runs.get(id)) as T;
    }
    const submit = /^\/v1\/sessions\/([^/]+)\/runs$/.exec(path);
    if (submit && body) {
      const session = this.sessions.get(submit[1]!)!;
      const prompt = JSON.parse(body.prompt as string) as {
        user_message: string;
      };
      const run: Run = {
        run_id: randomUUID(),
        session_id: submit[1]!,
        status: session.tools || this.holdIntent ? "running" : "succeeded",
        result:
          session.tools || this.holdIntent
            ? null
            : {
                text: JSON.stringify({
                  intent: this.intent,
                  evidence: {
                    start: 0,
                    end: prompt.user_message.length,
                    text: prompt.user_message,
                  },
                }),
              },
        error: null,
        usage: {
          input: 2,
          output: 1,
          cache_read: 0,
          cache_write: 0,
          total_tokens: 3,
        },
      };
      this.runs.set(run.run_id, run);
      this.keys.set(body.idempotency_key as string, run.run_id);
      if (session.tools && this.loseCreativePost) {
        this.loseCreativePost = false;
        throw new AppError(503, "response lost");
      }
      return structuredClone(run) as T;
    }
    const cancel = /^\/v1\/runs\/([^/]+)\/cancel$/.exec(path);
    if (cancel) {
      const run = this.runs.get(cancel[1]!)!;
      run.status = "cancelled";
      run.result = null;
      return structuredClone(run) as T;
    }
    const run = /^\/v1\/runs\/([^/]+)$/.exec(path);
    if (run) {
      const value = this.runs.get(run[1]!);
      if (!value) throw new AppError(404, "not found");
      return structuredClone(value) as T;
    }
    if (path.includes("/events?")) return { events: [], next_cursor: 0 } as T;
    if (path.endsWith("/operations/verify")) return {} as T;
    throw new Error("Unexpected fake Mochi path: " + path);
  }
  finish(runId: string, status: Run["status"] = "succeeded") {
    const run = this.runs.get(runId)!;
    run.status = status;
    run.result = status === "succeeded" ? { text: "会话回复，不是正文" } : null;
  }
  creativePosts() {
    return this.calls.filter((call) => call.body?.scope);
  }
}
