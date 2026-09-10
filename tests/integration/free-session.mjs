import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import console from "node:console";
import { setTimeout as delay } from "node:timers/promises";
import { creativeHarness } from "./creative-harness.mjs";
import { entity } from "../../src/server/entities.ts";
import { libraryContentHash } from "../../src/server/library-tools.ts";
const contexts = [];
const textOf = (m) =>
  typeof m.content === "string"
    ? m.content
    : m.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
const configureRuntime = (pi, streamFactory) => {
  const original = pi.runtime.streamSimple;
  pi.runtime.streamSimple = (model, context) => {
    contexts.push(JSON.parse(JSON.stringify(context)));
    const index = context.messages.findLastIndex((m) => m.role === "user");
    const input = JSON.parse(textOf(context.messages[index]));
    const results = context.messages
      .slice(index + 1)
      .filter((m) => m.role === "toolResult");
    let content,
      reason = "stop";
    if (!context.tools?.length) {
      const message = input.user_message;
      const search = message.includes("职业改成记者");
      const selected = message.includes("选定");
      const candidate = message.includes("候选");
      const word = "侦探",
        start = message.indexOf(word),
        change = "职业改成记者",
        cs = message.indexOf(change);
      content = [
        {
          type: "text",
          text: JSON.stringify({
            intent: selected
              ? "save_current"
              : candidate
                ? "draft"
                : search
                  ? "update_character"
                  : "discuss",
            evidence: { start: 0, end: message.length, text: message },
            target: {
              kind: "character",
              mode:
                selected || candidate ? "new" : search ? "search" : "unclear",
              predicates: search
                ? [
                    {
                      field: "occupation",
                      operator: "contains",
                      value: word,
                      evidence: { start, end: start + word.length, text: word },
                    },
                  ]
                : [],
            },
            ...(search
              ? {
                  changeEvidence: {
                    start: cs,
                    end: cs + change.length,
                    text: change,
                  },
                }
              : {}),
          }),
        },
      ];
    } else if (results.length === 0) {
      reason = "toolUse";
      content = [
        {
          type: "toolCall",
          id: randomUUID(),
          name: "library_vocabulary",
          arguments: {},
        },
      ];
    } else if (
      (input.user_message === "查阅侦探角色作为讨论资料" ||
        input.phase === "resolve") &&
      results.length < 3
    ) {
      const last = JSON.parse(textOf(results.at(-1)));
      assert.equal(last.outcome, "ok", JSON.stringify(last));
      const hit = last.data.items?.[0];
      if (results.length === 2) {
        assert.ok(hit, "Synthetic detective is discoverable");
        assert.equal("markdown" in hit, false);
      }
      reason = "toolUse";
      content = [
        {
          type: "toolCall",
          id: randomUUID(),
          name: results.length === 1 ? "search_library" : "read_library",
          arguments:
            results.length === 1
              ? { kind: "character", occupation: "侦探", limit: 5 }
              : { asset_id: hit.asset_id, revision: hit.revision },
        },
      ];
    } else if (
      input.phase === "execute" &&
      input.binding &&
      results.length < (input.binding.selectedDraft ? 2 : 3)
    ) {
      const last = JSON.parse(textOf(results.at(-1)));
      assert.equal(last.outcome, "ok", JSON.stringify(last));
      const selected = input.binding.selectedDraft;
      const ref = selected ?? last.data;
      reason = "toolUse";
      content = [
        {
          type: "toolCall",
          id: randomUUID(),
          name: "save_character",
          arguments:
            !selected && results.length === 1
              ? {
                  mode: "draft",
                  name: "合成记者",
                  markdown: "精确修改正文\r\n",
                  genres: [],
                  age_band: "",
                  occupation: "记者",
                }
              : {
                  mode: "commit",
                  draft_id: ref.draft_id,
                  draft_revision: ref.draft_revision,
                  draft_hash: ref.draft_hash,
                },
        },
      ];
    } else if (input.user_message.includes("候选") && results.length < 3) {
      const result = JSON.parse(textOf(results.at(-1)));
      assert.equal(result.outcome, "ok", JSON.stringify(result));
      reason = "toolUse";
      content = [
        {
          type: "toolCall",
          id: randomUUID(),
          name: results.length === 1 ? "save_character" : "read_artifact",
          arguments:
            results.length === 1
              ? {
                  mode: "draft",
                  name: "合成候选",
                  markdown: "精确候选正文",
                  genres: [],
                  age_band: "",
                }
              : {
                  draft_id: result.data.draft_id,
                  draft_revision: result.data.draft_revision,
                  draft_hash: result.data.draft_hash,
                },
        },
      ];
    } else {
      const result = JSON.parse(textOf(results.at(-1)));
      assert.equal(result.outcome, "ok", JSON.stringify(result));
      content = [{ type: "text", text: "已核对本轮资料与真实工具结果。" }];
    }
    const stream = streamFactory();
    stream.push({
      type: "done",
      reason,
      message: {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        content,
        stopReason: reason,
        usage: {
          input: 20,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 30,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    });
    return stream;
  };
  return () => {
    pi.runtime.streamSimple = original;
  };
};
const h = await creativeHarness({ freeSession: true, configureRuntime });
async function finish(id) {
  for (let i = 0; i < 1000; i++) {
    let task = await h.free.task(id);
    if (task.state === "committed") {
      await h.free.workflow.refresh(id);
      task = await h.free.task(id);
      if (task.executionRun?.status === "succeeded") return task;
    }
    if (
      ["succeeded", "failed", "interrupted", "clarifying"].includes(task.state)
    )
      return task;
    await delay(20);
  }
  throw Error("free task timeout");
}
try {
  const doc = await h.content.commit(
    entity("character", {
      name: "合成侦探",
      markdown: "仅用于本地协议验证。",
      genres: [],
      ageBand: "",
      sourceMetadata: { occupation: "侦探" },
    }),
    null,
  );
  const ref = {
    type: "asset",
    kind: "character",
    asset_id: doc.id,
    revision: doc.revision,
    version: 1,
    content_hash: libraryContentHash(doc.content),
  };
  const input = {
    clientRequestId: randomUUID(),
    message: "找到之前那个侦探角色，把职业改成记者并保存",
    provider: "deepseek",
    model: "deepseek-v4-flash",
  };
  assert.equal(
    input.initialRefs,
    undefined,
    "natural target acceptance must not preselect an asset",
  );
  const opened = await h.request("/api/creative/free/conversations", {
    ...input,
    clientRequestId: randomUUID(),
    message: "查阅侦探角色作为讨论资料",
  });
  const researched = await finish(opened.task.id);
  assert.equal(researched.state, "succeeded", JSON.stringify(researched));
  assert.equal(researched.binding, undefined);
  assert.deepEqual(
    (await h.free.conversation(opened.conversation.id)).initialRefs,
    [],
  );
  const researchView = await h.request(
    `/api/creative/free/conversations/${opened.conversation.id}/tasks/${researched.id}`,
  );
  assert.deepEqual(
    researchView.sources.map((s) => [s.origin, s.ref]),
    [["agent_read", ref]],
  );
  const callbackStart = h.callbacks.length;
  const taskPath = `/api/creative/free/conversations/${opened.conversation.id}/tasks`;
  const first = { ...opened, ...(await h.request(taskPath, input)) };
  const task = await finish(first.task.id);
  assert.equal(
    task.state,
    "committed",
    JSON.stringify({
      task,
      run: task.resolutionRun?.runId
        ? await h.mochiRequest(`/v1/runs/${task.resolutionRun.runId}`)
        : null,
      contexts: contexts.map((c) => ({
        tools: c.tools?.map((t) => t.name),
        messages: c.messages.slice(-2),
      })),
    }),
  );
  assert.equal(task.binding.target.asset_id, doc.id);
  assert.equal(
    task.input.message,
    "找到之前那个侦探角色，把职业改成记者并保存",
  );
  assert.deepEqual(task.input.refs, []);
  assert.deepEqual(task.resolutionEvidence.candidateIds, [doc.id]);
  assert.deepEqual(task.resolutionEvidence.candidateRevisions, [doc.revision]);
  assert.equal(task.resolutionEvidence.matchedId, doc.id);
  assert.equal(task.resolutionEvidence.headRevision, doc.revision);
  assert.equal(task.resolutionEvidence.complete, true);
  assert.equal(task.resolutionEvidence.policyVersion, "target-v2");
  assert.ok(task.resolutionRun.runId && task.executionRun.runId);
  assert.equal(task.resolutionRun.sessionId, task.executionRun.sessionId);
  assert.ok(task.resolutionRun.executionUsage.model_calls > 0);
  assert.ok(task.executionRun.payload.budget.max_model_calls < 8);
  assert.deepEqual(
    h.callbacks
      .slice(callbackStart)
      .map((c) => [c.protocol_version, c.scope.phase, c.tool.name]),
    [
      [2, "resolve", "library_vocabulary"],
      [2, "resolve", "search_library"],
      [2, "resolve", "read_library"],
      [2, "execute", "library_vocabulary"],
      [2, "execute", "save_character"],
      [2, "execute", "save_character"],
    ],
  );
  const savedSession = (await h.free.conversation(first.conversation.id))
    .sessionId;
  const before = contexts.length;
  assert.equal(
    (
      await h.request(
        `/api/creative/free/conversations/by-request/${input.clientRequestId}`,
      )
    ).task.id,
    task.id,
  );
  assert.equal((await h.request(taskPath, input)).task.id, task.id);
  assert.equal(contexts.length, before);
  const follow = await h.request(
    `/api/creative/free/conversations/${first.conversation.id}/tasks`,
    {
      clientRequestId: randomUUID(),
      message: "换个话题，讨论新故事",
      provider: input.provider,
      model: input.model,
    },
  );
  const next = await finish(follow.task.id);
  assert.equal(next.state, "succeeded", JSON.stringify(next));
  assert.equal(
    (await h.free.conversation(first.conversation.id)).sessionId,
    savedSession,
  );
  assert.equal(next.binding, undefined);
  assert.ok(
    contexts
      .filter((c) => c.tools?.length)
      .at(-1)
      .messages.some((m) => m.role === "toolResult"),
  );
  const events = await h.request(
    `/api/creative/free/conversations/${first.conversation.id}/tasks/${task.id}/events?after=0`,
  );
  assert.ok(events.events.length > 0);
  assert.deepEqual(
    [...new Set(events.events.map((e) => e.phase))],
    ["resolve", "execute"],
  );
  assert.equal((await h.content.get(doc.id, null)).currentVersion, 2);
  assert.equal(
    (await h.content.get(doc.id, null)).content.sourceMetadata.occupation,
    "记者",
  );
  assert.equal(task.receipt.kind, "character_updated");
  const draftTask = await h.request(
    `/api/creative/free/conversations/${first.conversation.id}/tasks`,
    {
      clientRequestId: randomUUID(),
      message: "构思新角色候选",
      provider: input.provider,
      model: input.model,
    },
  );
  const drafted = await finish(draftTask.task.id);
  assert.equal(drafted.state, "succeeded", JSON.stringify(drafted));
  assert.equal(drafted.binding, undefined);
  const groups = await h.request(
    `/api/creative/free/conversations/${first.conversation.id}/groups`,
  );
  assert.equal(groups.items.length, 2);
  const candidateGroup = groups.items.find(
    (g) => g.createdByTaskId === drafted.id,
  );
  const versions = await h.request(
    `/api/creative/free/conversations/${first.conversation.id}/groups/${candidateGroup.id}/drafts`,
  );
  assert.equal(versions.items[0].ordinal, 1);
  const sources = await h.request(
    `/api/creative/free/conversations/${first.conversation.id}/tasks/${drafted.id}`,
  );
  assert.equal(sources.sources[0].origin, "agent_read");
  assert.equal(sources.sources[0].ref.draft_id, versions.items[0].draft_id);
  const draftEvents = await h.request(
    `/api/creative/free/conversations/${first.conversation.id}/tasks/${drafted.id}/events?after=0`,
  );
  assert.ok(JSON.stringify(draftEvents).includes(versions.items[0].draft_id));
  const exact = versions.items[0];
  const saved = await h.request(
    `/api/creative/free/conversations/${first.conversation.id}/tasks`,
    {
      clientRequestId: randomUUID(),
      message: "保存选定角色稿",
      provider: input.provider,
      model: input.model,
      refs: [
        {
          type: "candidate",
          group_id: exact.group_id,
          draft_id: exact.draft_id,
          draft_revision: exact.draft_revision,
          draft_hash: exact.draft_hash,
        },
      ],
    },
  );
  h.loseNextCommitResponse();
  const committed = await finish(saved.task.id);
  assert.equal(committed.state, "committed", JSON.stringify(committed));
  assert.equal(committed.receipt.kind, "character_created");
  assert.equal(committed.receipt.draft_id, exact.draft_id);
  const master = await h.content.get(committed.receipt.target.asset_id, null);
  const frozen = await h.free.candidates.get(
    first.conversation.id,
    exact.draft_id,
  );
  assert.deepEqual(master.content, frozen.payload.content);
  const viewed = await h.request(
    `/api/creative/free/conversations/${first.conversation.id}/drafts/${exact.draft_id}`,
  );
  assert.deepEqual(viewed.receipt, committed.receipt);
  assert.deepEqual(viewed.claim, {
    operationId: committed.operationId,
    status: "committed",
  });
  const callback = h.callbacks.findLast((c) => c.arguments.mode === "commit");
  const retried = await h.callback(callback);
  assert.deepEqual(retried.receipt, committed.receipt);
  assert.equal((await h.content.get(master.id, null)).currentVersion, 1);
  const old = await h.free.references.read(first.conversation.id, ref);
  assert.equal(old.content.name, "合成侦探");
  assert.equal(
    (await h.free.conversation(first.conversation.id)).sessionId,
    savedSession,
  );
  console.log(
    JSON.stringify({
      status: "passed",
      writeOrigin: h.origin,
      mochiOrigin: h.mochiOrigin,
      scenario:
        "free v2 real HTTP/Pi resolved update, exact selected character save, lost response receipt recovery and same session",
      conversationId: first.conversation.id,
      sessionId: savedSession,
      naturalTarget: {
        taskId: task.id,
        refs: task.input.refs,
        evidence: task.resolutionEvidence,
        receipt: task.receipt,
      },
      selectedCandidate: exact,
      selectedReceipt: committed.receipt,
      actualSources: researchView.sources,
      providerCalls: contexts.length,
      callbacks: h.callbacks.length,
      events: events.events.length,
    }),
  );
} finally {
  await h.close();
}
