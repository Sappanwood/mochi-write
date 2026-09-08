import { randomUUID } from "node:crypto";
import { wireId } from "../../src/server/creative.js";
import { Library } from "../../src/server/library.js";
import { LibraryTools } from "../../src/server/library-tools.js";
import type {
  CreativeTask,
  DraftRef,
  InitializationReceipt,
} from "../../src/shared/creative.js";
import { test, expect, type Page } from "@playwright/test";
import { creativeFixture } from "./creative-fixture.js";
let f: Awaited<ReturnType<typeof creativeFixture>>;
test.beforeEach(async ({ page }) => {
  f = await creativeFixture();
  await page.goto(f.address + "/#stories");
  await page.getByRole("button", { name: "使用 Microsoft 账号登录" }).click();
});
test.afterEach(async () => {
  await f?.close();
});
test("empty and ordinary shelves open natural conversation before any title or asset is required", async ({
  page,
}) => {
  await expect(
    page.getByRole("button", { name: "新建故事", exact: true }),
  ).toBeVisible();
  f.store.heads.clear();
  await page.reload();
  await expect(
    page.getByText("书架上还没有故事。先聊聊你的想法。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新建故事", exact: true }).click();
  await expect(page).toHaveURL(/#creative\/new$/);
  await expect(
    page.getByRole("heading", { name: "从一个想法开始", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("对故事说点什么", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("作品标题", { exact: true })).toHaveCount(0);
  expect(await f.records.conversations()).toHaveLength(0);
});

async function first(page: Page, message: string) {
  await page.getByRole("button", { name: "新建故事", exact: true }).click();
  return send(page, message, true);
}
async function send(page: Page, message: string, initial = false) {
  await page.getByLabel("对故事说点什么", { exact: true }).fill(message);
  const response = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      (initial
        ? /\/api\/creative\/conversations$/.test(r.url())
        : /\/creative\/tasks$/.test(r.url())),
  );
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const value = await (await response).json();
  const task = (initial ? value.task : value) as CreativeTask;
  await expect
    .poll(async () => (await f.creative.task(task.storyId, task.id)).status)
    .toBe("running");
  return f.creative.task(task.storyId, task.id);
}
async function context(task: CreativeTask) {
  const ctx = (await f.creative.resolveTask(wireId(task.storyId, task.id)))!;
  await ctx.bindRun(task.runId!);
  return ctx;
}
function ref(data: unknown): DraftRef {
  const d = data as DraftRef;
  return {
    draft_id: d.draft_id,
    draft_revision: d.draft_revision,
    draft_hash: d.draft_hash,
  };
}
function region(page: Page, task: CreativeTask) {
  return page.getByRole("region", { name: `创作任务 ${task.id}`, exact: true });
}
async function finish(task: CreativeTask) {
  f.mochi.finish(task.runId!);
  await expect
    .poll(async () => (await f.creative.task(task.storyId, task.id)).status)
    .toBe("succeeded");
}

test("lost first response resumes the unestablished conversation by GET and never resends on refresh", async ({
  page,
}) => {
  let posts = 0;
  await page.route("**/api/creative/conversations", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts++;
    await route.fetch();
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "新建故事", exact: true }).click();
  await page
    .getByLabel("对故事说点什么", { exact: true })
    .fill("一个在月亮上修钟的人");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByText("首次提交结果待核实。刷新只查询原请求，不会重新发送。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect
    .poll(async () => (await f.records.conversations()).length)
    .toBe(1);
  const [conversation] = await f.records.conversations();
  expect(conversation).toBeDefined();
  expect(
    await f.store.get(conversation!.storyId, conversation!.storyId),
  ).toBeUndefined();
  await page.reload();
  await expect(page).toHaveURL(
    new RegExp(`#creative/conversation/${conversation!.id}$`),
  );
  await expect(
    page.getByText("一个在月亮上修钟的人", { exact: true }),
  ).toBeVisible();
  expect(posts).toBe(1);
  await page.getByRole("button", { name: "全部创作会话", exact: true }).click();
  await expect(page.getByText("尚未建立作品", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /一个在月亮上修钟的人/ }).click();
  await expect(page).toHaveURL(
    new RegExp(`#creative/conversation/${conversation!.id}$`),
  );
  expect(posts).toBe(1);
});

test("initialize only, inspect frozen sources, and save the first chapter with related updates in the same session", async ({
  page,
}) => {
  const libraryRequests: string[] = [];
  await page.getByRole("button", { name: "新建故事", exact: true }).click();
  page.on("request", (request) => {
    if (request.url().includes("/api/library"))
      libraryRequests.push(request.url());
  });
  f.mochi.intent = "initialize_only";
  const task = await send(page, "先建立雾海故事和设定，不写章节", true);
  const ctx = await context(task);
  const master = await new Library(f.store).create("character", {
    name: "守灯人",
    markdown: "旧母版中的完整人物经历。",
    genres: ["悬疑"],
    ageBand: "成年",
    sourceMetadata: {},
  });
  const source = await new LibraryTools(f.store).read(ctx, {
    asset_id: master.id,
    revision: master.revision,
  });
  const draft = await f.creative.initializeStory(
    ctx,
    {
      mode: "draft",
      title: "雾海",
      body: "一座孤岛",
      assets: [
        { kind: "setting", title: "海雾规则", body: "灯灭之后不可出门。" },
        {
          kind: "snapshot",
          source_id: master.id,
          source_version: source.version,
          source_hash: source.content_hash,
        },
      ],
    },
    randomUUID(),
  );
  await f.creative.initializeStory(
    ctx,
    { mode: "commit", ...ref(draft.data) },
    randomUUID(),
  );
  await finish(task);
  await expect(
    region(page, task).getByText("作品已建立", { exact: true }),
  ).toBeVisible();
  await expect(
    region(page, task).getByRole("button", { name: "打开章节", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("作品已建立，还没有章节。继续在这里创作第一章。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "新建创作会话", exact: true }),
  ).toBeVisible();
  expect(
    (await f.store.list({ projectId: task.storyId, kind: "chapter" })).items,
  ).toHaveLength(0);
  await page.getByRole("button", { name: "阅读草稿", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "本版本保存范围" }),
  ).toContainText("不保存章节");
  await page
    .getByText("新增 · 守灯人 · 角色／世界观快照", { exact: true })
    .click();
  await expect(
    page.getByText("旧母版中的完整人物经历。", { exact: true }),
  ).toBeVisible();
  await new Library(f.store).save(master.id, master.revision, {
    ...master.content,
    markdown: "后来改过的母版",
  });
  await page.reload();
  await page
    .getByText("新增 · 守灯人 · 角色／世界观快照", { exact: true })
    .click();
  await expect(
    page.getByText("旧母版中的完整人物经历。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("后来改过的母版", { exact: true })).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "← 返回创作会话", exact: true })
    .click();
  f.mochi.intent = "create_and_save";
  const next = await send(page, "修改海雾规则，再写第一章并保存");
  expect(next.conversationId).toBe(task.conversationId);
  const setting = (
    await f.store.list({ projectId: task.storyId, kind: "setting" })
  ).items[0]!;
  const nextCtx = await context(next);
  const firstChapter = await f.creative.initializeStory(
    nextCtx,
    {
      mode: "draft",
      title: "雾海",
      assets: [
        {
          kind: "setting",
          asset_id: setting.id,
          base_revision: setting.revision,
          title: "海雾规则",
          body: "灯灭之后，只有守灯人能出门。",
        },
      ],
      chapter: {
        title: "第一章 灯灭",
        body: "那一夜，海雾吞没了灯光。\n\n精确正文  \n",
      },
    },
    randomUUID(),
  );
  await f.creative.initializeStory(
    nextCtx,
    { mode: "commit", ...ref(firstChapter.data) },
    randomUUID(),
  );
  await finish(next);
  await expect(
    region(page, next).getByText("首章已保存", { exact: true }),
  ).toBeVisible();
  await expect(region(page, next)).toContainText(
    "正式章节第 1 版，保存结果已由后端确认。",
  );
  await expect(
    region(page, next).getByRole("region", { name: "本版本保存范围" }),
  ).toContainText("更新 · 海雾规则");
  await expect(page).toHaveURL(
    new RegExp(`#creative/conversation/${task.conversationId}$`),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/mwt018-mobile.png", fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(libraryRequests).toEqual([]);
  await region(page, next)
    .getByRole("button", { name: "打开章节", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "第一章 灯灭", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回创作会话", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`#creative/conversation/${task.conversationId}$`),
  );
});

test("rewritten initialization preview saves exactly the chosen package and keeps the receipt after model failure", async ({
  page,
}) => {
  const task = await first(
    page,
    "先给我一版作品和首章，再改一版，都先不要保存",
  );
  const ctx = await context(task);
  const original = await f.creative.initializeStory(
    ctx,
    {
      mode: "draft",
      title: "原来的故事",
      assets: [{ kind: "outline", title: "原大纲", body: "原来的走向" }],
      chapter: { title: "原首章", body: "选中的正文。\n\n末尾  \n" },
    },
    randomUUID(),
  );
  await f.creative.initializeStory(
    ctx,
    {
      mode: "draft",
      title: "后来改稿",
      assets: [],
      chapter: { title: "另一章", body: "不应保存的正文" },
    },
    randomUUID(),
  );
  await finish(task);
  await page
    .locator(".creative-draft-card")
    .filter({
      has: page.getByRole("heading", { name: "原来的故事", exact: true }),
    })
    .getByRole("button", { name: "阅读草稿", exact: true })
    .click();
  await expect(page.getByRole("article", { name: "首章草稿" })).toContainText(
    "选中的正文。",
  );
  await page.reload();
  await page.getByRole("button", { name: "选择此版本", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "本版本保存范围" }),
  ).toContainText("原大纲");
  f.mochi.intent = "save_current";
  const saving = await send(page, "就保存这个版本");
  expect(saving.selectedDraft).toEqual(ref(original.data));
  const saved = await f.creative.initializeStory(
    await context(saving),
    { mode: "commit", ...ref(original.data) },
    randomUUID(),
  );
  Object.assign(f.mochi.runs.get(saving.runId!)!, {
    status: "failed",
    error: { code: "synthetic", message: "保存后的模型异常" },
    result: null,
  });
  await expect(
    region(page, saving).getByText("首章已保存", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    region(page, saving).getByText("首章已保存", { exact: true }),
  ).toBeVisible();
  const receipt = saved.receipt as InitializationReceipt;
  expect(
    (await f.store.get(receipt.chapter!.chapter_id, task.storyId))!.content
      .markdown,
  ).toBe("选中的正文。\n\n末尾  \n");
  await region(page, saving)
    .getByRole("button", { name: "打开章节", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "原首章", exact: true }),
  ).toBeVisible();
});

test("a rejected first message remains editable instead of being trapped in unknown recovery", async ({
  page,
}) => {
  await page.getByRole("button", { name: "新建故事", exact: true }).click();
  const input = page.getByLabel("对故事说点什么", { exact: true });
  await input.fill("雾".repeat(12000));
  const response = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      /\/api\/creative\/conversations$/.test(r.url()),
  );
  await page.getByRole("button", { name: "发送", exact: true }).click();
  expect((await response).status()).toBe(400);
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("雾".repeat(12000));
  await expect(
    page.getByRole("button", { name: "查询原请求", exact: true }),
  ).toHaveCount(0);
  await input.fill("缩短后的想法");
  await send(page, "缩短后的想法", true);
});

test("an established zero-chapter project can explicitly switch to a new lifecycle session", async ({
  page,
}) => {
  f.mochi.intent = "initialize_only";
  const task = await first(page, "先建立雾海作品，不写正文");
  const ctx = await context(task);
  const draft = await f.creative.initializeStory(
    ctx,
    { mode: "draft", title: "雾海", assets: [] },
    randomUUID(),
  );
  await f.creative.initializeStory(
    ctx,
    { mode: "commit", ...ref(draft.data) },
    randomUUID(),
  );
  await finish(task);
  await expect(
    region(page, task).getByText("作品已建立", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "新建创作会话", exact: true }).click();
  await expect(page).not.toHaveURL(new RegExp(`${task.conversationId}$`));
  await expect(page).toHaveURL(/#creative\/conversation\/[\da-f-]+$/);
  await expect(
    page.getByText("作品已建立，还没有章节。继续在这里创作第一章。", {
      exact: true,
    }),
  ).toBeVisible();
  const conversations = await f.records.conversations(task.storyId);
  expect(conversations).toHaveLength(2);
  expect(conversations.every((c) => c.lifecycle)).toBe(true);
});

test("directly initializes without library assets and continues creating in the same saved session", async ({
  page,
}) => {
  f.mochi.intent = "create_and_save";
  const task = await first(page, "从零创作并保存第一章，不需要现有人物");
  const ctx = await context(task);
  const draft = await f.creative.initializeStory(
    ctx,
    {
      mode: "draft",
      title: "空岛",
      assets: [],
      chapter: { title: "第一章 脚步", body: "岛上响起了第一声脚步。" },
    },
    randomUUID(),
  );
  await f.creative.initializeStory(
    ctx,
    { mode: "commit", ...ref(draft.data) },
    randomUUID(),
  );
  await finish(task);
  await expect(
    region(page, task).getByText("首章已保存", { exact: true }),
  ).toBeVisible();
  await expect(
    region(page, task).getByRole("region", { name: "本版本保存范围" }),
  ).toContainText("0 项关联资料");
  f.mochi.intent = "draft";
  const next = await send(page, "继续写下一章给我看看，先不要保存");
  expect(next.conversationId).toBe(task.conversationId);
  expect((await context(next)).sessionId).toBe(ctx.sessionId);
  await f.creative.createChapter(
    await context(next),
    { mode: "draft", title: "第二章 回声", body: "脚步声在空岛回荡。" },
    randomUUID(),
  );
  await finish(next);
  await expect(
    page.getByRole("heading", { name: "第二章 回声", exact: true }),
  ).toBeVisible();
  expect(
    (await f.store.list({ projectId: task.storyId, kind: "chapter" })).items,
  ).toHaveLength(1);
  await page
    .locator(".creative-draft-card")
    .filter({
      has: page.getByRole("heading", { name: "第二章 回声", exact: true }),
    })
    .getByRole("button", { name: "阅读草稿", exact: true })
    .click();
  await expect(
    page.getByText("脚步声在空岛回荡。", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "← 返回创作会话", exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`#creative/conversation/${task.conversationId}$`),
  );
});
