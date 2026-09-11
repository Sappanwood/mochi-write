import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { freeFixture } from "./free-fixture.js";
import { entity } from "../../src/server/entities.js";
import { worldContent } from "../support/free-world.js";
import {
  assetReference,
  materialResolve,
  materialDraft,
  materialRequests,
} from "../support/free-materials.js";
let f: Awaited<ReturnType<typeof freeFixture>>;
test.afterEach(async () => {
  await f?.close();
});
for (const width of [1280, 390])
  test(`material members, exact old draft save and reading return at ${width}px`, async ({
    page,
  }) => {
    f = await freeFixture();
    f.free.options.autoStart = false;
    const id = randomUUID();
    const story = await f.store.commit(
      { ...entity("story", worldContent("灯塔"), id, id), status: "ready" },
      null,
    );
    for (const [kind, name] of [
      ["chapter", "首章"],
      ["snapshot", "林舟"],
      ["setting", "设定"],
      ["outline", "大纲"],
    ] as const)
      await f.store.commit(entity(kind, worldContent(name), id), null);
    const mother = await f.store.commit(
      entity("character", {
        ...worldContent("守塔人"),
        sourceMetadata: { occupation: "守塔", custom: "完整来源字段" },
      }),
      null,
    );
    const { task, conversation } = await f.free.start({
      clientRequestId: randomUUID(),
      message: "为灯塔新增守塔人角色快照，更新林舟、设定和大纲，只预览",
      provider: "deepseek",
      model: "test",
      refs: [assetReference(story), assetReference(mother)],
    });
    const requests = materialRequests().map((m) =>
      m.key === "new" ? { ...m, source_ref: assetReference(mother) } : m,
    );
    const resolved = await materialResolve(f.free, task, requests);
    const old = await materialDraft(f.free, resolved, {
      members: requests.map((m) =>
        m.key === "new"
          ? { key: m.key, copy_source: true }
          : {
              key: m.key,
              name: m.name ?? m.key,
              markdown: "初稿完整正文：铜钥匙打开北塔。",
            },
      ),
    });
    const next = await f.free.submit(conversation.id, {
      clientRequestId: randomUUID(),
      message: "修改这份候选，仅预览",
      provider: "deepseek",
      model: "test",
      refs: [f.free.candidates.ref(old)],
    });
    const feedback = await materialResolve(f.free, next, []);
    await materialDraft(f.free, feedback, {
      group_id: old.groupId,
      parent_ref: f.free.candidates.ref(old),
    });
    await f.free.cancel(feedback.id);
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${f.address}/#free/conversation/${conversation.id}`);
    await page.getByRole("button", { name: "使用 Microsoft 账号登录" }).click();
    await expect(
      page.getByRole("complementary", { name: "故事资料能力" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("complementary", { name: "旧会话能力" }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: /查看：灯塔 · 资料修订 · 第 1 稿/ })
      .click();
    const body = page.getByRole("region", { name: "信息正文" });
    await body.locator("summary", { hasText: "快照 · 守塔人" }).click();
    await expect(body).toContainText("新增 · 无基础版本");
    await expect(body).toContainText("母版 v1");
    await body.getByText("完整属性", { exact: true }).first().click();
    await expect(body).toContainText("完整来源字段");
    await body.locator("summary", { hasText: "设定 · setting" }).click();
    await expect(body).toContainText("更新 · 基于 v1");
    await expect(body).toContainText("初稿完整正文");
    await page.getByRole("button", { name: "引用到对话", exact: true }).click();
    if (width === 390)
      await page.getByRole("tab", { name: "讨论", exact: true }).click();
    f.free.options.autoStart = true;
    f.mochi.freeIntent = "save_current";
    f.mochi.targetKind = "story";
    f.mochi.targetMode = "explicit";
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url().endsWith(`/conversations/${conversation.id}/tasks`),
    );
    await page.getByLabel("下一条消息").fill("原样保存选定的第一稿资料");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    const saving = (await (await response).json()).task;
    await expect
      .poll(async () => (await f.free.task(saving.id)).executionRun?.runId)
      .toBeTruthy();
    await f.invoke(saving, "revise_story_materials", {
      mode: "commit",
      draft_id: old.id,
      draft_revision: "1",
      draft_hash: old.draftHash,
    });
    const current = await f.free.task(saving.id);
    f.mochi.finish(current.executionRun!.runId!);
    await f.free.verify(saving.id);
    await expect(
      page.getByText("故事资料已保存", { exact: true }),
    ).toBeVisible();
    await page.getByLabel("下一条消息").fill("返回后继续讨论");
    await page
      .getByRole("button", { name: "更新 设定 · v2", exact: true })
      .click();
    await expect(
      page
        .locator(".reader-layout .reading-pane")
        .getByText("初稿完整正文：铜钥匙打开北塔。", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await page
      .getByRole("link", { name: "返回原自由会话", exact: true })
      .click();
    if (width === 390)
      await page.getByRole("tab", { name: "讨论", exact: true }).click();
    await expect(page.getByLabel("下一条消息")).toHaveValue("返回后继续讨论");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
test("world-v1 keeps its capability snapshot and offers an independent materials entry", async ({
  page,
}) => {
  f = await freeFixture();
  f.free.options.autoStart = false;
  const { conversation } = await f.free.start({
    clientRequestId: randomUUID(),
    message: "旧会话",
    provider: "deepseek",
    model: "test",
  });
  await f.records.transaction("library", [
    {
      record: { ...conversation, toolsetVersion: "world-v1" },
      revision: conversation.revision,
    },
  ]);
  const before = await f.free.conversation(conversation.id);
  await page.goto(`${f.address}/#free/conversation/${conversation.id}`);
  await page.getByRole("button", { name: "使用 Microsoft 账号登录" }).click();
  await expect(
    page.getByRole("complementary", { name: "旧会话能力" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("complementary", { name: "故事资料能力" }),
  ).toContainText("原聊天、候选稿和保存授权保留");
  await page.getByRole("button", { name: "新建支持故事资料的会话" }).click();
  expect((await f.records.list("conversation")).length).toBe(1);
  expect(await f.free.conversation(conversation.id)).toEqual(before);
});
