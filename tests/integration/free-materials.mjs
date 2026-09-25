import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import console from "node:console";
import { creativeHarness } from "./creative-harness.mjs";
import { entity } from "../../src/server/entities.ts";
import { freeDigest } from "../../src/server/free-references.ts";
const textOf = (m) =>
  typeof m.content === "string"
    ? m.content
    : m.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
let storyId, currentSetting;
function configureRuntime(pi, factory) {
  const original = pi.runtime.streamSimple;
  pi.runtime.streamSimple = (model, context) => {
    const start = context.messages.findLastIndex((m) => m.role === "user");
    const input = JSON.parse(textOf(context.messages[start]));
    const results = context.messages
      .slice(start + 1)
      .filter((m) => m.role === "toolResult");
    for (const result of results)
      assert.equal(JSON.parse(textOf(result)).outcome, "ok", textOf(result));
    let content,
      reason = "stop";
    const msg = input.user_message,
      chapter = msg.includes("续写"),
      saved = msg.startsWith("原样保存");
    if (!context.tools?.length) {
      assert.equal(input.story_guidance, undefined);
      const evidence = { start: 0, end: msg.length, text: msg };
      content = [
        {
          type: "text",
          text: JSON.stringify({
            intent: saved
              ? "save_current"
              : chapter
                ? "create_chapter"
                : "draft",
            evidence,
            target: { mode: "explicit", kind: "story", predicates: [] },
            ...(!saved && !chapter
              ? {
                  materials: [
                    { key: "new", kind: "snapshot", mode: "create", evidence },
                    {
                      key: "hero",
                      kind: "snapshot",
                      mode: "update",
                      name: "林舟",
                      evidence,
                    },
                    {
                      key: "setting",
                      kind: "setting",
                      mode: "update",
                      evidence,
                    },
                    {
                      key: "outline",
                      kind: "outline",
                      mode: "update",
                      evidence,
                    },
                  ],
                }
              : {}),
          }),
        },
      ];
    } else {
      assert.equal(input.story_guidance.story_id, storyId);
      assert.equal(
        input.story_guidance.text,
        chapter ? "侧重对白" : "慢热，少用旁白",
      );
      let name, args;
      if (chapter) {
        if (!results.length) {
          name = "read_asset";
          args = {
            story_id: storyId,
            asset_id: currentSetting.id,
            revision: currentSetting.revision,
          };
        } else if (results.length === 1) {
          name = "create_chapter";
          args = {
            mode: "draft",
            title: "第二章",
            body: "铜钥匙只能在午夜开启北塔。林舟等到了午夜。",
          };
        } else if (results.length === 2) {
          const d = JSON.parse(textOf(results[1])).data;
          name = "create_chapter";
          args = {
            mode: "commit",
            draft_id: d.draft_id,
            draft_revision: "1",
            draft_hash: d.draft_hash,
          };
        }
      } else if (!results.length) {
        name = "revise_story_materials";
        if (saved) {
          const d = input.binding.selectedDraft;
          args = {
            mode: "commit",
            draft_id: d.draft_id,
            draft_revision: "1",
            draft_hash: d.draft_hash,
          };
        } else
          args = {
            mode: "draft",
            members: input.draft_context.materials.map((m) => ({
              key: m.key,
              name: m.key === "hero" ? "林舟" : m.key,
              markdown: "铜钥匙只能在午夜开启北塔。\r\n",
            })),
          };
      }
      if (args) {
        reason = "toolUse";
        content = [
          { type: "toolCall", id: randomUUID(), name, arguments: args },
        ];
      } else content = [{ type: "text", text: "已核对资料和保存收据。" }];
    }
    const stream = factory();
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
}
const h = await creativeHarness({ freeSession: true, configureRuntime });
const assetRef = (d) => ({
  type: "asset",
  kind: d.kind,
  asset_id: d.id,
  story_id: d.projectId,
  revision: d.revision,
  version: d.currentVersion,
  content_hash: freeDigest(d.content),
});
async function finish(id) {
  for (let i = 0; i < 1000; i++) {
    let t = await h.free.task(id);
    if (t.state === "committed") {
      await h.free.workflow.refresh(id);
      t = await h.free.task(id);
    }
    if (
      (t.state === "committed" && t.executionRun?.status === "succeeded") ||
      t.state === "succeeded"
    )
      return t;
    assert.ok(
      !["failed", "interrupted", "clarifying"].includes(t.state),
      JSON.stringify({ task: t, responses: h.callbackResponses.slice(-2) }),
    );
    await delay(20);
  }
  throw Error("material task timeout");
}
try {
  const initial = await h.story();
  storyId = initial.id;
  const initialStory = await h.content.get(storyId, storyId);
  await h.content.commit(
    {
      ...initialStory,
      guidance: "慢热，少用旁白",
      currentVersion: initialStory.currentVersion + 1,
    },
    initialStory.revision,
  );
  const full = {
    name: "第一章",
    markdown: "原有正文",
    genres: [],
    ageBand: "",
    sourceMetadata: {},
  };
  const chapter = await h.content.commit(
    { ...entity("chapter", full, storyId), order: 1 },
    null,
  );
  await h.content.commit(
    entity("outline", { ...full, name: "大纲" }, storyId),
    null,
  );
  const story = await h.content.get(storyId, storyId),
    oldSetting = initial.setting;
  const first = await h.request("/api/creative/free/conversations", {
    clientRequestId: randomUUID(),
    message: "新增角色快照，更新林舟快照、设定和大纲，只预览",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    initialRefs: [assetRef(story), assetRef(oldSetting)],
  });
  const t1 = await finish(first.task.id);
  const d = (await h.free.candidates.drafts(first.conversation.id))[0];
  assert.equal(d.artifactKind, "story_materials");
  assert.equal(d.payload.members.length, 4);
  assert.deepEqual(await h.content.get(oldSetting.id, storyId), oldSetting);
  h.loseNextCommitResponse();
  const next = await h.request(
    `/api/creative/free/conversations/${first.conversation.id}/tasks`,
    {
      clientRequestId: randomUUID(),
      message: "原样保存这份资料包",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      refs: [h.free.candidates.ref(d)],
    },
  );
  const t2 = await finish(next.task.id);
  assert.equal(t2.receipt.kind, "story_materials_saved");
  assert.equal(t2.receipt.assets.length, 4);
  for (const member of d.payload.members)
    assert.deepEqual(
      (await h.content.get(member.member_id, storyId)).content,
      member.content,
    );
  const detail = await h.request(
    `/api/creative/free/conversations/${first.conversation.id}/drafts/${d.id}`,
  );
  assert.equal(detail.receipt.draft_hash, d.draftHash);
  await h.request(
    `/api/creative/free/conversations/${first.conversation.id}/tasks/${t2.id}/verify`,
    {},
  );
  currentSetting = await h.content.get(oldSetting.id, storyId);
  const currentStory = await h.content.get(storyId, storyId);
  await h.content.commit(
    {
      ...currentStory,
      guidance: "侧重对白",
      currentVersion: currentStory.currentVersion + 1,
    },
    currentStory.revision,
  );
  const third = await h.request(
    `/api/creative/free/conversations/${first.conversation.id}/tasks`,
    {
      clientRequestId: randomUUID(),
      message: "重新读取最新设定并续写一章保存",
      provider: "deepseek",
      model: "deepseek-v4-flash",
    },
  );
  const t3 = await finish(third.task.id);
  assert.equal(t3.receipt.kind, "chapter_created");
  const sources = await h.free.references.sources(first.conversation.id);
  assert.ok(
    sources.some(
      (s) =>
        s.task_id === t3.id &&
        s.origin === "agent_read" &&
        s.ref.version === currentSetting.currentVersion,
    ),
  );
  assert.deepEqual(
    (await h.free.references.read(first.conversation.id, assetRef(oldSetting)))
      .content,
    oldSetting.content,
  );
  assert.deepEqual(await h.content.get(chapter.id, storyId), chapter);
  assert.equal(t1.executionRun.sessionId, t3.executionRun.sessionId);
  console.log(
    JSON.stringify({
      scenario:
        "single-story material package HTTP/Pi, lost response, exact source reread and chapter",
      conversationId: first.conversation.id,
      sessionId: t3.executionRun.sessionId,
      materialReceipt: t2.receipt,
      chapterReceipt: t3.receipt,
      latestSource: sources.find((s) => s.task_id === t3.id),
    }),
  );
} finally {
  await h.close();
}
