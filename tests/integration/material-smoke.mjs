import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import console from "node:console";
import { creativeHarness } from "./creative-harness.mjs";
import { freeDigest } from "../../src/server/free-references.ts";
import { entity } from "../../src/server/entities.ts";

assert.equal(process.env.MOCHI_REAL_SMOKE, "deepseek-v4-flash");
const reportPath = process.env.MOCHI_SMOKE_REPORT;
assert.ok(
  reportPath && isAbsolute(reportPath),
  "Set an absolute, new report path",
);
const authPath = process.env.MOCHI_SMOKE_AUTH_FILE;
assert.ok(
  authPath && isAbsolute(authPath),
  "Set the authorized credential file",
);
const auth = JSON.parse(await readFile(authPath, "utf8"));
assert.equal(auth.deepseek?.type, "api_key");
const report = {
  started_at: new Date().toISOString(),
  model: "deepseek-v4-flash",
  provider: "deepseek",
  pricing_source: "https://api-docs.deepseek.com/quick_start/pricing/",
  model_alias_note:
    "2026-09-12 official docs: legacy ID is served by DeepSeek-V4.1-Flash. User authorized the API ID and unlimited API calls/cost for this plan.",
  outcome: "running",
  calls: [],
  scenarios: [],
};
await writeFile(reportPath, JSON.stringify(report), {
  flag: "wx",
  mode: 0o600,
});
let pendingWrite = Promise.resolve();
const persist = () =>
  (pendingWrite = pendingWrite.then(() =>
    writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    }),
  ));
const settlements = [];
const h = await creativeHarness({
  freeSession: true,
  credential: auth.deepseek,
  configureRuntime(pi) {
    const original = pi.runtime.streamSimple;
    pi.runtime.streamSimple = async (model, context, options) => {
      assert.equal(model.provider, "deepseek");
      assert.equal(model.id, "deepseek-v4-flash");
      const call = {
        number: report.calls.length + 1,
        phase: context.tools?.length ? "creative" : "intent",
        started_at: new Date().toISOString(),
        outcome: "started",
      };
      report.calls.push(call);
      await persist();
      console.log(
        JSON.stringify({
          event: "model_call",
          number: call.number,
          phase: call.phase,
        }),
      );
      let stream;
      try {
        stream = await original.call(pi.runtime, model, context, options);
      } catch {
        call.outcome = "failed_unknown_usage";
        await persist();
        throw Error("smoke_provider_failed");
      }
      settlements.push(
        stream
          .result()
          .then((message) => {
            call.outcome = message.stopReason;
            call.usage = message.usage;
            if (message.errorMessage) call.error = message.errorMessage;
            call.finished_at = new Date().toISOString();
            return persist();
          })
          .catch(async () => {
            call.outcome = "failed_unknown_usage";
            await persist();
          }),
      );
      return stream;
    };
    return () => {
      pi.runtime.streamSimple = original;
    };
  },
});
let conversationId;
async function submit(label, message, refs = [], retry = 0) {
  const created = await h.request(
    conversationId
      ? `/api/creative/free/conversations/${conversationId}/tasks`
      : "/api/creative/free/conversations",
    {
      clientRequestId: randomUUID(),
      message,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      thinkingLevel: "off",
      refs,
    },
  );
  conversationId ??= created.conversation.id;
  const scenario = { label, message, refs, task_id: created.task.id };
  report.scenarios.push(scenario);
  await persist();
  console.log(JSON.stringify({ event: "task", label, id: created.task.id }));
  const deadline = Date.now() + 360000;
  while (Date.now() < deadline) {
    let t = await h.free.task(created.task.id);
    if (
      [
        "committed",
        "succeeded",
        "failed",
        "clarifying",
        "conflict",
        "revoked",
        "interrupted",
      ].includes(t.state)
    ) {
      if (
        t.executionRun?.runId &&
        !["succeeded", "failed", "interrupted"].includes(t.executionRun.status)
      ) {
        await h.free.workflow.refresh(t.id);
        t = await h.free.task(t.id);
        if (
          !["succeeded", "failed", "interrupted"].includes(
            t.executionRun.status,
          )
        ) {
          await delay(250);
          continue;
        }
      }
      scenario.task = t;
      scenario.candidates = (
        await h.free.candidates.drafts(conversationId)
      ).filter((d) => d.createdByTaskId === t.id);
      scenario.sources = await h.free.references.sources(conversationId);
      report.session = await h.free.conversation(conversationId);
      await persist();
      console.log(
        JSON.stringify({
          event: "task_result",
          label,
          state: t.state,
          error: t.error,
          candidates: scenario.candidates.length,
        }),
      );
      if (
        t.state === "clarifying" &&
        [
          "invalid_intent_evidence",
          "invalid_material_evidence",
          "invalid_material_intent",
          "intent_unavailable",
        ].includes(t.error) &&
        retry < 2
      ) {
        scenario.correction =
          "Explicit harness resubmission after rejected classification; no production automatic retry.";
        await persist();
        return submit(label + "-retry", message, refs, retry + 1);
      }
      if (
        t.state === "clarifying" &&
        t.error === "ambiguous_explicit_target" &&
        refs.length === 0 &&
        retry < 2
      ) {
        scenario.correction =
          "Clarified autonomous target search after classification incorrectly inferred an explicit reference.";
        await persist();
        return submit(
          label + "-search-correction",
          "请自主检索目标。" + message,
          refs,
          retry + 1,
        );
      }
      return scenario;
    }
    await delay(250);
  }
  throw Error("smoke_task_timeout");
}
function candidateRef(d) {
  return h.free.candidates.ref(d);
}
function assetRef(d) {
  return {
    type: "asset",
    kind: d.kind,
    asset_id: d.id,
    ...(d.projectId ? { story_id: d.projectId } : {}),
    revision: d.revision,
    version: d.currentVersion,
    content_hash: freeDigest(d.content),
  };
}
try {
  const initial = await h.story();
  const storyId = initial.id;
  const full = {
    name: "首章",
    markdown: "原章事实：船已靠岸。",
    genres: ["奇幻"],
    ageBand: "",
    sourceMetadata: { preserved: "原值" },
  };
  const chapter = await h.content.commit(
    { ...entity("chapter", full, storyId), order: 1 },
    null,
  );
  await h.content.commit(
    entity("outline", { ...full, name: "大纲" }, storyId),
    null,
  );
  const unlisted = await h.content.commit(
    entity("snapshot", { ...full, name: "未列角色" }, storyId),
    null,
  );
  const otherStory = await h.content.commit(
    { ...entity("story", { ...full, name: "另一故事" }), status: "ready" },
    null,
  );
  const master = await h.content.commit(
    entity("character", {
      ...full,
      name: "守塔人",
      markdown: "守塔人随身带银铃，每夜核对潮汐簿。\r\n",
      sourceMetadata: { occupation: "守塔", legacy: { mark: "全量保留" } },
    }),
    null,
  );
  const background = await h.content.commit(
    entity("world", {
      ...full,
      name: "参考海域",
      markdown: "只作参考，不加入资料包。",
    }),
    null,
  );
  const story = await h.content.get(storyId, storyId);
  const role = await submit(
    "unsaved_character",
    "构思角色。生成新角色候选潮汐学徒，100字以内，只预览不保存。",
  );
  assert.equal(role.task.state, "succeeded");
  const roleDraft = role.candidates.find((d) => d.artifactKind === "character");
  assert.ok(roleDraft);
  const before = JSON.parse(JSON.stringify([...h.content.heads]));
  const preview = await submit(
    "five_material_previews",
    "仅预览故事资料。为引用故事新增角色快照：完整复制引用角色母版，不改写。另新增角色快照：完整复制引用角色候选，不改写。更新林舟快照：携铜钥匙。更新设定：铜钥匙只能在午夜开启北塔。更新大纲：前往北塔。世界观仅参考。每项150字，不保存。",
    [
      assetRef(story),
      assetRef(master),
      candidateRef(roleDraft),
      assetRef(background),
      assetRef(initial.setting),
    ],
  );
  assert.equal(preview.task.state, "succeeded");
  const old = preview.candidates.find(
    (d) => d.artifactKind === "story_materials",
  );
  assert.ok(old);
  assert.equal(old.payload.members.length, 5);
  assert.equal(
    old.payload.members.filter((m) => m.mode === "create").length,
    2,
  );
  assert.deepEqual([...h.content.heads], before);
  const pack = old.payload.business.materials;
  const fromMaster = pack.members.find(
    (m) => m.entity.sourceAssetId === master.id,
  );
  const fromCandidate = pack.members.find(
    (m) => m.entity.sourceCandidate?.draftId === roleDraft.id,
  );
  assert.deepEqual(fromMaster?.entity.content, master.content);
  assert.equal(fromMaster?.entity.sourceVersion, master.currentVersion);
  assert.deepEqual(fromCandidate?.entity.content, roleDraft.payload.content);
  assert.equal(
    fromCandidate?.entity.sourceCandidate?.draftHash,
    roleDraft.draftHash,
  );
  assert.ok(
    !pack.members.some((m) => m.entity.sourceAssetId === background.id),
  );
  assert.deepEqual(
    new Set(
      pack.members
        .filter((m) => m.spec.mode === "update")
        .map((m) => m.entity.kind),
    ),
    new Set(["snapshot", "setting", "outline"]),
  );
  const feedback = await submit(
    "same_group_feedback",
    "改写资料候选。仅将设定中的午夜改为日出，其他成员完整保留，同组出下一稿，不保存。每个成员完整提交原文，不能再使用首次入包复制方式。",
    [candidateRef(old)],
  );
  assert.equal(feedback.task.state, "succeeded");
  assert.equal(feedback.candidates[0].groupId, old.groupId);
  assert.equal(feedback.candidates[0].ordinal, 2);
  assert.deepEqual([...h.content.heads], before);
  h.loseNextCommitResponse();
  const saved = await submit(
    "save_exact_old_materials_lost_response",
    "保存资料候选。原样保存选定第一稿的整包资料，不重新生成。",
    [candidateRef(old)],
  );
  assert.equal(saved.task.state, "committed");
  assert.equal(saved.task.receipt.kind, "story_materials_saved");
  assert.equal(saved.task.receipt.draft_hash, old.draftHash);
  assert.equal(saved.task.receipt.assets.length, 5);
  for (const m of pack.members) {
    const current = await h.content.get(m.entity.id, storyId);
    assert.deepEqual(current.content, m.entity.content);
    assert.equal(current.currentVersion, m.spec.base_version + 1);
    assert.equal(
      saved.task.receipt.assets.find((a) => a.asset_id === current.id)
        .content_hash,
      freeDigest(current.content),
    );
  }
  for (const d of [chapter, master, background, unlisted, otherStory])
    assert.deepEqual(await h.content.get(d.id, d.projectId), d);
  assert.deepEqual(
    (await h.free.references.read(conversationId, assetRef(initial.setting)))
      .content,
    initial.setting.content,
  );
  const newSetting = await h.content.get(initial.setting.id, storyId);
  assert.match(newSetting.content.markdown, /铜钥匙/);
  assert.match(newSetting.content.markdown, /午夜/);
  assert.match(newSetting.content.markdown, /北塔/);
  const continuation = await submit(
    "read_current_materials_then_chapter",
    "续写故事。为引用故事写并保存第二章，150字以内。必须先用工具实际读取当前设定、大纲和林舟快照，遵守正式资料中钥匙的开门条件，表现等待时机后开门的行动；只写一章。",
    [assetRef(await h.content.get(storyId, storyId))],
  );
  assert.equal(continuation.task.state, "committed");
  assert.equal(continuation.task.receipt.kind, "chapter_created");
  assert.notEqual(
    continuation.task.receipt.operation_id,
    saved.task.receipt.operation_id,
  );
  const chapterDraft = continuation.candidates.find(
    (d) => d.artifactKind === "chapter",
  );
  assert.ok(chapterDraft);
  for (const word of ["铜钥匙", "午夜", "北塔"])
    assert.match(chapterDraft.payload.content.markdown, new RegExp(word));
  assert.ok(
    continuation.sources.some(
      (s) =>
        s.task_id === continuation.task.id &&
        s.origin === "agent_read" &&
        s.ref.type === "asset" &&
        s.ref.asset_id === newSetting.id &&
        s.ref.version === newSetting.currentVersion &&
        s.ref.content_hash === freeDigest(newSetting.content),
    ),
  );
  assert.deepEqual(await h.content.get(chapter.id, storyId), chapter);
  const sessions = new Set(
    report.scenarios
      .flatMap((s) => [
        s.task?.resolutionRun?.sessionId,
        s.task?.executionRun?.sessionId,
      ])
      .filter(Boolean),
  );
  assert.equal(sessions.size, 1);
  const callsBefore = report.calls.length;
  const verified = await h.request(
    `/api/creative/free/conversations/${conversationId}/tasks/${saved.task.id}/verify`,
    {},
  );
  assert.ok(JSON.stringify(verified).includes(saved.task.receipt.operation_id));
  assert.equal(report.calls.length, callsBefore);
  report.content_consumption = {
    setting_ref: assetRef(newSetting),
    chapter_draft: candidateRef(chapterDraft),
    chapter_text: chapterDraft.payload.content.markdown,
  };
  report.outcome = "passed";
} catch (error) {
  report.outcome = "failed";
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await h.free.close();
  await Promise.all(settlements);
  report.finished_at = new Date().toISOString();
  report.callbacks = h.callbacks;
  report.callback_responses = h.callbackResponses;
  report.content = [...h.content.heads.values()];
  report.candidates = conversationId
    ? await h.free.candidates.drafts(conversationId)
    : [];
  report.cost_note =
    "Provider/Pi usage.cost is reported as observed; it may use a cached price table. Actual billing follows the linked official pricing and account invoice.";
  await persist();
  await h.close();
  console.log(
    JSON.stringify({
      outcome: report.outcome,
      error: report.error,
      calls: report.calls.length,
      report: reportPath,
    }),
  );
}
