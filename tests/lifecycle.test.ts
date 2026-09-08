import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { Creative } from "../src/server/creative.js";
import { MemoryStore } from "./support/memory-store.js";
import { MemoryCreativeStore } from "./support/creative-store.js";
import { FakeCreativeMochi } from "./support/creative-mochi.js";
const hosts: Creative[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});
it("persists a headless conversation, recovers the same first request, and rejects changed input", async () => {
  const content = new MemoryStore(),
    records = new MemoryCreativeStore(content),
    mochi = new FakeCreativeMochi();
  mochi.holdIntent = true;
  const host = new Creative(content, records, mochi, { pollMs: 5 });
  hosts.push(host);
  const input = {
    clientRequestId: randomUUID(),
    message: "讨论侦探角色",
    provider: "deepseek",
    model: "test",
  };
  const first = await host.startConversation(input);
  expect(first.conversation.lifecycle).toBe(true);
  expect(
    await content.get(first.conversation.storyId, first.conversation.storyId),
  ).toBeUndefined();
  expect((await host.startConversation(input)).task.id).toBe(first.task.id);
  await expect(
    host.startConversation({ ...input, message: "different" }),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(await host.lifecycleConversation(first.conversation.id)).toMatchObject(
    { storyId: first.conversation.storyId, established: false },
  );
  expect(
    await host.tasks(first.conversation.storyId, first.conversation.id),
  ).toHaveLength(1);
  await expect(
    host.conversations(first.conversation.storyId),
  ).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    host.tasks(randomUUID(), first.conversation.id),
  ).rejects.toMatchObject({ statusCode: 404 });
});
it("uses seven fixed tools for the headless run and never replays a lost session creation", async () => {
  const content = new MemoryStore(),
    records = new MemoryCreativeStore(content),
    mochi = new FakeCreativeMochi();
  const host = new Creative(content, records, mochi, { pollMs: 5 });
  hosts.push(host);
  const input = {
    clientRequestId: randomUUID(),
    message: "先讨论",
    provider: "deepseek",
    model: "test",
  };
  mochi.intent = "discuss";
  const first = await host.startConversation(input);
  await expect
    .poll(
      async () => (await host.task(first.task.storyId, first.task.id)).status,
    )
    .toBe("running");
  const conversation = await host.lifecycleConversation(first.conversation.id);
  expect(mochi.sessions.get(conversation.sessionId)?.tools).toHaveLength(7);
  const posts = mochi.calls.filter((c) => c.path === "/v1/sessions").length;
  await host.task(first.task.storyId, first.task.id);
  await host.startConversation(input);
  expect(mochi.calls.filter((c) => c.path === "/v1/sessions")).toHaveLength(
    posts,
  );
  const task = await host.task(first.task.storyId, first.task.id);
  expect(task.authorization).toBeUndefined();
  expect(await content.list({ kind: "story" })).toMatchObject({ items: [] });
});
it("preserves unknown session creation without replay on restart", async () => {
  const content = new MemoryStore(),
    records = new MemoryCreativeStore(content),
    mochi = new FakeCreativeMochi();
  const host = new Creative(content, records, mochi, { pollMs: 5 });
  hosts.push(host);
  mochi.intent = "discuss";
  const original = mochi.request.bind(mochi);
  mochi.request = async (path, body) => {
    if (path === "/v1/sessions" && (body as { tools?: unknown })?.tools) {
      await original(path, body);
      throw Error("lost session response");
    }
    return original(path, body);
  };
  const first = await host.startConversation({
    clientRequestId: randomUUID(),
    message: "只讨论",
    provider: "deepseek",
    model: "test",
  });
  await expect
    .poll(
      async () => (await host.task(first.task.storyId, first.task.id)).status,
    )
    .toBe("interrupted");
  const posts = mochi.calls.length;
  await host.recover();
  await host.lifecycleConversation(first.conversation.id);
  expect(mochi.calls).toHaveLength(posts);
  expect((await host.task(first.task.storyId, first.task.id)).error).toContain(
    "会话创建结果未知",
  );
});
it("recovers the first durable input after failure between conversation and task persistence", async () => {
  const content = new MemoryStore(),
    records = new MemoryCreativeStore(content),
    mochi = new FakeCreativeMochi();
  mochi.holdIntent = true;
  const host = new Creative(content, records, mochi, { pollMs: 5 });
  hosts.push(host);
  const transaction = records.transaction.bind(records);
  let failed = false;
  records.transaction = async (...args) => {
    if (!failed && args[1].some((w) => w.record.kind === "task")) {
      failed = true;
      throw Error("storage unavailable");
    }
    return transaction(...args);
  };
  const input = {
    clientRequestId: randomUUID(),
    message: "保留讨论",
    provider: "deepseek",
    model: "test",
  };
  await expect(host.startConversation(input)).rejects.toThrow(
    "storage unavailable",
  );
  expect(await records.conversations()).toHaveLength(1);
  expect(await records.activeTasks()).toHaveLength(0);
  await host.recover();
  const restored = await host.lifecycle.byRequest(input.clientRequestId);
  expect(restored.task.message).toBe(input.message);
  expect(restored.task.conversationId).toBe(restored.conversation.id);
  expect(await records.conversations()).toHaveLength(1);
  expect(await content.list({ kind: "story" })).toMatchObject({ items: [] });
});
