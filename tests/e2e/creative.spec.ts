import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { creativeFixture } from "./creative-fixture.js";
import { wireId } from "../../src/server/creative.js";
import { AssetTools } from "../../src/server/asset-tools.js";
import type { CreativeTask, DraftRef } from "../../src/shared/creative.js";
let f: Awaited<ReturnType<typeof creativeFixture>>;
test.beforeEach(async ({ page }) => {
  f = await creativeFixture();
  await page.goto(f.address);
  await page.getByRole("button", { name: "使用 Microsoft 账号登录" }).click();
  await page.getByRole("link", { name: "故事书架" }).click();
  await page.getByRole("button", { name: /灯塔.*故事/ }).click();
});
test.afterEach(async () => {
  await f?.close();
});
async function send(page: Page, message: string, create = true) {
  if (create)
    await page
      .getByRole("button", { name: "新建创作会话", exact: true })
      .click();
  await page.getByLabel("对故事说点什么", { exact: true }).fill(message);
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
async function context(task: CreativeTask) {
  const ctx = (await f.creative.resolveTask(wireId(f.story.id, task.id)))!;
  await ctx.bindRun(task.runId!);
  return ctx;
}
async function draft(task: CreativeTask) {
  const ctx = await context(task);
  const result = await f.creative.createChapter(
    ctx,
    {
      mode: "draft",
      title: "第三章 归灯",
      body: "海雾散去，灯塔重新亮起。\n\n原稿末尾  \n",
    },
    randomUUID(),
  );
  const { draft_id, draft_revision, draft_hash } = result.data as DraftRef;
  return { ctx, ref: { draft_id, draft_revision, draft_hash } };
}
function taskSection(page: Page, task: CreativeTask) {
  return page.getByRole("region", { name: `创作任务 ${task.id}`, exact: true });
}
test("story entry opens the creative conversation workspace", async ({
  page,
}) => {
  await expect(
    page.getByRole("heading", { name: "创作会话", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "新建创作会话", exact: true }),
  ).toBeVisible();
  expect(f.mochi.calls.filter((c) => c.path === "/v1/sessions")).toHaveLength(
    0,
  );
});
test("independent draft survives refresh and exact selection saves one chapter only with a receipt", async ({
  page,
}) => {
  const task = await send(page, "先写一章给我看看，不保存");
  const originalChapters = (
    await f.store.list({ projectId: f.story.id, kind: "chapter" })
  ).items.length;
  const { ref } = await draft(task);
  f.mochi.finish(task.runId!);
  f.mochi.runs.get(task.runId!)!.result = {
    text: "我已经保存了本章。模型聊天不能证明保存。",
  };
  const first = taskSection(page, task);
  await expect(
    first.getByText("我已经保存了本章。模型聊天不能证明保存。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("章节已保存", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "打开章节", exact: true }),
  ).toHaveCount(0);
  expect(
    (await f.store.list({ projectId: f.story.id, kind: "chapter" })).items,
  ).toHaveLength(originalChapters);
  await page.getByRole("button", { name: "阅读草稿", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/draft/${ref.draft_id}$`));
  await expect(
    page.getByText("海雾散去，灯塔重新亮起。", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "第三章 归灯", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "选择此版本", exact: true }).click();
  await expect(
    page.getByText("已选择草稿：第三章 归灯（版本 1）", { exact: true }),
  ).toBeVisible();
  f.mochi.intent = "save_current";
  const saving = await send(page, "保存这个版本", false);
  expect(saving.selectedDraft).toEqual(ref);
  const result = await f.creative.createChapter(
    await context(saving),
    { mode: "commit", ...ref },
    randomUUID(),
  );
  f.mochi.finish(saving.runId!);
  const saved = taskSection(page, saving);
  await expect(saved.getByText("章节已保存", { exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/mwt012-creative.png", fullPage: true });
  await saved.getByRole("button", { name: "打开章节", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "第三章 归灯", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("海雾散去，灯塔重新亮起。", { exact: true }),
  ).toBeVisible();
  const chapter = await f.store.get(result.receipt!.chapter_id, f.story.id);
  expect(chapter!.content.markdown).toBe(
    (await f.creative.draft(f.story.id, ref.draft_id)).body,
  );
  expect(
    (await f.store.list({ projectId: f.story.id, kind: "chapter" })).items,
  ).toHaveLength(originalChapters + 1);
  expect(f.mochi.creativePosts()).toHaveLength(2);
});
test("running refresh resumes the same task and repeated tool events render once while sources reject changed revisions", async ({
  page,
}) => {
  const task = await send(page, "先查灯塔的资料");
  const source = (
    await f.store.list({ projectId: f.story.id, kind: "snapshot" })
  ).items[0]!;
  await new AssetTools(f.store).read(await context(task), {
    asset_id: source.id,
    revision: source.revision,
  });
  const invocation = randomUUID();
  f.mochi.toolEvents = [
    {
      cursor: 1,
      type: "tool_started",
      data: { invocation_id: invocation, name: "read_asset" },
      created_at: new Date().toISOString(),
    },
    {
      cursor: 2,
      type: "tool_finished",
      data: {
        invocation_id: invocation,
        name: "read_asset",
        status: "succeeded",
      },
      created_at: new Date().toISOString(),
    },
  ];
  const region = taskSection(page, task);
  await expect(
    region.getByRole("region", { name: "工具进展" }).getByText(/读取资料/),
  ).toHaveCount(1);
  await expect
    .poll(() => f.mochi.calls.some((c) => c.path.endsWith("/events?after=2")))
    .toBe(true);
  await expect(
    region.getByRole("region", { name: "工具进展" }).getByText(/读取资料/),
  ).toHaveCount(1);
  await page.reload();
  await expect(taskSection(page, task)).toBeVisible();
  expect(f.mochi.creativePosts()).toHaveLength(1);
  await f.store.commit(
    {
      ...source,
      currentVersion: source.currentVersion + 1,
      content: {
        ...source.content,
        markdown: "这是后来的资料，不能冒充旧版本。",
      },
    },
    source.revision,
  );
  await taskSection(page, task)
    .getByRole("button", {
      name: `查看来源：${source.content.name}`,
      exact: true,
    })
    .click();
  await expect(
    page.getByText("资料版本已变化，无法展示本轮读取的原版本", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("这是后来的资料，不能冒充旧版本。", { exact: true }),
  ).toHaveCount(0);
});
test("unknown save verification does not replay generation or imply a saved chapter", async ({
  page,
}) => {
  f.mochi.intent = "create_and_save";
  const task = await send(page, "写一章并保存");
  Object.assign(f.mochi.runs.get(task.runId!)!, {
    status: "failed",
    result: null,
    operations: [{ operation_id: task.operationId, status: "unknown" }],
  });
  const region = taskSection(page, task);
  await expect(
    region.getByText("保存结果待核实", { exact: true }),
  ).toBeVisible();
  await expect(
    region.getByRole("button", { name: "打开章节", exact: true }),
  ).toHaveCount(0);
  f.mochi.verification = [
    { operation_id: task.operationId, status: "rejected" },
  ];
  await region
    .getByRole("button", { name: "核实保存结果", exact: true })
    .click();
  await expect(region.getByText("保存结果待核实", { exact: true })).toHaveCount(
    0,
  );
  expect((await f.creative.task(f.story.id, task.id)).operationStatus).toBe(
    "rejected",
  );
  expect(
    f.mochi.calls.filter((c) => c.path.endsWith("/operations/verify")),
  ).toHaveLength(1);
  expect(f.mochi.creativePosts()).toHaveLength(1);
  await expect(page.getByText("章节已保存", { exact: true })).toHaveCount(0);
});
test("stop revokes permission immediately and exposes retry while remote cancellation is unavailable", async ({
  page,
}) => {
  f.mochi.intent = "create_and_save";
  const task = await send(page, "写一章并保存");
  const { ctx, ref } = await draft(task);
  f.mochi.failCancel = true;
  await taskSection(page, task)
    .getByRole("button", { name: "停止并撤回授权", exact: true })
    .click();
  await expect(
    taskSection(page, task).getByRole("button", {
      name: "重试停止",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    f.creative.createChapter(ctx, { mode: "commit", ...ref }, randomUUID()),
  ).rejects.toMatchObject({ code: "authorization_revoked" });
  await page.reload();
  await expect(
    taskSection(page, task).getByRole("button", {
      name: "重试停止",
      exact: true,
    }),
  ).toBeVisible();
  f.mochi.failCancel = false;
  await taskSection(page, task)
    .getByRole("button", { name: "重试停止", exact: true })
    .click();
  await expect
    .poll(async () => (await f.creative.task(f.story.id, task.id)).stopPending)
    .toBe(false);
  await expect(
    taskSection(page, task).getByRole("button", {
      name: "重试停止",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(f.mochi.creativePosts()).toHaveLength(1);
  await expect(page.getByText("章节已保存", { exact: true })).toHaveCount(0);
});

test("terminal history drains all event pages before marking tool progress complete", async ({
  page,
}) => {
  const task = await send(page, "读取故事资料");
  await page.goto("about:blank");
  f.mochi.paginateEvents = true;
  const invocation = randomUUID();
  f.mochi.toolEvents = Array.from({ length: 101 }, (_, i) => ({
    cursor: i + 1,
    type: i === 0 ? "tool_started" : i === 100 ? "tool_finished" : "text_delta",
    data:
      i === 0 || i === 100
        ? {
            invocation_id: invocation,
            name: "read_asset",
            ...(i === 100 ? { status: "succeeded" } : {}),
          }
        : { text: "进展" },
    created_at: new Date().toISOString(),
  }));
  f.mochi.finish(task.runId!);
  await expect
    .poll(async () => (await f.creative.task(f.story.id, task.id)).status)
    .toBe("succeeded");
  await page.goto(
    `${f.address}/#story/${f.story.id}/creative/${task.conversationId}`,
  );
  const progress = taskSection(page, task).getByRole("region", {
    name: "工具进展",
  });
  await expect(
    progress.getByText("读取资料 · 已完成", { exact: true }),
  ).toBeVisible();
  await expect(progress.getByRole("listitem")).toHaveCount(1);
  expect(f.mochi.calls.some((c) => c.path.endsWith("/events?after=100"))).toBe(
    true,
  );
  expect(f.mochi.creativePosts()).toHaveLength(1);
});

for (const destination of ["unselected", "missing"] as const) {
  test(`changing selected draft route to ${destination} clears the former exact draft`, async ({
    page,
  }) => {
    const task = await send(page, "先写个草稿");
    const { ref } = await draft(task);
    f.mochi.finish(task.runId!);
    await page.getByRole("button", { name: "阅读草稿", exact: true }).click();
    await page.getByRole("button", { name: "选择此版本", exact: true }).click();
    const selected = page.getByText("已选择草稿：第三章 归灯（版本 1）", {
      exact: true,
    });
    await expect(selected).toBeVisible();
    const suffix = destination === "missing" ? `/${randomUUID()}` : "";
    const target = `#story/${f.story.id}/creative/${task.conversationId}${suffix}`;
    await page.evaluate((hash) => {
      location.hash = hash;
    }, target);
    if (destination === "missing")
      await expect(page.getByRole("alert")).toContainText("草稿不存在");
    await expect(selected).toHaveCount(0);
    await page.getByLabel("对故事说点什么", { exact: true }).fill("先继续讨论");
    if (
      await page.getByRole("button", { name: "发送", exact: true }).isEnabled()
    ) {
      const request = page.waitForRequest(
        (r) => r.method() === "POST" && /\/creative\/tasks$/.test(r.url()),
      );
      await page.getByRole("button", { name: "发送", exact: true }).click();
      expect((await request).postDataJSON().selectedDraft).toBeUndefined();
    }
    expect(
      (await f.creative.draft(f.story.id, ref.draft_id)).receipt,
    ).toBeUndefined();
  });
}
