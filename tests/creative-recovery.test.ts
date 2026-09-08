import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { Creative, wireId } from "../src/server/creative.js";
import { AppError } from "../src/shared/model.js";
import { entity } from "../src/server/entities.js";
import type { CreativeTask } from "../src/shared/creative.js";
import { MemoryStore } from "./support/memory-store.js";
import { MemoryCreativeStore } from "./support/creative-store.js";
import { FakeCreativeMochi } from "./support/creative-mochi.js";
const services: Creative[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});
async function fixture() {
  const content = new MemoryStore(),
    storyId = randomUUID();
  await content.commit(
    {
      ...entity(
        "story",
        {
          name: "隔离恢复故事",
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
  const records = new MemoryCreativeStore(content),
    mochi = new FakeCreativeMochi();
  const service = new Creative(content, records, mochi, { pollMs: 2 });
  services.push(service);
  const conversation = await service.createConversation(storyId);
  const input = {
    clientRequestId: randomUUID(),
    conversationId: conversation.id,
    provider: "deepseek",
    model: "test",
    message: "写一章并保存",
  };
  const restart = async () => {
    await service.close();
    const next = new Creative(content, records, mochi, { pollMs: 2 });
    services.push(next);
    await next.recover();
    return next;
  };
  return {
    content,
    storyId,
    records,
    mochi,
    service,
    conversation,
    input,
    restart,
  };
}
async function waitTask(
  service: Creative,
  storyId: string,
  id: string,
  predicate: (task: CreativeTask) => boolean,
) {
  let task: CreativeTask | undefined;
  for (let i = 0; i < 200; i++) {
    task = await service.task(storyId, id);
    if (predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Task did not converge: ${task?.status}`);
}
it("recovers a lost creative POST response through the same key without another dispatch", async () => {
  const f = await fixture();
  f.mochi.loseCreativePost = true;
  const initial = await f.service.submit(f.storyId, f.input);
  const task = await waitTask(
    f.service,
    f.storyId,
    initial.id,
    (task) => task.status === "running",
  );
  expect(f.mochi.creativePosts()).toHaveLength(1);
  expect(
    f.mochi.calls.filter(
      (call) =>
        call.path.startsWith("/v1/runs/by-key") &&
        decodeURIComponent(call.path).includes("creative:creative:"),
    ),
  ).toHaveLength(2);
  f.mochi.finish(task.runId!);
  const finished = await waitTask(
    f.service,
    f.storyId,
    task.id,
    (task) => task.status === "succeeded",
  );
  expect(finished.runId).toBe(task.runId);
  expect(f.mochi.creativePosts()).toHaveLength(1);
});
it("restarts the background observer and refreshes the original task without model POSTs", async () => {
  const f = await fixture();
  const initial = await f.service.submit(f.storyId, f.input);
  const before = await waitTask(
    f.service,
    f.storyId,
    initial.id,
    (task) => task.status === "running",
  );
  await f.service.close();
  const postCount = f.mochi.calls.filter((call) => call.body).length;
  for (let i = 0; i < 4; i++) await f.service.task(f.storyId, initial.id);
  expect(f.mochi.calls.filter((call) => call.body)).toHaveLength(postCount);
  const next = await f.restart();
  f.mochi.finish(before.runId!);
  const after = await waitTask(
    next,
    f.storyId,
    initial.id,
    (task) => task.status === "succeeded",
  );
  expect(after.runId).toBe(before.runId);
  expect(f.mochi.calls.filter((call) => call.body)).toHaveLength(postCount);
});
it("retains the durable chapter when the model fails after committing", async () => {
  const f = await fixture();
  f.mochi.intent = "create_and_save";
  const initial = await f.service.submit(f.storyId, f.input);
  const running = await waitTask(
    f.service,
    f.storyId,
    initial.id,
    (task) => task.status === "running",
  );
  const context = (await f.service.resolveTask(wireId(f.storyId, initial.id)))!;
  await context.bindRun(running.runId!);
  const draft = await f.service.createChapter(
    context,
    { mode: "draft", title: "已写入", body: "精确正文\n" },
    "draft-invocation",
  );
  const { draft_id, draft_revision, draft_hash } = draft.data as {
    draft_id: string;
    draft_revision: string;
    draft_hash: string;
  };
  const committed = await f.service.createChapter(
    context,
    { mode: "commit", draft_id, draft_revision, draft_hash },
    "commit-invocation",
  );
  f.mochi.finish(running.runId!, "failed");
  const failed = await waitTask(
    f.service,
    f.storyId,
    initial.id,
    (task) => task.status === "failed",
  );
  expect(failed.receipt).toEqual(committed.receipt);
  expect((await f.service.operation(initial.operationId)).status).toBe(
    "committed",
  );
  expect(
    (await f.content.get(committed.receipt!.chapter_id, f.storyId))?.content
      .markdown,
  ).toBe("精确正文\n");
  const restarted = await f.restart();
  expect((await restarted.task(f.storyId, initial.id)).receipt).toEqual(
    committed.receipt,
  );
  expect(f.mochi.creativePosts()).toHaveLength(1);
});
it("does not replay a marked submission when its original key is still absent after restart", async () => {
  const f = await fixture();
  f.mochi.loseCreativePost = true;
  f.mochi.hideKeys = true;
  const initial = await f.service.submit(f.storyId, f.input);
  await waitTask(
    f.service,
    f.storyId,
    initial.id,
    (task) => task.creativeDispatchStarted === true,
  );
  await f.service.close();
  const posts = f.mochi.creativePosts().length;
  const restarted = await f.restart();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const task = await restarted.task(f.storyId, initial.id);
  expect(task.receipt).toBeUndefined();
  expect(task.status).toBe("pending");
  expect(f.mochi.creativePosts()).toHaveLength(posts);
});

it("verifies a chapter when the database committed but its response was lost", async () => {
  const f = await fixture();
  f.mochi.intent = "create_and_save";
  const initial = await f.service.submit(f.storyId, f.input);
  const running = await waitTask(
    f.service,
    f.storyId,
    initial.id,
    (task) => task.status === "running",
  );
  const ctx = (await f.service.resolveTask(wireId(f.storyId, initial.id)))!;
  await ctx.bindRun(running.runId!);
  const draft = await f.service.createChapter(
    ctx,
    { mode: "draft", title: "收据", body: "写入结果不可凭响应猜测。" },
    "draft",
  );
  const { draft_id, draft_revision, draft_hash } = draft.data as {
    draft_id: string;
    draft_revision: string;
    draft_hash: string;
  };
  const args = { mode: "commit", draft_id, draft_revision, draft_hash };
  const transaction = f.records.transaction.bind(f.records);
  let lost = false;
  vi.spyOn(f.records, "transaction").mockImplementation(
    async (story, writes, chapter) => {
      const saved = await transaction(story, writes, chapter);
      if (chapter && !lost) {
        lost = true;
        throw new AppError(503, "lost database response");
      }
      return saved;
    },
  );
  await expect(
    f.service.createChapter(ctx, args, "first-call"),
  ).rejects.toMatchObject({ statusCode: 503 });
  const operation = await f.service.operation(initial.operationId);
  expect(operation.status).toBe("committed");
  const retry = await f.service.createChapter(ctx, args, "different-call");
  expect(retry.receipt).toEqual(
    "receipt" in operation ? operation.receipt : undefined,
  );
  expect(
    (await f.content.list({ projectId: f.storyId, kind: "chapter" })).items,
  ).toHaveLength(1);
});
