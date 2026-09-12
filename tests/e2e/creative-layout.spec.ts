import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { creativeFixture } from "./creative-fixture.js";
import { wireId } from "../../src/server/creative.js";
import type { CreativeTask, DraftRef } from "../../src/shared/creative.js";
let f: Awaited<ReturnType<typeof creativeFixture>>;
test.beforeEach(async ({ page }) => {
  f = await creativeFixture();
  await page.goto(f.address + "/#stories");
  await page.getByRole("button", { name: "使用 Microsoft 账号登录" }).click();
  await page.getByRole("button", { name: /灯塔.*故事/ }).click();
  await page.locator(".sidebar-more > summary").click();
  await page
    .getByRole("button", { name: "旧故事创作会话", exact: true })
    .click();
  await page.getByText("会话与导航", { exact: true }).click();
  await page.getByRole("button", { name: "新建创作会话", exact: true }).click();
});
test.afterEach(async () => {
  await f?.close();
});
async function send(page: Page, text: string) {
  await page.getByLabel("对故事说点什么", { exact: true }).fill(text);
  const response = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && /\/creative\/tasks$/.test(r.url()),
  );
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const task = (await (await response).json()) as CreativeTask;
  await expect
    .poll(async () => (await f.creative.task(f.story.id, task.id)).status)
    .toBe("running");
  return f.creative.task(f.story.id, task.id);
}
async function draft(task: CreativeTask, title: string) {
  const ctx = (await f.creative.resolveTask(wireId(f.story.id, task.id)))!;
  await ctx.bindRun(task.runId!);
  const value = await f.creative.createChapter(
    ctx,
    {
      mode: "draft",
      title,
      body: Array.from(
        { length: 65 },
        (_, i) => `第 ${i + 1} 段。海雾散去，灯塔重新亮起。`,
      ).join("\n\n"),
    },
    randomUUID(),
  );
  return value.data as DraftRef;
}
async function finish(task: CreativeTask) {
  f.mochi.finish(task.runId!);
  f.mochi.runs.get(task.runId!)!.result = {
    text: "这是一段对话回复。\n\n".repeat(60),
  };
  await expect
    .poll(async () => (await f.creative.task(f.story.id, task.id)).status)
    .toBe("succeeded");
}
test("desktop keeps draft and conversation independently scrollable with the composer visible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const task = await send(page, "先写一个草稿");
  const firstDraft = await draft(task, "第一稿");
  await finish(task);
  await expect(
    page.getByRole("region", { name: "草稿正文", exact: true }),
  ).toContainText("第 65 段");
  const conversation = page.getByRole("region", {
    name: "对话内容",
    exact: true,
  });
  const reading = page.getByRole("region", { name: "草稿正文", exact: true });
  await expect(reading).toContainText("第 65 段");
  const before = await conversation.evaluate((e) => e.scrollTop);
  await reading.evaluate((e) => {
    e.scrollTop = 420;
  });
  expect(await reading.evaluate((e) => e.scrollTop)).toBe(420);
  expect(await conversation.evaluate((e) => e.scrollTop)).toBe(before);
  const a = await conversation.boundingBox(),
    b = await reading.boundingBox();
  expect(b!.x).toBeGreaterThan(a!.x + a!.width);
  await page.screenshot({ path: "/tmp/mochi-write-session-desktop.png" });
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollHeight <= innerHeight,
    ),
  ).toBe(true);
  const feedback = await send(page, "请让这一版的开场更慢一点");
  expect(feedback.selectedDraft?.draft_id).toBe(firstDraft.draft_id);
});
test("mobile keeps reading position and exact feedback reference without switching to a new draft", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const task = await send(page, "先给我一稿");
  const ref = await draft(task, "原稿");
  await finish(task);
  const conversationTab = page.getByRole("tab", { name: "对话", exact: true });
  const draftTab = page.getByRole("tab", { name: /^草稿/ });
  await expect(conversationTab).toHaveAttribute("aria-selected", "true");
  await expect(draftTab).toContainText("有更新");
  await draftTab.click();
  const reading = page.getByRole("region", { name: "草稿正文", exact: true });
  await expect(reading).toContainText("第 65 段");
  await reading.evaluate((e) => {
    e.scrollTop = 360;
  });
  await conversationTab.click();
  const conversation = page.getByRole("region", {
    name: "对话内容",
    exact: true,
  });
  await conversation.evaluate((e) => {
    e.scrollTop = 180;
  });
  await draftTab.click();
  expect(await reading.evaluate((e) => e.scrollTop)).toBe(360);
  await expect(
    page.getByLabel("对故事说点什么", { exact: true }),
  ).toBeInViewport();
  const next = await send(page, "这一版的节奏再慢一点");
  expect(next.selectedDraft).toEqual({
    draft_id: ref.draft_id,
    draft_revision: ref.draft_revision,
    draft_hash: ref.draft_hash,
  });
  await expect(draftTab).toHaveAttribute("aria-selected", "true");
  const newer = await draft(next, "修改稿");
  await finish(next);
  await expect(
    page.getByRole("button", { name: "查看新版本", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "原稿", exact: true }),
  ).toBeVisible();
  expect(await reading.evaluate((e) => e.scrollTop)).toBe(360);
  await conversationTab.click();
  expect(await conversation.evaluate((e) => e.scrollTop)).toBe(180);
  await draftTab.click();
  await page.getByRole("button", { name: "查看新版本", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "修改稿", exact: true }),
  ).toBeVisible();
  f.mochi.intent = "save_current";
  await page.getByRole("button", { name: "保存此版本", exact: true }).click();
  const savingResponse = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && /\/creative\/tasks$/.test(r.url()),
  );
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const saving = (await (await savingResponse).json()) as CreativeTask;
  expect(saving.selectedDraft).toEqual({
    draft_id: newer.draft_id,
    draft_revision: newer.draft_revision,
    draft_hash: newer.draft_hash,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "/tmp/mochi-write-session-mobile.png" });
});

test("changing the draft from a legacy selection link keeps the new exact reference and typed feedback", async ({
  page,
}) => {
  const task = await send(page, "给我两个版本");
  const original = await draft(task, "原稿");
  const next = await draft(task, "另一稿");
  await finish(task);
  await page.goto(
    `${f.address}/#story/${f.story.id}/creative/${task.conversationId}/${original.draft_id}`,
  );
  const input = page.getByLabel("对故事说点什么", { exact: true });
  await expect(input).toHaveValue("保存这个版本");
  await input.fill("请调整第二段的节奏");
  await page
    .getByLabel("草稿版本", { exact: true })
    .selectOption(next.draft_id);
  await expect(input).toHaveValue("请调整第二段的节奏");
  const submitted = await send(page, "请调整第二段的节奏");
  expect(submitted.selectedDraft).toEqual({
    draft_id: next.draft_id,
    draft_revision: next.draft_revision,
    draft_hash: next.draft_hash,
  });
});

test("model and thinking can be chosen before the first message and stay locked after refresh", async ({
  page,
}) => {
  await page
    .getByLabel("创作模型", { exact: true })
    .selectOption("deepseek/other");
  await expect(
    page.getByLabel("思考强度", { exact: true }).locator('option[value="low"]'),
  ).toHaveCount(0);
  await page
    .getByLabel("创作模型", { exact: true })
    .selectOption("deepseek/test");
  await page.getByLabel("思考强度", { exact: true }).selectOption("high");
  const task = await send(page, "先聊聊故事");
  expect(task).toMatchObject({
    provider: "deepseek",
    model: "test",
    thinkingLevel: "high",
  });
  await expect(page.getByLabel("创作模型", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("思考强度", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("会话模型设置", { exact: true })).toContainText(
    "高",
  );
  await finish(task);
  await page.reload();
  await expect(page.getByLabel("会话模型设置", { exact: true })).toContainText(
    "test",
  );
  await expect(page.getByLabel("会话模型设置", { exact: true })).toContainText(
    "高",
  );
  const next = await send(page, "继续讨论");
  expect(next).toMatchObject({ model: "test", thinkingLevel: "high" });
  await page.getByText("会话与导航", { exact: true }).click();
  await page.getByRole("button", { name: "新建创作会话", exact: true }).click();
  await expect(page.getByLabel("创作模型", { exact: true })).toBeEnabled();
  await expect(page.getByLabel("思考强度", { exact: true })).toBeEnabled();
});
