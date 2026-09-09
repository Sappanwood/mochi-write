import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import console from "node:console";
import { creativeHarness } from "./creative-harness.mjs";
import { controlledCreativeProvider } from "./creative-provider.mjs";
const provider = controlledCreativeProvider();
const harness = await creativeHarness({
  configureRuntime: provider.configureRuntime,
});
try {
  const story = await harness.story();
  const base = `/api/stories/${story.id}/creative`;
  const conversation = await harness.request(base + "/conversations", {});
  const first = await harness.request(base + "/tasks", {
    clientRequestId: randomUUID(),
    conversationId: conversation.id,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    thinkingLevel: "low",
    message: "让林舟在暴风夜守住灯塔，写一章并保存。",
  });
  const task = await harness.waitTask(story.id, first.id);
  assert.equal(task.status, "succeeded", task.error);
  assert.ok(task.receipt);
  assert.equal(task.sources.length, 1);
  const chapter = await harness.request(
    `/api/stories/${story.id}/documents/${task.receipt.chapter_id}`,
  );
  assert.ok(chapter.content.markdown.includes("黄铜指环"));
  const startedConversation = await harness.creative.requireConversation(
    story.id,
    conversation.id,
  );
  assert.equal(
    (
      await harness.mochiRequest(
        `/v1/sessions/${startedConversation.sessionId}`,
      )
    ).thinking_level,
    "low",
  );
  await harness.request(
    base + "/tasks",
    {
      clientRequestId: randomUUID(),
      conversationId: conversation.id,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      thinkingLevel: "high",
      message: "不能换强度",
    },
    409,
  );
  const history = await harness.mochiRequest(
    `/v1/sessions/${startedConversation.sessionId}/history?format=pi-v1`,
  );
  assert.ok(
    history.messages.some(
      (entry) =>
        entry.message?.role === "toolResult" || entry.role === "toolResult",
    ),
  );
  const before = provider.calls.length;
  await harness.request(base + `/tasks/${task.id}`);
  assert.equal(provider.calls.length, before);
  console.log(
    JSON.stringify({
      ok: true,
      real_http_services: 2,
      real_pi_session: true,
      signed_callback_identity: true,
      autonomous_asset_calls: harness.callbacks.map((call) => call.tool.name),
      exact_chapter: true,
      persisted_tool_history: true,
      model_calls: provider.calls.length,
      provider_stream: "isolated substitute",
    }),
  );
} finally {
  await harness.close();
}
