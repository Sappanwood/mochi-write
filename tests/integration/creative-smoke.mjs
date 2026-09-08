import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import process from "node:process";
import console from "node:console";
import { creativeHarness } from "./creative-harness.mjs";

assert.equal(
  process.env.MOCHI_REAL_SMOKE,
  "deepseek-v4-flash",
  "Real smoke requires explicit MOCHI_REAL_SMOKE=deepseek-v4-flash",
);
const budget = Number(process.env.MOCHI_SMOKE_BUDGET_USD ?? 10);
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
  pricing_basis:
    "Conservative peak rates: all input including cached input $0.44/M; output $1.32/M. This is an upper estimate, not an invoice.",
  pricing_source: "https://api-docs.deepseek.com/quick_start/pricing/",
  calls: [],
  scenarios: [],
  outcome: "running",
};
let reservedUsd = 0,
  settledUsd = 0;
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
        throw new Error("smoke_provider_failed");
      }
      settlements.push(
        stream
          .result()
          .then((message) => {
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
try {
  const story = await harness.story("真实模型隔离测试：潮汐灯塔");
  report.story_id = story.id;
  const base = `/api/stories/${story.id}/creative`;
  async function submit(conversation, message, label, selectedDraft) {
    const task = await harness.request(base + "/tasks", {
      clientRequestId: randomUUID(),
      conversationId: conversation.id,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      message,
      ...(selectedDraft ? { selectedDraft } : {}),
    });
    console.log(
      JSON.stringify({ event: "task_submitted", label, task_id: task.id }),
    );
    const result = await harness.waitTask(story.id, task.id, undefined, 620000);
    const drafts = await harness.creative.drafts(story.id, conversation.id);
    const evidence = {
      label,
      user_message: message,
      conversation_id: conversation.id,
      task_id: result.id,
      intent: result.intent,
      intent_run_id: result.intentRunId,
      run_id: result.runId,
      status: result.status,
      error: result.error,
      output: result.output,
      sources: result.sources,
      artifacts: result.artifacts,
      receipt: result.receipt,
      usage: result.usage,
      intent_usage: result.intentUsage,
      drafts: drafts
        .filter((draft) => draft.taskId === result.id)
        .map((draft) => ({
          id: draft.id,
          title: draft.title,
          body: draft.body,
          hash: draft.hash,
        })),
    };
    report.scenarios.push(evidence);
    console.log(
      JSON.stringify({
        event: "task_finished",
        label,
        task_id: result.id,
        status: result.status,
        intent: result.intent,
        sources: result.sources.length,
        drafts: result.artifacts.length,
        saved: Boolean(result.receipt),
      }),
    );
    assert.equal(result.status, "succeeded", result.error ?? result.output);
    return { task: result, drafts };
  }
  const directConversation = await harness.request(base + "/conversations", {});
  const direct = await submit(
    directConversation,
    "让林舟在潮汐港的暴风夜守住灯塔，参考本故事设定与人物，写一章约300字并保存。",
    "direct_save",
  );
  assert.equal(direct.task.intent, "create_and_save");
  assert.ok(
    direct.task.sources.length > 0,
    "The model must independently read story assets",
  );
  assert.ok(
    direct.task.receipt,
    "Explicit direct save requires a durable receipt",
  );
  const directChapter = await harness.request(
    `/api/stories/${story.id}/documents/${direct.task.receipt.chapter_id}`,
  );
  assert.equal(
    directChapter.content.markdown,
    direct.drafts.find((draft) => draft.receipt)?.body,
  );
  const previewConversation = await harness.request(
    base + "/conversations",
    {},
  );
  const preview = await submit(
    previewConversation,
    "让林舟收到一封来自失踪渔船的信，参考本故事资料写一章约300字，先给我看看，不要保存。",
    "draft_only",
  );
  assert.equal(preview.task.intent, "draft");
  assert.equal(preview.task.receipt, undefined);
  assert.ok(preview.task.sources.length > 0);
  assert.ok(preview.task.artifacts.length > 0);
  const selected = preview.drafts.find(
    (draft) => draft.id === preview.task.artifacts.at(-1).draft_id,
  );
  assert.ok(selected);
  const saved = await submit(
    previewConversation,
    "保存这个版本，不要改写。",
    "save_exact_draft",
    {
      draft_id: selected.id,
      draft_revision: selected.draftRevision,
      draft_hash: selected.hash,
    },
  );
  assert.equal(saved.task.intent, "save_current");
  assert.ok(saved.task.receipt);
  const chapter = await harness.request(
    `/api/stories/${story.id}/documents/${saved.task.receipt.chapter_id}`,
  );
  assert.equal(chapter.content.markdown, selected.body);
  assert.equal(saved.task.receipt.content_hash, selected.hash);
  assert.equal(
    (await harness.content.list({ projectId: story.id, kind: "chapter" })).items
      .length,
    2,
  );
  report.callbacks = harness.callbacks.map((call) => ({
    task_id: call.task_id,
    run_id: call.run_id,
    tool: call.tool.name,
    mode: call.arguments.mode,
  }));
  report.outcome = "passed";
} catch (error) {
  report.outcome = "failed";
  report.failure = error instanceof Error ? error.message : "smoke_failed";
  process.exitCode = 1;
} finally {
  await harness.close();
  await Promise.all(settlements);
  report.finished_at = new Date().toISOString();
  report.cost_upper_usd = settledUsd + reservedUsd;
  assert.ok(report.cost_upper_usd <= budget, "Smoke budget exceeded");
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      outcome: report.outcome,
      model_calls: report.calls.length,
      cost_upper_usd: report.cost_upper_usd,
      report: reportPath,
    }),
  );
}
