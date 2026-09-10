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
      const search = message.includes("侦探");
      const word = "侦探",
        start = message.indexOf(word),
        change = "职业改成记者",
        cs = message.indexOf(change);
      content = [
        {
          type: "text",
          text: JSON.stringify({
            intent: search ? "update_character" : "discuss",
            evidence: { start: 0, end: message.length, text: message },
            target: {
              kind: "character",
              mode: search ? "search" : "unclear",
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
    } else {
      const result = JSON.parse(textOf(results.at(-1)));
      assert.equal(result.outcome, "ok", JSON.stringify(result));
      content = [
        { type: "text", text: "已核对本轮资料；正式保存工具由后续切片接入。" },
      ];
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
    const task = await h.free.task(id);
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
    initialRefs: [ref],
  };
  const first = await h.request("/api/creative/free/conversations", input);
  const task = await finish(first.task.id);
  assert.equal(
    task.state,
    "succeeded",
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
  assert.ok(task.resolutionRun.runId && task.executionRun.runId);
  assert.equal(task.resolutionRun.sessionId, task.executionRun.sessionId);
  assert.ok(task.resolutionRun.executionUsage.model_calls > 0);
  assert.ok(task.executionRun.payload.budget.max_model_calls < 8);
  assert.deepEqual(
    h.callbacks.map((c) => [c.protocol_version, c.scope.phase, c.tool.name]),
    [
      [2, "resolve", "library_vocabulary"],
      [2, "execute", "library_vocabulary"],
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
  assert.equal(
    (await h.request("/api/creative/free/conversations", input)).task.id,
    task.id,
  );
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
  assert.equal((await h.content.get(doc.id, null)).currentVersion, 1);
  console.log(
    JSON.stringify({
      status: "passed",
      scenario:
        "free v2 real HTTP/Pi two-stage resolution and same-session continuation",
      providerCalls: contexts.length,
      callbacks: h.callbacks.length,
      events: events.events.length,
    }),
  );
} finally {
  await h.close();
}
