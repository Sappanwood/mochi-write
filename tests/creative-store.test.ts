import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "@azure/cosmos";
import { CosmosCreativeStore } from "../src/server/creative-store.js";
import { MemoryCreativeStore } from "./support/creative-store.js";
import { MemoryStore } from "./support/memory-store.js";
import { entity } from "../src/server/entities.js";
import type {
  CreativeConversation,
  CreativeDraft,
  CreativeTask,
  ChapterReceipt,
} from "../src/shared/creative.js";

function fixture() {
  const storyId = randomUUID();
  const base = {
    id: randomUUID(),
    storyId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revision: "old",
  };
  const conversation: CreativeConversation = {
    ...base,
    kind: "conversation",
    sessionId: "session",
    activeTaskId: null,
  };
  const task: CreativeTask = {
    ...base,
    id: randomUUID(),
    kind: "task",
    conversationId: conversation.id,
    message: "fixture",
    digest: "digest",
    sourceMessageId: "message",
    sourceHash: "hash",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    operationId: "operation",
    chapterId: randomUUID(),
    intentSessionId: null,
    intentRunId: null,
    runId: null,
    status: "pending",
    output: "",
    sources: [],
    artifacts: [],
    draftInvocations: {},
  };
  const draft: CreativeDraft = {
    ...base,
    id: randomUUID(),
    kind: "draft",
    conversationId: conversation.id,
    taskId: task.id,
    title: "chapter",
    body: "body",
    draftRevision: "1",
    hash: "sha256:fixture",
  };
  const chapter = entity(
    "chapter",
    {
      name: draft.title,
      markdown: draft.body,
      genres: [],
      ageBand: "",
      sourceMetadata: {},
    },
    storyId,
    task.chapterId,
  );
  const receipt: ChapterReceipt = {
    operation_id: task.operationId,
    status: "committed",
    story_id: storyId,
    chapter_id: chapter.id,
    revision: "1",
    content_hash: draft.hash,
  };
  const content = new MemoryStore();
  return {
    storyId,
    conversation,
    task,
    draft,
    chapter,
    receipt,
    content,
    memory: new MemoryCreativeStore(content),
  };
}
function cosmos() {
  const batch = vi.fn<
    (
      ops: unknown[],
      partition: string,
    ) => Promise<{
      code: number;
      result: { statusCode: number; eTag: string }[];
    }>
  >(async (ops) => ({
    code: 200,
    result: ops.map((_, i) => ({ statusCode: 201, eTag: `etag-${i}` })),
  }));
  const create = vi
    .fn()
    .mockResolvedValue({ statusCode: 201, resource: { _etag: "created" } });
  const read = vi.fn().mockResolvedValue({ resource: undefined });
  const fetchAll = vi.fn().mockResolvedValue({ resources: [] });
  const query = vi.fn(() => ({ fetchAll }));
  const item = vi.fn(() => ({ read }));
  const container = vi.fn(() => ({ items: { batch, create, query }, item }));
  return {
    store: new CosmosCreativeStore({ container } as unknown as Database),
    batch,
    create,
    read,
    fetchAll,
    query,
    item,
    container,
  };
}
describe("creative storage transactions", () => {
  it("reserves request identity across stories and input digests", async () => {
    const f = fixture();
    await f.memory.reserve("request", "digest", f.storyId);
    await f.memory.reserve("request", "digest", f.storyId);
    await expect(
      f.memory.reserve("request", "other", f.storyId),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      f.memory.reserve("request", "digest", randomUUID()),
    ).rejects.toMatchObject({ statusCode: 409 });
    const c = cosmos();
    await c.store.reserve("request", "digest", f.storyId);
    expect(c.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "creative:request:request",
        recordType: "creative",
        scopeId: "library",
        digest: "digest",
        storyId: f.storyId,
      }),
    );
    c.create.mockRejectedValue({ code: 409 });
    c.read.mockResolvedValue({
      resource: {
        recordType: "creative",
        kind: "request",
        digest: "digest",
        storyId: f.storyId,
      },
    });
    await c.store.reserve("request", "digest", f.storyId);
    await expect(
      c.store.reserve("request", "other", f.storyId),
    ).rejects.toMatchObject({ statusCode: 409 });
    c.read.mockRejectedValue({ code: 503 });
    await expect(
      c.store.reserve("request", "digest", f.storyId),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
  it("publishes chapter, history and all creative records only after all CAS checks pass", async () => {
    const f = fixture();
    const saved = await f.memory.transaction(
      f.storyId,
      [f.conversation, f.task, f.draft].map((record) => ({
        record,
        revision: null,
      })),
    );
    const [conversation, task, draft] = saved as [
      CreativeConversation,
      CreativeTask,
      CreativeDraft,
    ];
    const writes = [
      {
        record: { ...conversation, activeTaskId: task.id },
        revision: conversation.revision,
      },
      {
        record: {
          ...task,
          receipt: f.receipt,
          authorization: {
            id: "authorization",
            status: "consumed" as const,
            action: "create_chapter" as const,
            maxCreates: 1 as const,
          },
        },
        revision: task.revision,
      },
      { record: { ...draft, receipt: f.receipt }, revision: draft.revision },
    ];
    await expect(
      f.memory.transaction(
        f.storyId,
        writes.map((w, i) => (i === 2 ? { ...w, revision: "stale" } : w)),
        f.chapter,
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(f.content.heads.size).toBe(0);
    expect((await f.memory.task(f.storyId, task.id))?.receipt).toBeUndefined();
    f.content.failNext = true;
    await expect(
      f.memory.transaction(f.storyId, writes, f.chapter),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(f.content.heads.size).toBe(0);
    await f.memory.transaction(f.storyId, writes, f.chapter);
    expect(
      (await f.content.get(f.chapter.id, f.storyId))?.content.markdown,
    ).toBe("body");
    expect(f.content.history.size).toBe(1);
    const current = (
      await Promise.all([
        f.memory.conversation(f.storyId, conversation.id),
        f.memory.task(f.storyId, task.id),
        f.memory.draft(f.storyId, draft.id),
      ])
    ).map((record) => ({ record: record!, revision: record!.revision }));
    await expect(
      f.memory.transaction(f.storyId, current, f.chapter),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(f.content.history.size).toBe(1);
    expect((await f.memory.task(f.storyId, task.id))?.receipt).toEqual(
      f.receipt,
    );
    expect((await f.memory.draft(f.storyId, draft.id))?.receipt).toEqual(
      f.receipt,
    );
    expect(
      (await f.memory.conversation(f.storyId, conversation.id))?.activeTaskId,
    ).toBe(task.id);
    await expect(
      f.memory.transaction(f.storyId, writes, f.chapter),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(f.content.history.size).toBe(1);
  });
  it("rejects foreign partitions, duplicate writes, missing commit records and oversized transactions before publication", async () => {
    const f = fixture();
    for (const store of [f.memory, cosmos().store]) {
      await expect(
        store.transaction(f.storyId, [
          {
            record: { ...f.conversation, storyId: randomUUID() },
            revision: null,
          },
        ]),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        store.transaction(f.storyId, [
          { record: f.conversation, revision: null },
          { record: f.conversation, revision: null },
        ]),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        store.transaction(
          f.storyId,
          [{ record: f.task, revision: null }],
          f.chapter,
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
      await expect(
        store.transaction(f.storyId, [
          {
            record: { ...f.task, output: "x".repeat(1900 * 1024) },
            revision: null,
          },
        ]),
      ).rejects.toMatchObject({ statusCode: 413 });
    }
  });
  it("writes encoded IDs and conditional records plus create-only chapter/head history in one batch", async () => {
    const f = fixture(),
      c = cosmos();
    const task = {
      ...f.task,
      receipt: f.receipt,
      authorization: {
        id: "authorization",
        status: "consumed" as const,
        action: "create_chapter" as const,
        maxCreates: 1 as const,
      },
    };
    const writes = [
      f.conversation,
      task,
      { ...f.draft, receipt: f.receipt },
    ].map((record) => ({ record, revision: "old" }));
    const saved = await c.store.transaction(f.storyId, writes, f.chapter);
    expect(saved.map((record) => record.revision)).toEqual([
      "etag-0",
      "etag-1",
      "etag-2",
    ]);
    expect(c.batch).toHaveBeenCalledTimes(1);
    const [ops, partition] = c.batch.mock.calls[0]!;
    expect(partition).toBe(f.storyId);
    expect(ops).toHaveLength(5);
    expect(ops[0]).toMatchObject({
      operationType: "Replace",
      id: `creative:conversation:${f.conversation.id}`,
      ifMatch: "old",
      resourceBody: { recordType: "creative", projectId: f.storyId },
    });
    expect(ops.slice(3)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationType: "Create",
          resourceBody: expect.objectContaining({
            id: `version:${f.chapter.id}:1`,
            kind: "version",
          }),
        }),
        expect.objectContaining({
          operationType: "Create",
          resourceBody: expect.objectContaining({
            id: f.chapter.id,
            recordType: "head",
          }),
        }),
      ]),
    );
  });
  it("does not report success for missing per-operation results, bad etags, failed dependencies or exceptions", async () => {
    const f = fixture();
    for (const response of [
      { code: 200, result: [] },
      { code: 200, result: [{ statusCode: 201 }] },
      { code: 200, result: [{ statusCode: 201, eTag: 1 }] },
      { code: 200, result: [{ statusCode: 424, eTag: "tag" }] },
      { code: 200, result: [{ eTag: "tag" }] },
    ]) {
      const c = cosmos();
      c.batch.mockResolvedValue(response as never);
      await expect(
        c.store.transaction(f.storyId, [
          { record: f.conversation, revision: null },
        ]),
      ).rejects.toMatchObject({ statusCode: 503 });
    }
    for (const code of [409, 412, 500]) {
      const c = cosmos();
      c.batch.mockRejectedValue({ code });
      await expect(
        c.store.transaction(f.storyId, [
          { record: f.conversation, revision: null },
        ]),
      ).rejects.toMatchObject({ statusCode: code === 500 ? 503 : 409 });
      c.batch.mockResolvedValue({
        code: 200,
        result: [{ statusCode: code, eTag: "tag" }],
      });
      await expect(
        c.store.transaction(f.storyId, [
          { record: f.conversation, revision: null },
        ]),
      ).rejects.toMatchObject({ statusCode: code === 500 ? 503 : 409 });
    }
  });
  it("accepts only one concurrent create and one concurrent update from the same revision", async () => {
    const f = fixture();
    const create = () =>
      f.memory.transaction(f.storyId, [
        { record: f.conversation, revision: null },
      ]);
    expect(
      (await Promise.allSettled([create(), create()]))
        .map((result) => result.status)
        .sort(),
    ).toEqual(["fulfilled", "rejected"]);
    const conversation = (await f.memory.conversation(
      f.storyId,
      f.conversation.id,
    ))!;
    const update = (sessionId: string) =>
      f.memory.transaction(f.storyId, [
        {
          record: { ...conversation, sessionId },
          revision: conversation.revision,
        },
      ]);
    expect(
      (await Promise.allSettled([update("first"), update("second")]))
        .map((result) => result.status)
        .sort(),
    ).toEqual(["fulfilled", "rejected"]);
    expect(
      (await f.memory.conversation(f.storyId, conversation.id))?.sessionId,
    ).toBe("first");
  });
  it("rejects incomplete reservation responses and storage errors", async () => {
    const f = fixture();
    for (const response of [
      {},
      { statusCode: 201 },
      { resource: { _etag: "etag" } },
      { statusCode: 201, resource: { _etag: 1 } },
    ]) {
      const c = cosmos();
      c.create.mockResolvedValue(response);
      await expect(
        c.store.reserve("request", "digest", f.storyId),
      ).rejects.toMatchObject({ statusCode: 503 });
    }
  });
  it("retrieves isolated clean records and queries only unfinished tasks for recovery", async () => {
    const f = fixture(),
      c = cosmos();
    const raw = {
      ...f.task,
      id: `creative:task:${f.task.id}`,
      projectId: f.storyId,
      recordType: "creative",
      schemaVersion: 1,
      _etag: "etag",
      _rid: "internal",
    };
    c.read.mockResolvedValue({ resource: raw });
    expect(await c.store.task(f.storyId, f.task.id)).toEqual({
      ...f.task,
      revision: "etag",
    });
    expect(c.item).toHaveBeenCalledWith(
      `creative:task:${f.task.id}`,
      f.storyId,
    );
    c.fetchAll.mockResolvedValue({ resources: [raw] });
    expect(await c.store.tasks(f.storyId, f.conversation.id)).toEqual([
      { ...f.task, revision: "etag" },
    ]);
    expect(c.query.mock.calls[0]).toMatchObject([
      {
        query: expect.stringContaining("c.projectId = @storyId"),
        parameters: expect.arrayContaining([
          { name: "@storyId", value: f.storyId },
        ]),
      },
      { partitionKey: f.storyId },
    ]);
    await c.store.activeTasks();
    expect(c.query.mock.calls[1]).toMatchObject([
      {
        query: expect.stringContaining(
          "c.status IN ('interpreting', 'pending', 'running')",
        ),
      },
      { forceQueryPlan: true },
    ]);
    await f.memory.transaction(f.storyId, [
      { record: f.task, revision: null },
      {
        record: { ...f.task, id: randomUUID(), status: "succeeded" },
        revision: null,
      },
    ]);
    expect(await f.memory.activeTasks()).toHaveLength(1);
    expect(await f.memory.tasks(randomUUID(), f.conversation.id)).toEqual([]);
  });
});
