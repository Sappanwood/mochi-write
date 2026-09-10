import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import console from "node:console";
import { creativeHarness } from "./creative-harness.mjs";
const message = "构思一名侦探角色岚舟";
const configureRuntime = (pi, streamFactory) => {
  const original = pi.runtime.streamSimple;
  pi.runtime.streamSimple = (model, context) => {
    const index = context.messages.findLastIndex((m) => m.role === "user");
    const results = context.messages
      .slice(index + 1)
      .filter((m) => m.role === "toolResult");
    let content,
      reason = "stop";
    if (!context.tools?.length) {
      content = [
        {
          type: "text",
          text: JSON.stringify({
            intent: "draft",
            evidence: { start: 0, end: message.length, text: message },
            target: { mode: "new", kind: "character", predicates: [] },
          }),
        },
      ];
    } else if (results.length < 2) {
      if (results.length) {
        assert.equal(
          results[0].content.find((p) => p.type === "text").text,
          "invalid_arguments",
        );
      }
      reason = "toolUse";
      content = [
        {
          type: "toolCall",
          id: randomUUID(),
          name: "save_character",
          arguments: {
            mode: "draft",
            name: "岚舟",
            markdown: "合成侦探角色",
            genres: results.length ? [] : ["悬疑", "犯罪"],
            age_band: results.length ? "" : "成人",
          },
        },
      ];
    } else {
      content = [
        { type: "text", text: "已根据工具错误修正受控词表，生成真实候选。" },
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
try {
  const opened = await h.request("/api/creative/free/conversations", {
    clientRequestId: randomUUID(),
    provider: "deepseek",
    model: "deepseek-v4-flash",
    message,
  });
  let task;
  for (let i = 0; i < 1000; i++) {
    task = await h.free.task(opened.task.id);
    if (
      ["succeeded", "failed", "interrupted", "clarifying"].includes(task.state)
    )
      break;
    await delay(20);
  }
  assert.equal(
    task.state,
    "succeeded",
    JSON.stringify({
      task,
      responses: h.callbackResponses,
      run: h.store.runs.get(task.executionRun?.runId),
    }),
  );
  const invocations = h.store.runs.get(task.executionRun.runId).invocations;
  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].response.error.code, "invalid_arguments");
  assert.notEqual(invocations[0].status, "unknown");
  assert.equal(invocations[1].response.outcome, "ok");
  assert.equal(
    (await h.free.candidates.drafts(opened.conversation.id)).length,
    1,
  );
  console.log(
    "free vocabulary error: real HTTP/Pi returns invalid_arguments and allows a corrected draft, with no transport unknown",
  );
} finally {
  await h.close();
}
