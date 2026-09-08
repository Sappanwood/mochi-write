import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import console from "node:console";
import { creativeHarness } from "./creative-harness.mjs";
import { initializationProvider } from "./initialization-provider.mjs";

const provider = initializationProvider();
Object.assign(provider.control, {
  mode: "chapter",
  intent: "draft",
  assets: [],
});
const h = await creativeHarness({
  configureRuntime: provider.configureRuntime,
  autoExecute: false,
});
const firstRequest = () => ({
  clientRequestId: randomUUID(),
  provider: "deepseek",
  model: "deepseek-v4-flash",
  message: "只展示合成首章草稿，暂不建立作品。",
});
const taskPath = (conversation) =>
  `/api/stories/${conversation.storyId}/creative/tasks`;
async function queuedIntent(conversation, task) {
  return h.waitTask(conversation.storyId, task.id, (current) =>
    Boolean(current.intentRunId),
  );
}
async function assertRejectedSelection(conversation, active, selectedDraft) {
  const before = {
    tasks: (await h.records.tasks(conversation.storyId, conversation.id)).map(
      (task) => task.id,
    ),
    calls: provider.calls.length,
    runs: h.store.runs.size,
    callbacks: h.callbacks.length,
    task: await h.creative.task(conversation.storyId, active.id),
    conversation: await h.records.conversation(
      conversation.storyId,
      conversation.id,
    ),
  };
  const request = {
    ...firstRequest(),
    conversationId: conversation.id,
    message: "保存这个版本",
    selectedDraft,
  };
  await h.request(taskPath(conversation), request, 409);
  assert.deepEqual(
    (await h.records.tasks(conversation.storyId, conversation.id)).map(
      (task) => task.id,
    ),
    before.tasks,
    "An invalid selected draft must not leave an interpreting task",
  );
  assert.equal(
    await h.records.task(conversation.storyId, request.clientRequestId),
    undefined,
  );
  assert.deepEqual(
    await h.creative.task(conversation.storyId, active.id),
    before.task,
    "Rejected input must not cancel or revoke the existing task",
  );
  assert.deepEqual(
    await h.records.conversation(conversation.storyId, conversation.id),
    before.conversation,
  );
  assert.equal(provider.calls.length, before.calls);
  assert.equal(h.store.runs.size, before.runs);
  assert.equal(h.callbacks.length, before.callbacks);
  assert.equal(
    (await h.mochiRequest(`/v1/runs/${active.intentRunId}`)).status,
    "queued",
  );
}

try {
  const first = await h.request("/api/creative/conversations", firstRequest());
  const a = first.conversation;
  await queuedIntent(a, first.task);
  await h.pump();
  await h.waitTask(a.storyId, first.task.id, (task) => Boolean(task.runId));
  await h.pump();
  const finished = await h.waitTask(a.storyId, first.task.id);
  assert.equal(finished.status, "succeeded", finished.error);
  assert.equal(await h.content.get(a.storyId, a.storyId), undefined);
  const drafts = await h.request(
    `/api/stories/${a.storyId}/creative/drafts?conversationId=${a.id}`,
  );
  assert.equal(drafts.items.length, 1);
  const draft = drafts.items[0];
  assert.equal(draft.artifactKind, "story_initialization");
  const ref = {
    draft_id: draft.id,
    draft_revision: draft.draftRevision,
    draft_hash: draft.hash,
  };
  const second = await h.request("/api/creative/conversations", firstRequest());
  const b = second.conversation;
  const activeB = await queuedIntent(b, second.task);
  await assertRejectedSelection(b, activeB, ref);

  const valid = {
    ...firstRequest(),
    conversationId: a.id,
    message: "保存这个版本",
    selectedDraft: ref,
  };
  const selected = await h.request(taskPath(a), valid);
  const activeA = await queuedIntent(a, selected);
  const beforeReplay = provider.calls.length;
  const duplicate = await h.request(taskPath(a), valid);
  assert.equal(duplicate.id, selected.id);
  assert.equal(provider.calls.length, beforeReplay);
  await assertRejectedSelection(a, activeA, {
    ...ref,
    draft_hash: "sha256:" + "b".repeat(64),
  });

  const actual = h.callbacks.find(
    (callback) => callback.tool.name === "initialize_story",
  );
  assert.ok(actual);
  const beforeCallbacks = {
    records: globalThis.structuredClone([...h.records.values]),
    heads: globalThis.structuredClone([...h.content.heads]),
    calls: provider.calls.length,
  };
  for (const name of ["initialize_story", "read_library"]) {
    const callback = {
      ...actual,
      invocation_id: randomUUID(),
      tool_call_id: randomUUID(),
      tool: { name, version: "1" },
      arguments:
        name === "initialize_story"
          ? actual.arguments
          : { asset_id: randomUUID(), revision: "1" },
    };
    await h.callback(callback, true, 401);
    for (const changed of [
      { ...callback, session_id: randomUUID() },
      {
        ...callback,
        scope: { ...callback.scope, story_id: b.storyId },
      },
      {
        ...callback,
        scope: { ...callback.scope, operation_id: randomUUID() },
      },
    ]) {
      const denied = await h.callback(changed);
      assert.equal(denied.outcome, "error");
      assert.equal(denied.error.code, "forbidden_scope");
    }
  }
  await h.mochiRequest(`/v1/runs/${finished.runId}`, undefined, 403, true);
  await h.mochiRequest(
    `/v1/sessions/${actual.session_id}/history?format=pi-v1`,
    undefined,
    403,
    true,
  );
  await h.mochiRequest(
    `/v1/runs/${finished.runId}/operations/verify`,
    {},
    403,
    true,
  );
  assert.deepEqual([...h.records.values], beforeCallbacks.records);
  assert.deepEqual([...h.content.heads], beforeCallbacks.heads);
  assert.equal(provider.calls.length, beforeCallbacks.calls);
  assert.equal(await h.content.get(a.storyId, a.storyId), undefined);
  assert.equal(await h.content.get(b.storyId, b.storyId), undefined);
  console.log(
    "initialization isolation: real HTTP/Pi rejects foreign or changed selected drafts before task mutation, and preserves callback/app identity boundaries",
  );
} finally {
  await h.close();
}
