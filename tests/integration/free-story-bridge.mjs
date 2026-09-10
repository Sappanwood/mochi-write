import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import console from "node:console";
import { creativeHarness } from "./creative-harness.mjs";
import { freeDigest } from "../../src/server/free-references.ts";
const contexts = [];
const textOf = (m) =>
  typeof m.content === "string"
    ? m.content
    : m.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
function configureRuntime(pi, streamFactory) {
  const original = pi.runtime.streamSimple;
  pi.runtime.streamSimple = (model, context) => {
    contexts.push(JSON.parse(JSON.stringify(context)));
    const index = context.messages.findLastIndex((m) => m.role === "user"),
      input = JSON.parse(textOf(context.messages[index]));
    const results = context.messages
      .slice(index + 1)
      .filter((m) => m.role === "toolResult");
    const msg = input.user_message;
    let content,
      reason = "stop";
    if (!context.tools?.length) {
      const save = msg.startsWith("保存"),
        next = msg === "继续写第二章并保存",
        story = msg.includes("故事") || next;
      content = [
        {
          type: "text",
          text: JSON.stringify({
            intent: save ? "save_current" : next ? "create_chapter" : "draft",
            evidence: { start: 0, end: msg.length, text: msg },
            target: {
              kind: story ? "story" : "character",
              mode: next ? "explicit" : "new",
              predicates: [],
            },
          }),
        },
      ];
    } else {
      for (const result of results) {
        const r = JSON.parse(textOf(result));
        assert.equal(r.outcome, "ok", JSON.stringify(r));
      }
      const selected = input.binding?.selectedDraft;
      const tool = input.draft_context.mode.endsWith("character")
        ? "save_character"
        : input.binding?.action === "create_chapter"
          ? "create_chapter"
          : "initialize_story";
      let args;
      if (results.length === 0) {
        if (selected)
          args = {
            mode: "commit",
            draft_id: selected.draft_id,
            draft_revision: selected.draft_revision,
            draft_hash: selected.draft_hash,
          };
        else if (tool === "initialize_story")
          args = {
            mode: "draft",
            title: "旧角色的故事",
            assets: [{ kind: "snapshot", candidate_ref: input.refs[0] }],
            chapter: { title: "首章", body: "独立首章\r\n" },
            derived_from: input.refs[0],
          };
        else if (tool === "create_chapter")
          args = { mode: "draft", title: "第二章", body: "后续章节" };
        else
          args = {
            mode: "draft",
            name: "合成角色",
            markdown:
              msg === "改写角色候选"
                ? "新角色稿"
                : msg === "提炼独立角色候选"
                  ? "独立稳定背景，无原故事剧情和关系。"
                  : "旧角色稿\r\n",
            genres: [],
            age_band: "",
            ...(msg === "改写角色候选"
              ? { group_id: input.refs[0].group_id, parent_ref: input.refs[0] }
              : {}),
            ...(msg === "提炼独立角色候选"
              ? {
                  derived_from: input.refs[0],
                  derivation: {
                    source_ref: input.refs[0],
                    retained: ["稳定职业"],
                    rewritten: ["独立成长背景"],
                    excluded: ["原剧情和双向关系"],
                  },
                }
              : {}),
          };
      } else if (input.binding && !selected && results.length === 1) {
        const ref = JSON.parse(textOf(results[0])).data;
        args = {
          mode: "commit",
          draft_id: ref.draft_id,
          draft_revision: ref.draft_revision,
          draft_hash: ref.draft_hash,
        };
      }
      if (args) {
        reason = "toolUse";
        content = [
          { type: "toolCall", id: randomUUID(), name: tool, arguments: args },
        ];
      } else content = [{ type: "text", text: "本轮候选或正式收据已核对。" }];
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
}
const h = await creativeHarness({ freeSession: true, configureRuntime });
async function finish(id) {
  for (let i = 0; i < 1000; i++) {
    let task = await h.free.task(id);
    if (task.state === "committed") {
      await h.free.workflow.refresh(id);
      task = await h.free.task(id);
    }
    if (task.state === "committed" && task.executionRun?.status === "succeeded")
      return task;
    if (
      ["succeeded", "failed", "interrupted", "clarifying"].includes(task.state)
    ) {
      assert.equal(
        task.state,
        "succeeded",
        JSON.stringify({
          task,
          run: task.executionRun?.runId
            ? await h.mochiRequest(`/v1/runs/${task.executionRun.runId}`)
            : null,
        }),
      );
      return task;
    }
    await delay(20);
  }
  const task = await h.free.task(id);
  throw Error(
    "free story timeout: " +
      JSON.stringify({
        task,
        run: task.executionRun?.runId
          ? await h.mochiRequest(`/v1/runs/${task.executionRun.runId}`)
          : null,
        callbacks: h.callbacks.slice(-4),
        contexts: contexts.slice(-2),
      }),
  );
}
try {
  console.log(
    `free-story-bridge endpoints Write=${h.origin} Mochi=${h.mochiOrigin}; fake provider; ephemeral ports`,
  );
  let conversationId, sessionId;
  async function send(message, refs = []) {
    const result = await h.request(
      conversationId
        ? `/api/creative/free/conversations/${conversationId}/tasks`
        : "/api/creative/free/conversations",
      {
        clientRequestId: randomUUID(),
        message,
        refs,
        provider: "deepseek",
        model: "deepseek-v4-flash",
      },
    );
    conversationId ??= result.conversation.id;
    const task = await finish(result.task.id),
      c = await h.free.conversation(conversationId);
    sessionId ??= c.sessionId;
    assert.equal(c.sessionId, sessionId);
    return task;
  }
  async function candidate(task) {
    const list = await h.request(
      `/api/creative/free/conversations/${conversationId}/tasks/${task.id}`,
    );
    assert.equal(list.candidates.length, 1);
    const d = list.candidates[0];
    return {
      type: "candidate",
      group_id: d.group_id,
      draft_id: d.draft_id,
      draft_revision: d.draft_revision,
      draft_hash: d.draft_hash,
    };
  }
  const first = await send("构思角色候选"),
    old = await candidate(first);
  const rewrite = await send("改写角色候选", [old]),
    newer = await candidate(rewrite);
  assert.equal(newer.group_id, old.group_id);
  assert.notEqual(newer.draft_hash, old.draft_hash);
  const preview = await send("用旧角色构思新故事", [old]),
    packRef = await candidate(preview);
  assert.notEqual(packRef.group_id, old.group_id);
  assert.equal(preview.binding, undefined);
  const pack = await h.request(
    `/api/creative/free/conversations/${conversationId}/drafts/${packRef.draft_id}`,
  );
  assert.equal(pack.draft.payload.members[0].content.markdown, "旧角色稿\r\n");
  assert.deepEqual(pack.draft.payload.members[0].sourceRef, old);
  assert.equal((await h.content.list({ kind: "character" })).items.length, 0);
  h.loseNextCommitResponse();
  const saved = await send("保存选定故事首章", [packRef]);
  assert.equal(saved.receipt.kind, "first_chapter_saved");
  const storyId = saved.receipt.target.story_id,
    story = await h.content.get(storyId, storyId);
  const snapshot = (
    await h.content.list({ kind: "snapshot", projectId: storyId })
  ).items[0];
  assert.equal(snapshot.sourceAssetId, undefined);
  assert.equal(snapshot.content.markdown, "旧角色稿\r\n");
  const assetRef = (e) => ({
    type: "asset",
    kind: e.kind,
    asset_id: e.id,
    story_id: e.projectId,
    revision: e.revision,
    version: e.currentVersion,
    content_hash: freeDigest(e.content),
  });
  const continued = await send("继续写第二章并保存", [assetRef(story)]);
  assert.equal(continued.receipt.kind, "chapter_created");
  const reverse = await send("提炼独立角色候选", [assetRef(snapshot)]),
    masterRef = await candidate(reverse);
  const full = await h.request(
    `/api/creative/free/conversations/${conversationId}/drafts/${masterRef.draft_id}`,
  );
  assert.equal(
    full.draft.payload.business.derivation.excluded[0],
    "原剧情和双向关系",
  );
  assert.equal(
    full.draft.payload.content.markdown,
    "独立稳定背景，无原故事剧情和关系。",
  );
  const master = await send("保存独立角色母版", [masterRef]);
  assert.equal(master.receipt.kind, "character_created");
  assert.deepEqual(await h.content.get(snapshot.id, storyId), snapshot);
  assert.equal(
    (await h.content.list({ kind: "chapter", projectId: storyId })).items
      .length,
    2,
  );
  const history = contexts.filter((c) => c.tools?.length).at(-1).messages;
  assert.ok(
    history.some(
      (m) => m.role === "toolResult" && textOf(m).includes(old.draft_id),
    ),
  );
  assert.equal(new Set(h.callbacks.map((c) => c.session_id)).size, 1);
  console.log(
    JSON.stringify({
      status: "passed",
      conversationId,
      sessionId,
      storyId,
      oldDraft: old.draft_id,
      storyDraft: packRef.draft_id,
      masterDraft: masterRef.draft_id,
      operations: [
        saved.operationId,
        continued.operationId,
        master.operationId,
      ],
      callbackCount: h.callbacks.length,
    }),
  );
} finally {
  await h.close();
}
