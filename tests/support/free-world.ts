import { randomUUID } from "node:crypto";
import { FreeSession } from "../../src/server/free-session.js";
import { candidateTool } from "../../src/server/free-candidate-tools.js";
import { MemoryStore } from "./memory-store.js";
import { MemoryFreeStore } from "./free-store.js";
import type { ExactRef, FreeTask } from "../../src/shared/free.js";
export const worldContent = (name = "雾海") => ({
  name,
  markdown: "雾海群岛\r\n有三座灯塔。\n",
  genres: ["奇幻"],
  ageBand: "",
  sourceMetadata: {},
});
export async function worldFixture() {
  const content = new MemoryStore(),
    records = new MemoryFreeStore(content);
  const calls: { path: string; input: unknown }[] = [];
  const free = new FreeSession(
    content,
    records,
    {
      async request<T>(path: string, input?: unknown): Promise<T> {
        calls.push({ path, input });
        if (path === "/v1/models")
          return { models: [{ provider: "fake", id: "fake" }] } as T;
        if (path === "/v1/sessions") return { session_id: randomUUID() } as T;
        throw Error("No model");
      },
    },
    { autoStart: false },
  );
  const start = await free.start({
    clientRequestId: randomUUID(),
    message: "构思世界观",
    provider: "fake",
    model: "fake",
  });
  return { content, records, free, calls, ...start };
}
export async function worldResolve(
  free: FreeSession,
  task: FreeTask,
  intent = "draft",
  mode = "new",
  predicates: unknown[] = [],
) {
  const evidence = {
    start: 0,
    end: task.input.message.length,
    text: task.input.message,
  };
  return free.resolve(
    task.id,
    {
      intent,
      evidence,
      target: { mode, kind: "world", predicates },
      ...(intent === "update_world" ? { changeEvidence: evidence } : {}),
    },
    randomUUID(),
  );
}
export async function worldNext(
  free: FreeSession,
  id: string,
  message: string,
  refs: ExactRef[] = [],
) {
  return free.submit(id, {
    clientRequestId: randomUUID(),
    message,
    provider: "fake",
    model: "fake",
    refs,
  });
}
export async function worldDraft(
  free: FreeSession,
  task: FreeTask,
  args: Record<string, unknown> = {},
  invocationId = randomUUID(),
) {
  const result = await candidateTool(
    free,
    task,
    "save_world",
    {
      mode: "draft",
      name: "雾海",
      markdown: "完整世界设定\r\n",
      genres: ["奇幻"],
      ...args,
    },
    invocationId,
  );
  return free.candidates.get(
    task.conversationId,
    (result.data as { draft_id: string }).draft_id,
  );
}
