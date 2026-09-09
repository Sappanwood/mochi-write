import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { Creative } from "../src/server/creative.js";
import { entity } from "../src/server/entities.js";
import { MemoryStore } from "./support/memory-store.js";
import { MemoryCreativeStore } from "./support/creative-store.js";
import { FakeCreativeMochi } from "./support/creative-mochi.js";
const hosts: Creative[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});
async function fixture() {
  const content = new MemoryStore(),
    records = new MemoryCreativeStore(content),
    mochi = new FakeCreativeMochi();
  const host = new Creative(content, records, mochi, { pollMs: 2 });
  hosts.push(host);
  const storyId = randomUUID();
  await content.commit(
    {
      ...entity(
        "story",
        {
          name: "灯塔",
          markdown: "",
          genres: [],
          ageBand: "",
          sourceMetadata: {},
        },
        storyId,
        storyId,
      ),
      status: "ready",
    },
    null,
  );
  return { content, records, mochi, host, storyId };
}
it("locks model and thinking with the first story message and rejects changes without cancelling the active task", async () => {
  const f = await fixture();
  const c = await f.host.createConversation(f.storyId);
  expect(f.mochi.sessions.size).toBe(0);
  const input = {
    conversationId: c.id,
    clientRequestId: randomUUID(),
    message: "先写草稿",
    provider: "deepseek",
    model: "test",
    thinkingLevel: "high",
  };
  const first = await f.host.submit(f.storyId, input);
  await expect
    .poll(async () => (await f.host.task(f.storyId, first.id)).status)
    .toBe("running");
  const current = await f.host.requireConversation(f.storyId, c.id);
  expect(current).toMatchObject({
    configuration: {
      provider: "deepseek",
      model: "test",
      thinkingLevel: "high",
    },
  });
  expect(f.mochi.sessions.get(current.sessionId)).toMatchObject({
    thinking_level: "high",
  });
  for (const change of [
    { model: "different" },
    { provider: "different" },
    { thinkingLevel: "low" },
  ]) {
    await expect(
      f.host.submit(f.storyId, {
        ...input,
        clientRequestId: randomUUID(),
        ...change,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await f.host.task(f.storyId, first.id)).status).toBe("running");
  }
  expect((await f.host.submit(f.storyId, input)).id).toBe(first.id);
  const resumed = new Creative(f.content, f.records, f.mochi);
  hosts.push(resumed);
  await expect(
    resumed.submit(f.storyId, {
      ...input,
      clientRequestId: randomUUID(),
      thinkingLevel: "off",
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
});
it("lifecycle startup persists thinking, keeps intent thinking off, and rejects unsupported levels", async () => {
  const f = await fixture();
  const input = {
    clientRequestId: randomUUID(),
    message: "聊聊新故事",
    provider: "deepseek",
    model: "test",
    thinkingLevel: "low",
  };
  const first = await f.host.startConversation(input);
  await expect
    .poll(
      async () => (await f.host.task(first.task.storyId, first.task.id)).status,
    )
    .toBe("running");
  const c = await f.host.lifecycleConversation(first.conversation.id);
  expect(f.mochi.sessions.get(c.sessionId)).toMatchObject({
    thinking_level: "low",
  });
  const task = await f.host.requireTask(c.storyId, first.task.id);
  expect(f.mochi.sessions.get(task.intentSessionId!)).toMatchObject({
    thinking_level: "off",
  });
  expect((await f.host.startConversation(input)).task.id).toBe(task.id);
  await expect(
    f.host.startConversation({ ...input, thinkingLevel: "high" }),
  ).rejects.toMatchObject({ statusCode: 409 });
  await expect(
    f.host.startConversation({
      ...input,
      clientRequestId: randomUUID(),
      thinkingLevel: "ultra",
    }),
  ).rejects.toThrow();
});

it("locks a legacy session to its last recorded model and original default thinking", async () => {
  const f = await fixture();
  const c = await f.host.createConversation(f.storyId);
  const input = {
    conversationId: c.id,
    clientRequestId: randomUUID(),
    message: "旧会话",
    provider: "deepseek",
    model: "test",
  };
  const first = await f.host.submit(f.storyId, input);
  await expect
    .poll(async () => (await f.host.task(f.storyId, first.id)).status)
    .toBe("running");
  f.mochi.finish((await f.host.task(f.storyId, first.id)).runId!);
  await expect
    .poll(async () => (await f.host.task(f.storyId, first.id)).status)
    .toBe("succeeded");
  const old = await f.host.requireConversation(f.storyId, c.id);
  delete old.configuration;
  await f.records.transaction(f.storyId, [
    { record: old, revision: old.revision },
  ]);
  await expect(
    f.host.submit(f.storyId, {
      ...input,
      clientRequestId: randomUUID(),
      model: "other",
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  await expect(
    f.host.submit(f.storyId, {
      ...input,
      clientRequestId: randomUUID(),
      thinkingLevel: "high",
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  const next = await f.host.submit(f.storyId, {
    ...input,
    clientRequestId: randomUUID(),
  });
  expect(next).toMatchObject({ model: "test" });
  expect(
    (await f.host.requireConversation(f.storyId, c.id)).configuration,
  ).toEqual({ provider: "deepseek", model: "test" });
});
it("two first messages cannot freeze different configurations in the same conversation", async () => {
  const f = await fixture();
  const c = await f.host.createConversation(f.storyId);
  const other = new Creative(f.content, f.records, f.mochi);
  hosts.push(other);
  const results = await Promise.allSettled(
    [f.host, other].map((host, index) =>
      host.submit(f.storyId, {
        conversationId: c.id,
        clientRequestId: randomUUID(),
        provider: "deepseek",
        model: "test",
        thinkingLevel: index ? "low" : "high",
        message: "开始创作",
      }),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(await f.records.tasks(f.storyId, c.id)).toHaveLength(1);
});
it("a valid but unsupported thinking level never reaches a creative model run", async () => {
  const f = await fixture();
  const result = await f.host.startConversation({
    clientRequestId: randomUUID(),
    message: "开始",
    provider: "deepseek",
    model: "test",
    thinkingLevel: "medium",
  });
  await expect
    .poll(
      async () =>
        (await f.host.task(result.task.storyId, result.task.id)).status,
    )
    .toBe("failed");
  expect(f.mochi.creativePosts()).toHaveLength(0);
});
