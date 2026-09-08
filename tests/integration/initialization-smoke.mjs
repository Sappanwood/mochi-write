import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import process from "node:process";
import console from "node:console";
import { entity } from "../../src/server/entities.ts";
import { creativeHarness } from "./creative-harness.mjs";

assert.equal(
  process.env.MOCHI_REAL_SMOKE,
  "deepseek-v4-flash",
  "Real smoke requires explicit MOCHI_REAL_SMOKE=deepseek-v4-flash",
);
const priorUsd = Number(process.env.MOCHI_SMOKE_PRIOR_USD);
assert.ok(
  Number.isFinite(priorUsd) && priorUsd >= 0.09984128 && priorUsd < 10,
  "Set cumulative prior spend, including every failed/retried smoke",
);
const budget = 10 - priorUsd;
assert.ok(Number.isFinite(budget) && budget > 0 && budget <= 10);
const reportPath = process.env.MOCHI_SMOKE_REPORT;
assert.ok(
  reportPath && isAbsolute(reportPath),
  "Set an absolute MOCHI_SMOKE_REPORT path",
);
let apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  const path = process.env.MOCHI_SMOKE_AUTH_FILE;
  assert.ok(
    path && isAbsolute(path),
    "Provide DEEPSEEK_API_KEY or explicit MOCHI_SMOKE_AUTH_FILE",
  );
  const auth = JSON.parse(await readFile(path, "utf8"));
  assert.equal(
    auth.deepseek?.type,
    "api_key",
    "A DeepSeek API key is required",
  );
  apiKey = auth.deepseek.key;
}
assert.ok(
  typeof apiKey === "string" && apiKey.trim() && !/[\r\n]/.test(apiKey),
  "Invalid DeepSeek credential",
);
const report = {
  started_at: new Date().toISOString(),
  model: "deepseek-v4-flash",
  budget_usd: budget,
  prior_upper_usd: priorUsd,
  cumulative_limit_usd: 10,
  pricing_basis:
    "Conservative peak rates: all input including cached input $0.44/M; output $1.32/M. This is an upper estimate, not an invoice.",
  pricing_source: "https://api-docs.deepseek.com/quick_start/pricing/",
  calls: [],
  scenarios: [],
  outcome: "running",
};
let reservedUsd = 0,
  settledUsd = 0;
let reportWrite = Promise.resolve();
function persistBudget() {
  reportWrite = reportWrite.then(() =>
    writeFile(
      reportPath,
      JSON.stringify(
        {
          ...report,
          cost_upper_usd: settledUsd + reservedUsd,
          cumulative_upper_usd: priorUsd + settledUsd + reservedUsd,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    ),
  );
  return reportWrite;
}
const settlements = [];
const harness = await creativeHarness({
  credential: { type: "api_key", key: apiKey },
  configureRuntime(pi) {
    const original = pi.runtime.streamSimple;
    pi.runtime.streamSimple = async (model, context, options) => {
      assert.equal(model.provider, "deepseek");
      assert.equal(model.id, "deepseek-v4-flash");
      const outputLimit = options?.maxTokens ?? model.maxTokens;
      assert.ok(Number.isFinite(outputLimit) && outputLimit > 0);
      const promptUpper = Buffer.byteLength(JSON.stringify(context)) + 8192;
      const reserve = (promptUpper * 0.44 + outputLimit * 1.32) / 1000000;
      if (settledUsd + reservedUsd + reserve > budget)
        throw new Error("smoke_budget_exhausted");
      reservedUsd += reserve;
      const call = {
        number: report.calls.length + 1,
        phase: context.tools?.length ? "creative" : "intent",
        max_output_tokens: outputLimit,
        reserved_usd: reserve,
        outcome: "started",
      };
      report.calls.push(call);
      await persistBudget();
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
        reservedUsd -= reserve;
        settledUsd += reserve;
        await persistBudget();
        throw new Error("smoke_provider_failed");
      }
      settlements.push(
        stream
          .result()
          .then(async (message) => {
            call.content_sizes = message.content.map((part) => ({
              type: part.type,
              characters: (part.text ?? part.thinking ?? "").length,
            }));
            if (message.stopReason === "error") {
              const error = String(message.errorMessage ?? "").toLowerCase();
              call.error_flags = [
                "400",
                "401",
                "402",
                "429",
                "schema",
                "oneof",
                "object",
                "type",
                "properties",
                "required",
                "tools",
                "function",
                "parameters",
                "reasoning_content",
                "strict",
                "undefined",
                "null",
                "network",
                "fetch",
              ].filter((word) => error.includes(word));
            }
            const usage = message.usage;
            if (
              usage &&
              [
                usage.input,
                usage.output,
                usage.cacheRead,
                usage.cacheWrite,
              ].every(Number.isFinite) &&
              usage.totalTokens > 0
            ) {
              call.usage = {
                input: usage.input,
                output: usage.output,
                cache_read: usage.cacheRead,
                cache_write: usage.cacheWrite,
                total_tokens: usage.totalTokens,
              };
              call.cost_upper_usd =
                ((usage.input + usage.cacheRead + usage.cacheWrite) * 0.44 +
                  usage.output * 1.32) /
                1000000;
              settledUsd += call.cost_upper_usd;
            } else {
              call.cost_upper_usd = reserve;
              settledUsd += reserve;
            }
            reservedUsd -= reserve;
            call.outcome = message.stopReason;
            await persistBudget();
          })
          .catch(() => {
            reservedUsd -= reserve;
            settledUsd += reserve;
            call.outcome = "failed_unknown_usage";
          }),
      );
      return stream;
    };
    return () => {
      pi.runtime.streamSimple = original;
    };
  },
});
async function finish(conversation, task, label) {
  const result = await harness.waitTask(
    conversation.storyId,
    task.id,
    undefined,
    620000,
  );
  const drafts = await harness.creative.drafts(
    conversation.storyId,
    conversation.id,
  );
  report.scenarios.push({
    label,
    conversation_id: conversation.id,
    story_id: conversation.storyId,
    session_id: conversation.sessionId,
    task_id: task.id,
    status: result.status,
    intent: result.intent,
    error: result.error,
    output: result.output,
    sources: result.sources,
    artifacts: result.artifacts,
    receipt: result.receipt,
    usage: result.usage,
    intent_usage: result.intentUsage,
    drafts: drafts.filter((draft) => draft.taskId === result.id),
  });
  console.log(
    JSON.stringify({
      event: "task_finished",
      label,
      status: result.status,
      intent: result.intent,
      saved: Boolean(result.receipt),
    }),
  );
  assert.equal(result.status, "succeeded", result.error ?? result.output);
  return { task: result, drafts };
}
async function start(message, label) {
  const { conversation, task } = await harness.request(
    "/api/creative/conversations",
    {
      clientRequestId: randomUUID(),
      message,
      provider: "deepseek",
      model: "deepseek-v4-flash",
    },
  );
  return { conversation, ...(await finish(conversation, task, label)) };
}
async function next(conversation, message, label, selectedDraft) {
  const task = await harness.request(
    `/api/stories/${conversation.storyId}/creative/tasks`,
    {
      clientRequestId: randomUUID(),
      conversationId: conversation.id,
      message,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      ...(selectedDraft ? { selectedDraft } : {}),
    },
  );
  return finish(conversation, task, label);
}
async function verifyPackage(result) {
  const receipt = result.task.receipt;
  assert.ok(receipt);
  const draft = result.drafts.find((item) => item.id === receipt.draft_id);
  assert.equal(receipt.draft_hash, draft.hash);
  assert.equal(receipt.content_hash, draft.hash);
  assert.ok(await harness.content.get(receipt.story_id, receipt.story_id));
  for (const asset of draft.initialization.assets) {
    assert.deepEqual(
      (await harness.content.get(asset.entity.id, receipt.story_id)).content,
      asset.entity.content,
    );
  }
  if (receipt.chapter) {
    assert.equal(
      (await harness.content.get(receipt.chapter.chapter_id, receipt.story_id))
        .content.markdown,
      draft.initialization.chapter.entity.content.markdown,
    );
  }
}
try {
  const character = await harness.content.commit(
    entity("character", {
      name: "合成角色：林舟",
      markdown: "林舟是沉静的灯塔守望者，随身带一枚银色指环。",
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
  const world = await harness.content.commit(
    entity("world", {
      name: "合成世界：潮汐港",
      markdown: "近代潮汐港用紫色火焰指引失航船只，港口每逢月蚀停航。",
      genres: ["奇幻"],
      ageBand: "",
      sourceMetadata: { era: "近代", tags: ["港口"] },
    }),
    null,
  );
  const premise =
    "从角色库寻找灯塔守望者林舟，从世界观库寻找近代潮汐港，读过匹配的资料后取完整独立快照，形成一份简短设定和大纲。故事用中文，题材奇幻，细节由你决定。";
  const staged = await start(
    premise + "现在建立作品并保存这些初始资料，暂时不写第一章。不需要再问我。",
    "initialize_only",
  );
  assert.equal(staged.task.receipt?.kind, "story_initialized");
  await verifyPackage(staged);
  assert.equal(
    (
      await harness.content.list({
        projectId: staged.conversation.storyId,
        kind: "chapter",
      })
    ).items.length,
    0,
  );
  const sources = staged.task.sources.filter(
    (source) => source.scope === "library",
  );
  assert.ok(sources.some((source) => source.asset_id === character.id));
  assert.ok(sources.some((source) => source.asset_id === world.id));
  const snapshots = (
    await harness.content.list({
      projectId: staged.conversation.storyId,
      kind: "snapshot",
    })
  ).items;
  for (const master of [character, world]) {
    const snapshot = snapshots.find(
      (asset) => asset.sourceAssetId === master.id,
    );
    assert.ok(
      snapshot,
      "An explicitly requested master copy needs its own complete snapshot",
    );
    assert.deepEqual(snapshot.content, master.content);
  }
  const session = (
    await harness.request(
      `/api/creative/conversations/${staged.conversation.id}`,
    )
  ).sessionId;
  const chapter = await next(
    staged.conversation,
    "继续刚才这部作品，让林舟收到失踪船只的来信，写第一章约200字并保存。保留已保存资料，情节细节由你决定，不需要再确认。",
    "staged_first_chapter",
  );
  assert.equal(chapter.task.receipt?.kind, "first_chapter_saved");
  await verifyPackage(chapter);
  assert.equal(
    (
      await harness.request(
        `/api/creative/conversations/${staged.conversation.id}`,
      )
    ).sessionId,
    session,
  );

  const preview = await start(
    premise +
      "先给我一个约200字第一章开场和资料候选，暂时不要建立作品，也不要正式保存。",
    "preview_unestablished",
  );
  assert.equal(preview.task.receipt, undefined);
  assert.equal(
    await harness.content.get(
      preview.conversation.storyId,
      preview.conversation.storyId,
    ),
    undefined,
  );
  const selected = preview.drafts.find(
    (draft) => draft.id === preview.task.artifacts.at(-1)?.draft_id,
  );
  assert.ok(selected?.initialization?.chapter);
  const saved = await next(
    preview.conversation,
    "确认选中的整个版本，原样保存初始资料和第一章并建立作品，不要改写。",
    "save_exact_package",
    {
      draft_id: selected.id,
      draft_revision: selected.draftRevision,
      draft_hash: selected.hash,
    },
  );
  assert.equal(saved.task.receipt?.draft_hash, selected.hash);
  assert.equal(saved.task.receipt?.kind, "first_chapter_saved");
  await verifyPackage(saved);

  const direct = await start(
    premise +
      "直接建立作品、写约200字第一章并一起保存，情节细节由你决定，无需再确认。",
    "direct_first_chapter",
  );
  assert.equal(direct.task.receipt?.kind, "first_chapter_saved");
  await verifyPackage(direct);
  assert.deepEqual(
    (await harness.content.get(character.id, "library")).content,
    character.content,
  );
  assert.deepEqual(
    (await harness.content.get(world.id, "library")).content,
    world.content,
  );
  const count = report.calls.length;
  await harness.request(
    `/api/creative/conversations/${direct.conversation.id}`,
  );
  await harness.request(
    `/api/stories/${direct.conversation.storyId}/creative/tasks/${direct.task.id}`,
  );
  assert.equal(report.calls.length, count);
  await Promise.all(settlements);
  assert.ok(
    report.calls
      .filter((call) => call.phase === "intent")
      .every((call) =>
        call.content_sizes?.every(
          (part) => part.type !== "thinking" || part.characters === 0,
        ),
      ),
    "Independent intent sessions must not spend the output budget on thinking",
  );
  report.outcome = "passed";
} catch (error) {
  report.outcome = "failed";
  report.failure = error instanceof Error ? error.message : "smoke_failed";
  process.exitCode = 1;
} finally {
  report.callbacks = harness.callbacks.map((call) => ({
    task_id: call.task_id,
    tool: call.tool.name,
    mode: call.arguments.mode,
  }));
  await harness.close();
  await Promise.all(settlements);
  await reportWrite;
  report.finished_at = new Date().toISOString();
  report.cost_upper_usd = settledUsd + reservedUsd;
  report.cumulative_upper_usd = priorUsd + report.cost_upper_usd;
  assert.ok(report.cost_upper_usd <= budget, "Smoke budget exceeded");
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      outcome: report.outcome,
      model_calls: report.calls.length,
      cost_upper_usd: report.cost_upper_usd,
      cumulative_upper_usd: report.cumulative_upper_usd,
      report: reportPath,
    }),
  );
}
