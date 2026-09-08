import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import console from "node:console";
import { entity } from "../../src/server/entities.ts";
import { creativeHarness } from "./creative-harness.mjs";
import { initializationProvider } from "./initialization-provider.mjs";

const provider = initializationProvider();
const h = await creativeHarness({
  configureRuntime: provider.configureRuntime,
});
try {
  const character = await h.content.commit(
    entity("character", {
      name: "合成守望者",
      markdown: "合成角色戴着一枚银色指环。",
      genres: ["奇幻"],
      ageBand: "成年",
      sourceMetadata: {
        gender: "女",
        occupation: "灯塔守望者",
        traits: ["沉静"],
      },
    }),
    null,
  );
  const world = await h.content.commit(
    entity("world", {
      name: "合成雾港",
      markdown: "合成世界的灯塔以紫色火焰引航。",
      genres: ["奇幻"],
      ageBand: "",
      sourceMetadata: { era: "近代", tags: ["港口"] },
    }),
    null,
  );
  const request = {
    clientRequestId: randomUUID(),
    provider: "deepseek",
    model: "deepseek-v4-flash",
    message: "找一个灯塔守望者和近代世界观，先讨论新故事，不建立作品。",
  };
  const first = await h.request("/api/creative/conversations", request);
  const conversation = first.conversation;
  assert.ok(conversation.id && conversation.storyId);
  const task = await h.waitTask(conversation.storyId, first.task.id);
  assert.equal(
    task.status,
    "succeeded",
    JSON.stringify({
      error: task.error,
      run: task.runId ? await h.mochiRequest(`/v1/runs/${task.runId}`) : null,
      tools: h.callbacks.map((call) => call.tool.name),
      lastMessages: provider.calls.at(-1)?.messages.slice(-2),
    }),
  );
  assert.equal(
    await h.content.get(conversation.storyId, conversation.storyId),
    undefined,
  );
  assert.equal(task.receipt, undefined);
  assert.deepEqual(
    new Set(task.sources.map((s) => s.asset_id)),
    new Set([character.id, world.id]),
  );
  assert.equal(
    h.callbacks.filter((c) => c.tool.name === "read_library").length,
    2,
  );
  const count = provider.calls.length;
  const replay = await h.request("/api/creative/conversations", request);
  assert.equal(replay.conversation.id, conversation.id);
  assert.equal(replay.task.id, task.id);
  const list = await h.request("/api/creative/conversations");
  const recovered = await h.request(
    `/api/creative/conversations/by-request/${request.clientRequestId}`,
  );
  assert.equal(recovered.conversation.id, conversation.id);
  assert.equal(recovered.task.id, task.id);
  assert.ok(
    list.items.some((c) => c.id === conversation.id && c.established === false),
  );
  await h.request(`/api/creative/conversations/${conversation.id}`);
  await h.request(`/api/stories/${conversation.storyId}`, undefined, 404);
  await h.request(
    `/api/stories/${conversation.storyId}/creative/tasks/${task.id}`,
  );
  assert.equal(
    provider.calls.length,
    count,
    "Refresh/retry must not submit another model run",
  );
  await h.request(
    "/api/creative/conversations",
    { ...request, message: "不同输入" },
    409,
  );
  console.log(
    "initialization session: real HTTP/Pi library discovery and session recovery passed",
  );
} finally {
  await h.close();
}
