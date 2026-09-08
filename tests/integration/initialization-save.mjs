import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import console from "node:console";
import { entity } from "../../src/server/entities.ts";
import { creativeHarness } from "./creative-harness.mjs";
import { initializationProvider } from "./initialization-provider.mjs";

const provider = initializationProvider();
const h = await creativeHarness({
  configureRuntime: provider.configureRuntime,
});
const control = provider.control;
const bodyHash = (body) =>
  "sha256:" + createHash("sha256").update(body).digest("hex");
async function finish(conversation, task, expected = "succeeded") {
  const result = await h.waitTask(conversation.storyId, task.id);
  assert.equal(
    result.status,
    expected,
    JSON.stringify({
      task: result,
      run: result.runId
        ? await h.mochiRequest(`/v1/runs/${result.runId}`)
        : null,
    }),
  );
  return result;
}
async function next(conversation, message, selectedDraft, expected) {
  const task = await h.request(
    `/api/stories/${conversation.storyId}/creative/tasks`,
    {
      clientRequestId: randomUUID(),
      conversationId: conversation.id,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      message,
      ...(selectedDraft
        ? {
            selectedDraft: {
              draft_id: selectedDraft.draft_id,
              draft_revision: selectedDraft.draft_revision,
              draft_hash: selectedDraft.draft_hash,
            },
          }
        : {}),
    },
  );
  return finish(conversation, task, expected);
}
async function start(message) {
  const { conversation, task } = await h.request(
    "/api/creative/conversations",
    {
      clientRequestId: randomUUID(),
      provider: "deepseek",
      model: "deepseek-v4-flash",
      message,
    },
  );
  return { conversation, task: await finish(conversation, task) };
}
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
  await h.content.commit(
    entity("world", {
      name: "合成雾港",
      markdown: "合成世界的灯塔以紫色火焰引航。",
      genres: ["奇幻"],
      ageBand: "",
      sourceMetadata: { era: "近代", tags: ["港口"] },
    }),
    null,
  );
  Object.assign(control, {
    mode: "initialize",
    intent: "initialize_only",
    includeChapter: false,
  });
  const first = await start(
    "检索合成守望者和近代世界观，建立作品并保存初始资料，暂时不写第一章。",
  );
  const conversation = first.conversation;
  assert.equal(first.task.receipt.kind, "story_initialized");
  assert.equal(first.task.receipt.chapter, undefined);
  assert.equal(
    (
      await h.content.list({
        projectId: conversation.storyId,
        kind: "chapter",
        limit: 40,
      })
    ).items.length,
    0,
  );
  assert.equal(
    (await h.content.get(conversation.storyId, conversation.storyId))
      .initializationPending,
    true,
  );
  const setting = (
    await h.content.list({
      projectId: conversation.storyId,
      kind: "setting",
      limit: 40,
    })
  ).items[0];
  const snapshots = (
    await h.content.list({
      projectId: conversation.storyId,
      kind: "snapshot",
      limit: 40,
    })
  ).items;
  const snapshot = snapshots.find((s) => s.sourceAssetId === character.id);
  assert.deepEqual(snapshot.content, character.content);
  await h.content.commit(
    {
      ...character,
      currentVersion: 2,
      content: {
        ...character.content,
        markdown: "母版已改变，不得改变旧故事。",
      },
    },
    character.revision,
  );
  Object.assign(control, {
    mode: "chapter",
    intent: "create_and_save",
    includeChapter: true,
    assets: [
      {
        kind: "setting",
        asset_id: setting.id,
        base_revision: setting.revision,
        title: setting.content.name,
        body: "新的初始约定：灯塔以蓝色火焰引航。",
      },
    ],
  });
  h.loseNextCommitResponse();
  const chapter = await next(
    conversation,
    "按本轮蓝色火焰设定写第一章并保存，同时更新初始设定。",
  );
  assert.equal(chapter.receipt.kind, "first_chapter_saved");
  assert.equal(chapter.receipt.content_hash, chapter.receipt.draft_hash);
  assert.equal(chapter.receipt.chapter.content_hash, bodyHash(control.body));
  assert.equal(
    (await h.content.get(setting.id, conversation.storyId)).content.markdown,
    control.assets[0].body,
  );
  assert.deepEqual(
    (await h.content.get(snapshot.id, conversation.storyId)).content,
    character.content,
  );
  assert.notEqual(
    (await h.content.get(conversation.storyId, conversation.storyId))
      .initializationPending,
    true,
  );
  const sessionId = (
    await h.request(`/api/creative/conversations/${conversation.id}`)
  ).sessionId;
  const calls = provider.calls.length;
  await h.restartMochi();
  await h.request(
    `/api/stories/${conversation.storyId}/creative/tasks/${chapter.id}`,
  );
  assert.equal(provider.calls.length, calls);
  Object.assign(control, {
    mode: "continue",
    body: "第二章仍从同一会话继续。\n",
  });
  const continuation = await next(conversation, "继续写下一章并保存。");
  assert.ok(continuation.receipt.chapter_id);
  assert.equal(
    (await h.request(`/api/creative/conversations/${conversation.id}`))
      .sessionId,
    sessionId,
  );

  Object.assign(control, {
    mode: "initialize",
    intent: "draft",
    includeChapter: true,
    body: "首个预览版本。\n",
  });
  const preview = await start("先找合成资料，写一个开场给我看，不建立作品。");
  assert.equal(preview.task.receipt, undefined);
  assert.equal(
    await h.content.get(
      preview.conversation.storyId,
      preview.conversation.storyId,
    ),
    undefined,
  );
  const originalRef = preview.task.artifacts[0];
  control.body = "通过对话修改后的精确开场版本。\n";
  const revised = await next(
    preview.conversation,
    "把开场改得更平静，先给我看看，不保存。",
  );
  assert.notEqual(revised.artifacts[0].draft_id, originalRef.draft_id);
  const ref = revised.artifacts[0];
  control.intent = "save_current";
  const saved = await next(
    preview.conversation,
    "保存选定的这个版本，并建立作品。",
    ref,
  );
  assert.equal(saved.receipt.draft_id, ref.draft_id);
  assert.equal(saved.receipt.draft_hash, ref.draft_hash);
  assert.equal(saved.receipt.chapter.content_hash, bodyHash(control.body));

  Object.assign(control, {
    mode: "initialize",
    intent: "create_and_save",
    failAfterCommit: true,
  });
  const directRequest = await h.request("/api/creative/conversations", {
    clientRequestId: randomUUID(),
    provider: "deepseek",
    model: "deepseek-v4-flash",
    message: "直接建立一部合成故事，写第一章并保存。",
  });
  const direct = await finish(
    directRequest.conversation,
    directRequest.task,
    "failed",
  );
  assert.equal(direct.receipt.kind, "first_chapter_saved");
  assert.ok(
    await h.content.get(
      direct.receipt.chapter.chapter_id,
      direct.receipt.story_id,
    ),
  );
  console.log(
    "initialization save: staged creation, exact rewritten draft, related assets, lost response and same-session continuation passed",
  );
} finally {
  await h.close();
}
