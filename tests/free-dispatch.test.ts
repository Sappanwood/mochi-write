import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { FreeSession } from "../src/server/free-session.js";
import { MemoryFreeStore } from "./support/free-store.js";
import { MemoryStore } from "./support/memory-store.js";
import { AppError } from "../src/shared/model.js";
import type { FreeTask } from "../src/shared/free.js";
const input = () => ({
  clientRequestId: randomUUID(),
  message: "讨论角色",
  provider: "fake",
  model: "fake",
});
function fixture() {
  const posts: string[] = [];
  const free = new FreeSession(
    new MemoryStore(),
    new MemoryFreeStore(),
    {
      async request<T>(path: string, body?: unknown) {
        if (path === "/v1/models")
          return { models: [{ provider: "fake", id: "fake" }] } as T;
        if (!body) throw new AppError(404, "not_found");
        posts.push(path);
        if (path === "/v1/sessions") return { session_id: randomUUID() } as T;
        const sessionId = path.split("/")[3];
        return {
          session_id: sessionId,
          run_id: randomUUID(),
          status: "succeeded",
          result: { text: "original" },
        } as T;
      },
    },
    { autoStart: false },
  );
  return { free, posts };
}
type Driver = {
  run(
    task: FreeTask,
    field: "intentRun" | "resolutionRun" | "executionRun",
    sessionId: string,
    phase: "intent" | "resolve" | "execute",
  ): Promise<unknown>;
  interpret(task: FreeTask): Promise<unknown>;
};
for (const [field, phase] of [
  ["intentRun", "intent"],
  ["resolutionRun", "resolve"],
  ["executionRun", "execute"],
] as const) {
  it(`${phase}: cancellation winning after guard prevents run POST`, async () => {
    const { free, posts } = fixture();
    const { task } = await free.start(input());
    const sessionId = randomUUID();
    await free.change(task.id, (t) => {
      t[field] = {
        key: `${task.id}:${phase}:1`,
        sessionId,
        dispatchStarted: false,
        payload: {},
      };
    });
    const original = free.guard.bind(free);
    let injected = false;
    free.guard = async (t) => {
      const c = await original(t);
      if (!injected) {
        injected = true;
        await free.cancel(t.id);
      }
      return c;
    };
    await (free.workflow as unknown as Driver)
      .run(await free.task(task.id), field, sessionId, phase)
      .catch(() => {});
    expect(posts).toEqual([]);
    expect((await free.task(task.id)).stopPending).toBe(false);
    expect((await free.task(task.id)).state).toBe("revoked");
  });
  it(`${phase}: reservation winning keeps cancel pending until original run is known`, async () => {
    const { free, posts } = fixture();
    const { task } = await free.start(input());
    const sessionId = randomUUID();
    await free.change(task.id, (t) => {
      t[field] = {
        key: `${task.id}:${phase}:1`,
        sessionId,
        dispatchStarted: false,
        payload: {},
      };
    });
    const transaction = free.records.transaction.bind(free.records);
    let injected = false;
    free.records.transaction = async (p, writes) => {
      const result = await transaction(p, writes);
      if (
        !injected &&
        writes.some(
          (w) => w.record.kind === "task" && w.record[field]?.dispatchStarted,
        )
      ) {
        injected = true;
        expect((await free.cancel(task.id)).stopPending).toBe(true);
      }
      return result;
    };
    await (free.workflow as unknown as Driver).run(
      await free.task(task.id),
      field,
      sessionId,
      phase,
    );
    expect(posts).toEqual([`/v1/sessions/${sessionId}/runs`]);
    expect((await free.task(task.id)).stopPending).toBe(true);
  });
}
it("cancel winning before intent session dispatch cannot create a new session", async () => {
  const { free, posts } = fixture();
  const { task } = await free.start(input());
  await free.cancel(task.id);
  await (free.workflow as unknown as Driver).interpret(task).catch(() => {});
  expect(posts).toEqual([]);
  expect((await free.task(task.id)).state).toBe("revoked");
});
for (const kind of ["intent", "creative"] as const) {
  it(`${kind} session: cancellation winning the reservation CAS prevents creation`, async () => {
    const { free, posts } = fixture();
    const { task } = await free.start(input());
    const guard = free.guard.bind(free);
    let injected = false;
    free.guard = async (t) => {
      const c = await guard(t);
      if (!injected) {
        injected = true;
        await free.cancel(t.id);
      }
      return c;
    };
    const operation =
      kind === "intent"
        ? (free.workflow as unknown as Driver).interpret(task)
        : free.workflow.session(task);
    await operation.catch(() => {});
    expect(posts).toEqual([]);
    expect((await free.task(task.id)).state).toBe("revoked");
  });
  it(`${kind} session: pending creation reservation remains stopPending until response persisted`, async () => {
    const { free, posts } = fixture();
    const { task } = await free.start(input());
    const transaction = free.records.transaction.bind(free.records);
    let injected = false;
    free.records.transaction = async (p, writes) => {
      const result = await transaction(p, writes);
      if (
        !injected &&
        writes.some((w) =>
          kind === "intent"
            ? w.record.kind === "task" && w.record.intentSessionDispatchStarted
            : w.record.kind === "conversation" &&
              w.record.sessionDispatchStarted,
        )
      ) {
        injected = true;
        expect((await free.cancel(task.id)).stopPending).toBe(true);
      }
      return result;
    };
    await (
      kind === "intent"
        ? (free.workflow as unknown as Driver).interpret(task)
        : free.workflow.session(task)
    ).catch(() => {});
    expect(posts).toEqual(["/v1/sessions"]);
    expect((await free.task(task.id)).stopPending).toBe(true);
    expect((await free.cancel(task.id)).stopPending).toBe(false);
  });
}

it.each(["😀改写世界观", "文".repeat(300)])(
  "intent prompts preserve UTF-16 positions and bound annotation size: %s",
  async (message) => {
    const { free } = fixture();
    const t = (await free.start({ ...input(), message })).task;
    await (free.workflow as unknown as Driver).run(
      t,
      "intentRun",
      randomUUID(),
      "intent",
    );
    const current = await free.task(t.id);
    const payload = current.intentRun!.payload as { prompt: string };
    const prompt = JSON.parse(payload.prompt) as {
      user_message: string;
      user_message_utf16_prefix: [number, number, string][];
    };
    expect(prompt.user_message).toBe(message);
    expect(prompt.user_message_utf16_prefix).toBeDefined();
    expect(prompt.user_message_utf16_prefix.length).toBeLessThanOrEqual(256);
    for (const [start, end, text] of prompt.user_message_utf16_prefix)
      expect(message.slice(start, end)).toBe(text);
    expect(prompt.user_message_utf16_prefix[0]).toEqual(
      message.startsWith("😀") ? [0, 2, "😀"] : [0, 1, "文"],
    );
    expect(
      Buffer.byteLength(JSON.stringify(prompt.user_message_utf16_prefix)),
    ).toBeLessThan(8192);
  },
);
