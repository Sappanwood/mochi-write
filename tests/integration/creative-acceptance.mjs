import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import console from "node:console";
import { creativeHarness } from "./creative-harness.mjs";
import { controlledCreativeProvider } from "./creative-provider.mjs";
const provider = controlledCreativeProvider();
let budgetOverride;
const h = await creativeHarness({
  configureRuntime: provider.configureRuntime,
  transformRun: (body) =>
    budgetOverride === undefined
      ? body
      : { ...body, budget: { ...body.budget, ...budgetOverride } },
});
try {
  const story = await h.story();
  const foreign = await h.story("另一本隔离故事");
  const base = `/api/stories/${story.id}/creative`;
  const conversation = await h.request(base + "/conversations", {});
  const submit = async (message, extra = {}) => {
    const task = await h.request(base + "/tasks", {
      clientRequestId: randomUUID(),
      conversationId: conversation.id,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      message,
      ...extra,
    });
    return h.waitTask(story.id, task.id);
  };
  provider.control.intent = "draft";
  const first = await submit("先写灯塔一章给我看，不保存");
  assert.equal(first.status, "succeeded");
  assert.equal(first.receipt, undefined);
  assert.equal(first.artifacts.length, 1);
  assert.equal(
    (await h.content.list({ projectId: story.id, kind: "chapter" })).items
      .length,
    0,
  );
  const ref = first.artifacts[0];
  const draft = await h.request(base + `/drafts/${ref.draft_id}`);
  assert.notEqual(first.output, draft.body);
  const startedConversation = await h.creative.requireConversation(
    story.id,
    conversation.id,
  );
  const beforeSaveHistory = await h.mochiRequest(
    `/v1/sessions/${startedConversation.sessionId}/history?format=pi-v1`,
  );
  assert.ok(
    beforeSaveHistory.messages.some(
      (entry) => (entry.message ?? entry).role === "toolResult",
    ),
  );
  provider.control.intent = "save_current";
  const saved = await submit("保存我选中的这个版本", { selectedDraft: ref });
  assert.equal(saved.status, "succeeded", saved.error);
  assert.ok(saved.receipt);
  const chapter = await h.content.get(saved.receipt.chapter_id, story.id);
  assert.equal(chapter.content.markdown, draft.body);
  assert.equal(saved.receipt.content_hash, ref.draft_hash);
  assert.equal(saved.runId === first.runId, false);
  const runs = [first.runId, saved.runId].map((id) => h.store.runs.get(id));
  assert.equal(runs[0].session_id, runs[1].session_id);
  const finalMessages = await h.mochiRequest(
    `/v1/sessions/${startedConversation.sessionId}/history?format=pi-v1`,
  );
  assert.ok(finalMessages.messages.length > beforeSaveHistory.messages.length);
  const before = provider.calls.length;
  await h.request(base + `/tasks/${saved.id}`);
  await h.request(base + `/drafts/${draft.id}`);
  await h.restartMochi();
  assert.equal(
    (await h.mochiRequest(`/v1/runs/${saved.runId}`)).status,
    "succeeded",
  );
  assert.equal(provider.calls.length, before);
  await h.mochiRequest(`/v1/runs/${saved.runId}`, undefined, 403, true);
  await h.mochiRequest(
    `/v1/sessions/${startedConversation.sessionId}/history?format=pi-v1`,
    undefined,
    403,
    true,
  );
  await h.request(
    `/api/stories/${foreign.id}/creative/tasks/${saved.id}`,
    undefined,
    404,
  );
  const actualCallback = h.callbacks.find(
    (call) => call.arguments?.mode === "commit",
  );
  await h.callback(actualCallback, true, 401);
  const forged = await h.callback({
    ...actualCallback,
    invocation_id: randomUUID(),
    scope: { ...actualCallback.scope, story_id: foreign.id },
  });
  assert.equal(forged.error.code, "forbidden_scope");
  const repeated = await h.callback({
    ...actualCallback,
    invocation_id: randomUUID(),
    tool_call_id: randomUUID(),
  });
  assert.deepEqual(repeated.receipt, saved.receipt);
  assert.equal(
    (await h.content.list({ projectId: story.id, kind: "chapter" })).items
      .length,
    1,
  );
  console.log(
    JSON.stringify({
      ok: true,
      acceptance: "draft_exact_save_history_isolation",
      real_http_services: 2,
      prior_tool_history_in_followup: true,
      persisted_restart_no_model_call: true,
    }),
  );

  provider.control.intent = "create_and_save";
  provider.control.failAfterCommit = true;
  h.loseNextCommitResponse();
  const failed = await submit("再写一章并保存，模拟保存后的网络与模型故障");
  assert.equal(failed.status, "failed");
  assert.ok(failed.receipt);
  assert.equal(failed.operationStatus, "committed");
  const committedCall = h.callbacks.find(
    (call) =>
      call.scope.operation_id === failed.operationId &&
      call.arguments?.mode === "commit",
  );
  const retry = await h.callback({
    ...committedCall,
    invocation_id: randomUUID(),
    tool_call_id: randomUUID(),
  });
  assert.deepEqual(retry.receipt, failed.receipt);
  const verified = await h.request(base + `/tasks/${failed.id}/verify`, {});
  assert.deepEqual(verified.receipt, failed.receipt);
  assert.equal(
    (await h.content.list({ projectId: story.id, kind: "chapter" })).items
      .length,
    2,
  );
  console.log(
    JSON.stringify({
      ok: true,
      acceptance: "lost_commit_response_then_model_failure",
      receipt_retained: true,
      changed_invocation_exact_once: true,
    }),
  );

  provider.control.failAfterCommit = false;
  provider.control.intent = "draft";
  for (const mode of ["unknown_tool", "invalid_arguments", "repeat_search"]) {
    provider.control.mode = mode;
    budgetOverride =
      mode === "repeat_search" ? { max_tool_calls: 1 } : undefined;
    const beforeCallbacks = h.callbacks.length;
    const task = await submit(`隔离工具边界：${mode}`);
    assert.equal(task.receipt, undefined);
    assert.equal(task.artifacts.length, 0);
    const events = await h.mochiRequest(
      `/v1/runs/${task.runId}/events?after=0`,
    );
    if (mode === "repeat_search") {
      assert.equal(task.status, "failed");
      assert.equal(h.callbacks.length - beforeCallbacks, 1);
    } else {
      assert.equal(h.callbacks.length, beforeCallbacks);
      const history = h.store.runs.get(task.runId).messages;
      assert.ok(
        history.some((entry) => {
          const msg = entry.message ?? entry;
          return (
            msg.role === "toolResult" &&
            (msg.isError || JSON.stringify(msg).includes("invalid_arguments"))
          );
        }),
      );
    }
    assert.ok(events.events.length > 0);
    console.log(
      JSON.stringify({
        ok: true,
        acceptance: mode,
        callback_count: h.callbacks.length - beforeCallbacks,
        no_chapter: true,
      }),
    );
  }
  budgetOverride = { max_model_calls: 1 };
  const modelBounded = await submit("限制单次模型调用");
  assert.equal(modelBounded.status, "failed");
  assert.equal(h.store.runs.get(modelBounded.runId).error, "model_call_limit");
  assert.equal(modelBounded.receipt, undefined);
  provider.control.mode = "normal";
  provider.control.intent = "create_and_save";
  budgetOverride = { max_write_operations: 0 };
  const writeBounded = await submit("用户允许保存但执行写入预算为零");
  assert.equal(writeBounded.status, "failed");
  assert.equal(
    h.store.runs.get(writeBounded.runId).error,
    "write_operation_limit",
  );
  assert.equal(writeBounded.receipt, undefined);
  assert.equal(writeBounded.artifacts.length, 1);
  assert.equal(
    h.callbacks.filter(
      (call) =>
        call.scope.operation_id === writeBounded.operationId &&
        call.arguments?.mode === "commit",
    ).length,
    0,
  );
  assert.equal(
    (await h.content.list({ projectId: story.id, kind: "chapter" })).items
      .length,
    2,
  );
  console.log(
    JSON.stringify({
      ok: true,
      acceptance: "model_and_write_budgets",
      draft_allowed_without_commit_budget: true,
      no_extra_chapter: true,
    }),
  );
} finally {
  await h.close();
}
