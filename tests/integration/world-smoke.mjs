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
    "2026-09-11 official docs: legacy ID is served by DeepSeek-V4.1-Flash. User authorized the API ID and unlimited API calls/cost for this plan.",
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
        ["invalid_intent_evidence", "intent_unavailable"].includes(t.error) &&
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
    revision: d.revision,
    version: d.currentVersion,
    content_hash: freeDigest(d.content),
  };
}
try {
  const preview = await submit(
    "two_world_previews",
    "预览世界观。生成雾海（三座灯塔）与星原（两座浮岛）两个独立候选，各150字以内，不保存。",
  );
  assert.equal(preview.task.state, "succeeded");
  const worlds = preview.candidates.filter((d) => d.artifactKind === "world");
  assert.equal(worlds.length, 2);
  const old = worlds.find((d) => d.payload.content.name.startsWith("雾海"));
  assert.ok(old);
  assert.equal(h.content.heads.size, 0);
  const feedback = await submit(
    "same_group_feedback",
    "改写世界观。选定稿同组出下一稿：三座灯塔改四座，仍叫雾海，其他内容不变，不保存。",
    [candidateRef(old)],
  );
  assert.equal(feedback.task.state, "succeeded");
  assert.equal(feedback.candidates[0].groupId, old.groupId);
  assert.equal(feedback.candidates[0].ordinal, 2);
  assert.equal(h.content.heads.size, 0);
  const saved = await submit(
    "save_exact_old_world",
    "保存世界观。原样保存选定旧稿为新母版，不重新生成。",
    [candidateRef(old)],
  );
  assert.equal(saved.task.state, "committed");
  assert.equal(saved.task.receipt.kind, "world_created");
  assert.equal(saved.task.receipt.draft_id, old.id);
  const master = await h.content.get(saved.task.receipt.target.asset_id, null);
  assert.deepEqual(master.content, old.payload.content);
  const snapshot = await h.content.commit(
    {
      ...entity("snapshot", master.content, randomUUID()),
      sourceAssetId: master.id,
      sourceVersion: master.currentVersion,
    },
    null,
  );
  const updated = await submit(
    "natural_world_update",
    `搜索${master.content.name}世界观，把灯塔改蓝并更新保存。`,
  );
  assert.equal(updated.task.state, "committed");
  assert.equal(updated.task.receipt.kind, "world_updated");
  assert.equal(updated.task.receipt.target.asset_id, master.id);
  assert.equal(updated.task.binding.baseRevision, master.revision);
  assert.deepEqual(updated.task.input.refs, []);
  const current = await h.content.get(master.id, null);
  assert.equal(current.currentVersion, 2);
  assert.equal(freeDigest(current.content), updated.task.receipt.content_hash);
  assert.deepEqual(
    await h.content.get(snapshot.id, snapshot.projectId),
    snapshot,
  );
  assert.deepEqual(
    (await h.free.references.read(conversationId, assetRef(master))).content,
    master.content,
  );
  const character = await submit(
    "cross_type_character",
    "新建角色。参考引用的世界观，创作并保存独立角色母版守灯人岚舟，150字以内，不改世界观。",
    [assetRef(current)],
  );
  assert.equal(character.task.state, "committed");
  assert.equal(character.task.receipt.kind, "character_created");
  const person = await h.content.get(
    character.task.receipt.target.asset_id,
    null,
  );
  const story = await submit(
    "cross_type_story",
    "新建故事。使用引用的世界观和角色母版，建立蓝灯归航并保存第一章（150字以内），完整复制两份母版快照，不改母版。",
    [assetRef(current), assetRef(person)],
  );
  assert.equal(story.task.state, "committed");
  assert.equal(story.task.receipt.kind, "first_chapter_saved");
  const members = (
    await h.content.list({
      projectId: story.task.receipt.target.story_id,
      kind: "snapshot",
    })
  ).items;
  assert.ok(
    members.some(
      (d) =>
        d.sourceAssetId === master.id &&
        freeDigest(d.content) === freeDigest(current.content),
    ),
  );
  assert.ok(
    members.some(
      (d) =>
        d.sourceAssetId === person.id &&
        freeDigest(d.content) === freeDigest(person.content),
    ),
  );
  const sessions = new Set(
    report.scenarios
      .flatMap((s) => [
        s.task.resolutionRun?.sessionId,
        s.task.executionRun?.sessionId,
      ])
      .filter(Boolean),
  );
  assert.equal(sessions.size, 1);
  const before = report.calls.length;
  const verified = await h.request(
    `/api/creative/free/conversations/${conversationId}/tasks/${saved.task.id}/verify`,
    {},
  );
  assert.ok(JSON.stringify(verified).includes(saved.task.receipt.operation_id));
  assert.equal(report.calls.length, before);
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
