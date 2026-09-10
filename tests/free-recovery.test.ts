import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { FreeSession } from "../src/server/free-session.js";
import { FreeCallback } from "../src/server/free-callback.js";
import { freeScope } from "../src/server/free-workflow.js";
import { MemoryFreeStore } from "./support/free-store.js";
import { MemoryStore } from "./support/memory-store.js";
import { AppError } from "../src/shared/model.js";
import type {
  FreeConversation,
  Ledger,
  ReceiptV2,
} from "../src/shared/free.js";
const input = () => ({
  clientRequestId: randomUUID(),
  message: "建立新故事并保存",
  provider: "fake",
  model: "fake",
});
const classification = (message: string) => ({
  intent: "initialize_story",
  evidence: { start: 0, end: message.length, text: message },
  target: { mode: "new", kind: "story", predicates: [] },
});
function fixture() {
  const records = new MemoryFreeStore(),
    content = new MemoryStore();
  return {
    records,
    content,
    free: new FreeSession(
      content,
      records,
      {
        async request() {
          throw new AppError(503, "offline");
        },
      },
      { autoStart: false },
    ),
  };
}
it("revoked tombstone defeats a late activation across story partition", async () => {
  const f = fixture();
  const { task } = await f.free.start(input());
  await f.free.resolve(
    task.id,
    classification(task.input.message),
    "classifier",
  );
  const bound = await f.free.task(task.id),
    d = (await f.free.operations.directory(task.operationId))!;
  f.records.rows.delete(`${d.partition}:op:${task.operationId}`);
  await f.free.cancel(task.id);
  expect((await f.free.operations.ledger(d))?.status).toBe("revoked");
  await expect(f.free.operations.activate(bound)).rejects.toThrow();
  expect(f.content.heads.size).toBe(0);
});
it("target commit survives failed library projection and verifies original receipt without business writes", async () => {
  const f = fixture();
  const { task } = await f.free.start(input());
  await f.free.resolve(
    task.id,
    classification(task.input.message),
    "classifier",
  );
  const d = (await f.free.operations.directory(task.operationId))!,
    op = (await f.free.operations.ledger(d))!;
  const draft = {
    type: "candidate" as const,
    group_id: randomUUID(),
    draft_id: randomUUID(),
    draft_revision: "1" as const,
    draft_hash: "sha256:" + "a".repeat(64),
  };
  const receipt: ReceiptV2 = {
    protocol_version: 2,
    operation_id: task.operationId,
    status: "committed",
    conversation_id: task.conversationId,
    task_id: task.id,
    kind: "story_initialized",
    target: d.target,
    draft_id: draft.draft_id,
    draft_revision: "1",
    draft_hash: draft.draft_hash,
    content_hash: draft.draft_hash,
    revision: "1",
    assets: [],
  };
  await f.records.transaction(d.partition, [
    {
      record: { ...op, status: "committed", draftRef: draft, receipt },
      revision: op.revision,
    },
  ]);
  f.records.failPartition = "library";
  await expect(f.free.verify(task.id)).rejects.toThrow();
  expect((await f.free.operation(task.operationId)).receipt).toEqual(receipt);
  f.records.failPartition = undefined;
  expect((await f.free.verify(task.id)).receipt).toEqual(receipt);
  expect((await f.free.verify(task.id)).receipt).toEqual(receipt);
  expect(
    (await f.free.conversation(task.conversationId)).associatedAssets,
  ).toEqual([d.target]);
  const sessionId = randomUUID(),
    runId = randomUUID();
  const c = await f.free.conversation(task.conversationId);
  c.sessionId = sessionId;
  await f.records.transaction("library", [{ record: c, revision: c.revision }]);
  await f.free.change(task.id, (t) => {
    t.executionRun = {
      key: task.id + ":execute:1",
      sessionId,
      runId,
      dispatchStarted: true,
      status: "succeeded",
      payload: {},
    };
  });
  await f.free.cancel(task.id);
  const { task_id: _task, ...scope } = freeScope(
    await f.free.task(task.id),
    "execute",
  );
  void _task;
  const response = await new FreeCallback(f.free).invoke({
    protocol_version: 2,
    app_id: "mochi-write",
    session_id: sessionId,
    run_id: runId,
    task_id: task.id,
    scope,
    tool_call_id: "repeat",
    invocation_id: randomUUID(),
    tool: { name: "initialize_story", version: "2" },
    arguments: {
      mode: "commit",
      draft_id: draft.draft_id,
      draft_revision: "1",
      draft_hash: draft.draft_hash,
    },
  });
  expect(response).toMatchObject({ outcome: "ok", receipt });
  expect(f.content.heads.size).toBe(0);
});
it("unknown original execution is queried on verify without resubmission", async () => {
  const records = new MemoryFreeStore();
  const calls: string[] = [];
  const sessionId = randomUUID(),
    runId = randomUUID();
  const free = new FreeSession(
    new MemoryStore(),
    records,
    {
      async request<T>(path: string, body?: unknown) {
        calls.push(path);
        expect(body).toBeUndefined();
        return {
          session_id: sessionId,
          run_id: runId,
          status: "succeeded",
          result: { text: "original output" },
          execution_usage: { model_calls: 1, tool_calls: 0, duration_ms: 1 },
        } as T;
      },
    },
    { autoStart: false },
  );
  const { task } = await free.start(input());
  await free.change(task.id, (t) => {
    t.state = "interrupted";
    t.executionRun = {
      key: task.id + ":execute:1",
      sessionId,
      dispatchStarted: true,
      payload: {},
    };
  });
  const result = await free.verify(task.id);
  expect(result.executionRun?.runId).toBe(runId);
  expect(result.output).toBe("original output");
  expect(calls).toEqual([
    `/v1/runs/by-key?key=${encodeURIComponent(task.id + ":execute:1")}`,
  ]);
});
it("accepts authentic Mochi v2 callback envelope and rejects all resolve writes", async () => {
  const f = fixture();
  const { conversation, task } = await f.free.start(input());
  const sessionId = randomUUID(),
    runId = randomUUID();
  const c = await f.free.conversation(conversation.id);
  c.sessionId = sessionId;
  await f.records.transaction("library", [{ record: c, revision: c.revision }]);
  await f.free.change(task.id, (t) => {
    t.resolutionRun = {
      key: task.id + ":resolve:1",
      sessionId,
      dispatchStarted: true,
      payload: {},
    };
  });
  const current = await f.free.task(task.id);
  const { task_id: _taskId, ...scope } = freeScope(current, "resolve");
  void _taskId;
  const callback = {
    protocol_version: 2,
    app_id: "mochi-write",
    session_id: sessionId,
    run_id: runId,
    task_id: task.id,
    scope,
    tool_call_id: "provider-tool-1",
    invocation_id: randomUUID(),
    tool: { name: "library_vocabulary", version: "1" },
    arguments: {},
  };
  const endpoint = new FreeCallback(f.free);
  expect((await endpoint.invoke(callback)).outcome).toBe("ok");
  expect(
    (
      await endpoint.invoke({
        ...callback,
        tool: { name: "save_character", version: "2" },
        arguments: { mode: "draft" },
      })
    ).outcome,
  ).toBe("error");
});
it("cancel with unreachable target leaves new request undispatched", async () => {
  const f = fixture();
  const { task } = await f.free.start(input());
  await f.free.resolve(
    task.id,
    classification(task.input.message),
    "classifier",
  );
  const d = (await f.free.operations.directory(task.operationId))!;
  f.records.failPartition = d.partition;
  expect((await f.free.cancel(task.id)).state).toBe("cancel_pending");
  await expect(f.free.submit(task.conversationId, input())).rejects.toThrow(
    "previous_operation_pending",
  );
  expect((await f.records.list<FreeConversation>("conversation")).length).toBe(
    1,
  );
  expect((await f.records.list<Ledger>("op")).length).toBe(0);
});
it("unknown session creation is durable and never repeated by retry or read recovery", async () => {
  const records = new MemoryFreeStore();
  let creates = 0;
  const free = new FreeSession(
    new MemoryStore(),
    records,
    {
      async request<T>(path: string) {
        if (path === "/v1/models")
          return { models: [{ provider: "fake", id: "fake" }] } as T;
        if (path === "/v1/sessions") {
          creates++;
          throw new AppError(503, "response lost");
        }
        throw Error("unexpected request");
      },
    },
    { autoStart: false },
  );
  const request = input();
  const { task } = await free.start(request);
  await expect(free.workflow.session(task)).rejects.toThrow();
  await expect(free.workflow.session(task)).rejects.toThrow(
    "session_creation_unknown",
  );
  expect((await free.start(request)).task.id).toBe(task.id);
  expect((await free.byRequest(request.clientRequestId)).task.id).toBe(task.id);
  expect(creates).toBe(1);
});
it("story discovery cursors survive consecutive authenticated callbacks", async () => {
  const f = fixture();
  const storyId = randomUUID(),
    now = new Date().toISOString();
  const make = (id: string, kind: "story" | "chapter", name: string) => ({
    schemaVersion: 1 as const,
    id,
    kind,
    projectId: storyId,
    createdAt: now,
    updatedAt: now,
    currentVersion: 1,
    status: "ready" as const,
    content: {
      name,
      markdown: name,
      genres: [],
      ageBand: "",
      sourceMetadata: {},
    },
  });
  const story = await f.content.commit(
    make(storyId, "story", "合成故事"),
    null,
  );
  await f.content.commit(make(randomUUID(), "chapter", "甲"), null);
  await f.content.commit(make(randomUUID(), "chapter", "乙"), null);
  const { libraryContentHash } = await import("../src/server/library-tools.js");
  const { conversation, task } = await f.free.start({
    ...input(),
    initialRefs: [
      {
        type: "asset",
        kind: "story",
        asset_id: storyId,
        story_id: storyId,
        revision: story.revision,
        version: 1,
        content_hash: libraryContentHash(story.content),
      },
    ],
  });
  const sessionId = randomUUID(),
    runId = randomUUID();
  const c = await f.free.conversation(conversation.id);
  c.sessionId = sessionId;
  await f.records.transaction("library", [{ record: c, revision: c.revision }]);
  await f.free.change(task.id, (t) => {
    t.executionRun = {
      key: task.id + ":execute:1",
      sessionId,
      dispatchStarted: true,
      payload: {},
    };
  });
  const { task_id: _task, ...scope } = freeScope(
    await f.free.task(task.id),
    "execute",
  );
  void _task;
  const callback = {
    protocol_version: 2,
    app_id: "mochi-write",
    session_id: sessionId,
    run_id: runId,
    task_id: task.id,
    scope,
    tool_call_id: "page",
    invocation_id: randomUUID(),
    tool: { name: "search_assets", version: "2" },
    arguments: { story_id: storyId, query: "", limit: 1 },
  };
  const endpoint = new FreeCallback(f.free);
  const first = await endpoint.invoke(callback);
  expect(first.outcome).toBe("ok");
  const cursor = (first as { data: { next_cursor: string } }).data.next_cursor;
  expect(cursor).toBeTruthy();
  expect(
    (
      await endpoint.invoke({
        ...callback,
        invocation_id: randomUUID(),
        arguments: { ...callback.arguments, cursor },
      })
    ).outcome,
  ).toBe("ok");
  expect(
    (
      await endpoint.invoke({
        ...callback,
        invocation_id: randomUUID(),
        arguments: { ...callback.arguments, story_id: randomUUID() },
      })
    ).outcome,
  ).toBe("error");
});
