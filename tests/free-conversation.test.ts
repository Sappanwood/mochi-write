import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { FreeSession } from "../src/server/free-session.js";
import { candidateTool } from "../src/server/free-candidate-tools.js";
import { AppError } from "../src/shared/model.js";
import type { FreeTask } from "../src/shared/free.js";
import { MemoryStore } from "./support/memory-store.js";
import { MemoryFreeStore } from "./support/free-store.js";

function fixture(classifier: unknown = { intent: "discuss" }, failed = false) {
  const content = new MemoryStore(),
    records = new MemoryFreeStore(content);
  const calls: { sessionId: string; payload: Record<string, unknown> }[] = [];
  const runs = new Map<string, unknown>();
  const free = new FreeSession(
    content,
    records,
    {
      async request<T>(path: string, body?: unknown): Promise<T> {
        if (path === "/v1/models")
          return { models: [{ provider: "fake", id: "fake" }] } as T;
        if (path === "/v1/sessions") return { session_id: randomUUID() } as T;
        if (!body) {
          const found = runs.get(path);
          if (!found) throw new AppError(404, "not_found");
          return found as T;
        }
        const payload = body as Record<string, unknown>;
        const sessionId = path.split("/")[3]!;
        calls.push({ sessionId, payload });
        const intent = String(payload.idempotency_key).endsWith(":intent:1");
        const run = {
          session_id: sessionId,
          run_id: randomUUID(),
          status: intent && failed ? "failed" : "succeeded",
          result: {
            text: intent
              ? JSON.stringify(classifier)
              : "1. 调查灯塔；2. 潜入港口。你倾向哪个方向？",
          },
        };
        runs.set(`/v1/runs/${run.run_id}`, run);
        runs.set(
          `/v1/runs/by-key?key=${encodeURIComponent(String(payload.idempotency_key))}`,
          run,
        );
        return run as T;
      },
    },
    { autoStart: false, pollMs: 1 },
  );
  const drive = async (task: FreeTask) => {
    await (
      free.workflow as unknown as { drive(id: string): Promise<void> }
    ).drive(task.id);
    return free.task(task.id);
  };
  return { free, content, records, calls, drive };
}
const input = (message = "给我两个故事走向") => ({
  clientRequestId: randomUUID(),
  message,
  provider: "fake",
  model: "fake",
});

it.each([
  {},
  null,
  { intent: "discuss" },
  { intent: "unclear" },
  { intent: "discuss", evidence: { start: 0, end: 99, text: "不是原文" } },
])(
  "continues conversation without write authority when interpretation is %j",
  async (raw) => {
    const f = fixture(raw);
    const { task } = await f.free.start(input("第二个，但让冲突更激烈一点"));
    const result = await f.drive(task);
    expect(result.state).toBe("succeeded");
    expect(result.output).toContain("灯塔");
    expect(result.binding).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.payload.scope).not.toHaveProperty("authorization_id");
    expect(
      await f.records.get("library", "directory", task.operationId),
    ).toBeUndefined();
    expect(f.content.heads.size).toBe(0);
  },
);

it("a terminal interpreter failure continues once without retrying classification", async () => {
  const f = fixture({}, true);
  const result = await f.drive((await f.free.start(input())).task);
  expect(result.state).toBe("succeeded");
  expect(result.intentRun?.status).toBe("failed");
  expect(result.binding).toBeUndefined();
  expect(f.calls).toHaveLength(2);
});

it("supplies recent user/assistant choices and reuses the creative session", async () => {
  const f = fixture();
  const first = await f.free.start(input());
  await f.drive(first.task);
  const next = await f.free.submit(first.conversation.id, input("第二个"));
  await f.drive(next);
  const prompt = JSON.parse(String(f.calls[2]!.payload.prompt));
  expect(prompt.recent_turns).toEqual([
    expect.objectContaining({
      user_message: first.task.input.message,
      assistant_message: "1. 调查灯塔；2. 潜入港口。你倾向哪个方向？",
    }),
  ]);
  expect(prompt.user_message).toBe("第二个");
  expect(f.calls[1]!.sessionId).toBe(f.calls[3]!.sessionId);
});

it("bounds context to earlier turns in this conversation and freezes it across recovery", async () => {
  const f = fixture();
  const first = await f.free.start(input());
  await f.free.change(first.task.id, (t) => {
    t.state = "succeeded";
    t.output = "旧内容";
  });
  for (let i = 0; i < 9; i++) {
    const t = await f.free.submit(first.conversation.id, input(`第${i}轮`));
    await f.free.change(t.id, (t) => {
      t.state = "succeeded";
      t.output = "长".repeat(10000);
    });
  }
  const other = await f.free.start(input("另一个会话"));
  await f.free.change(other.task.id, (t) => {
    t.state = "succeeded";
    t.output = "不应泄漏";
  });
  const next = await f.free.submit(first.conversation.id, input("继续"));
  await f.drive(next);
  const prompt = JSON.parse(String(f.calls[0]!.payload.prompt));
  expect(prompt.recent_turns.length).toBeGreaterThan(0);
  expect(prompt.recent_turns.length).toBeLessThanOrEqual(6);
  expect(
    Buffer.byteLength(JSON.stringify(prompt.recent_turns)),
  ).toBeLessThanOrEqual(24576);
  expect(JSON.stringify(prompt.recent_turns)).not.toMatch(
    /不应泄漏|旧内容|继续/,
  );
  const frozen = (await f.free.task(next.id)).intentRun!.payload.prompt;
  await f.free.change(first.task.id, (t) => {
    t.output = "后来变化";
  });
  await f.drive(await f.free.task(next.id));
  expect((await f.free.task(next.id)).intentRun!.payload.prompt).toBe(frozen);
  expect(f.calls).toHaveLength(2);
});

it.each([undefined, { start: 0, end: 999, text: "错位证据" }])(
  "draft feedback needs no exact intent evidence (%j), and cannot commit",
  async (evidence) => {
    const f = fixture();
    const { task } = await f.free.start(input("第二个，更果断一些"));
    const result = await f.free.resolve(
      task.id,
      {
        intent: "draft",
        target: { mode: "new", kind: "character", predicates: [] },
        ...(evidence ? { evidence } : {}),
      },
      "classifier",
    );
    expect(result.state).toBe("authorized");
    expect(result.draftContext?.mode).toBe("new_character");
    expect(result.binding).toBeUndefined();
    const draft = await candidateTool(
      f.free,
      result,
      "save_character",
      {
        mode: "draft",
        name: "港口侦探",
        markdown: "果断地进入港口。",
        genres: [],
        age_band: "",
      },
      "draft",
    );
    const ref = draft.data as {
      draft_id: string;
      draft_revision: string;
      draft_hash: string;
    };
    await expect(
      candidateTool(
        f.free,
        await f.free.task(task.id),
        "save_character",
        {
          mode: "commit",
          draft_id: ref.draft_id,
          draft_revision: ref.draft_revision,
          draft_hash: ref.draft_hash,
        },
        "commit",
      ),
    ).rejects.toThrow("authorization_required");
    expect(f.content.heads.size).toBe(0);
  },
);

it("a missing draft target returns to conversation without granting a draft or binding", async () => {
  const f = fixture({
    intent: "draft",
    evidence: { start: 0, end: 3, text: "第二个" },
    target: { mode: "explicit", kind: "story", predicates: [] },
  });
  const result = await f.drive((await f.free.start(input("第二个"))).task);
  expect(result.state).toBe("succeeded");
  expect(result.draftContext).toBeUndefined();
  expect(result.binding).toBeUndefined();
  const prompt = JSON.parse(String(f.calls.at(-1)!.payload.prompt));
  expect(prompt.conversation_note).toBe("ambiguous_explicit_target");
});

it.each([undefined, { start: 0, end: 4, text: "保存角色" }])(
  "save authorization still rejects missing or historical evidence (%j)",
  async (evidence) => {
    const f = fixture({
      intent: "create_character",
      target: { mode: "new", kind: "character", predicates: [] },
      ...(evidence ? { evidence } : {}),
    });
    const result = await f.drive((await f.free.start(input("第二个"))).task);
    expect(result.state).toBe("clarifying");
    expect(result.binding).toBeUndefined();
    expect(f.calls).toHaveLength(1);
    expect(f.content.heads.size).toBe(0);
  },
);
