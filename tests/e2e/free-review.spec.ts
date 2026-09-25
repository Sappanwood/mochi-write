import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  assetReference,
  materialResolve,
  materialDraft,
  materialRequests,
} from "../support/free-materials.js";
import { worldContent } from "../support/free-world.js";
import { entity } from "../../src/server/entities.js";
import { freeFixture } from "./free-fixture.js";
import type { FreeTask } from "../../src/shared/free.js";
import type { Candidate } from "../../src/shared/free-candidates.js";
let browserErrors: string[] = [];
let f: Awaited<ReturnType<typeof freeFixture>>;
test.beforeEach(async ({ page }) => {
  browserErrors = [];
  page.on("pageerror", (e) => browserErrors.push(e.message));
  f = await freeFixture();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${f.address}/#free/new`);
  await page.getByRole("button", { name: "使用 Microsoft 账号登录" }).click();
  await expect(
    page.getByRole("heading", { name: "今天想写点什么？" }),
  ).toBeVisible();
});
test.afterEach(async () => {
  await f?.close();
  expect(browserErrors).toEqual([]);
});
async function send(page: Page, text: string) {
  await page.getByLabel("下一条消息", { exact: true }).fill(text);
  const response = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      /\/creative\/free\/conversations(?:\/[^/]+\/tasks)?$/.test(r.url()),
  );
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const { task } = await (await response).json();
  await expect
    .poll(async () => (await f.free.task(task.id)).executionRun?.runId)
    .toBeTruthy();
  return f.free.task(task.id);
}
async function draft(
  task: FreeTask,
  name: string,
  markdown: string,
  parent?: Candidate,
) {
  const result = await f.invoke(task, "save_character", {
    mode: "draft",
    name,
    markdown,
    genres: [],
    age_band: "",
    ...(parent
      ? { group_id: parent.groupId, parent_ref: f.free.candidates.ref(parent) }
      : {}),
  });
  return f.free.candidates.get(
    task.conversationId,
    (result.data as { draft_id: string }).draft_id,
  );
}
async function finish(task: FreeTask) {
  f.mochi.finish(task.executionRun!.runId!);
  await expect
    .poll(async () => (await f.free.task(task.id)).state)
    .toBe("succeeded");
}
async function show(page: Page, d: Candidate) {
  await page
    .getByRole("button", {
      name: `查看：${d.title} · 第 ${d.ordinal} 稿 · 组 ${d.groupId.slice(0, 8)}`,
      exact: true,
    })
    .last()
    .click();
  await expect(page.getByLabel("版本", { exact: true })).toHaveValue(d.id);
}
test("preparing an exact old draft save preserves input and assets without submitting, then sends that version", async ({
  page,
}) => {
  await f.store.commit(
    entity("world", {
      name: "背景资料",
      markdown: "正式背景正文",
      genres: [],
      ageBand: "",
      sourceMetadata: {},
    }),
    null,
  );
  const task = await send(page, "构思角色");
  const first = await draft(task, "守灯人", "必须保存的第一稿正文");
  await draft(task, "守灯人", "不能替代第一稿的新正文", first);
  await finish(task);
  await show(page, first);
  await page.getByLabel("下一条消息").fill("@背景资料");
  await page.getByLabel("引用补全").getByRole("button").click();
  await expect(page.getByRole("button", { name: /删除引用/ })).toHaveCount(1);
  await page.getByLabel("下一条消息").fill("保留我的备注。");
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.url());
  });
  await page.getByRole("button", { name: "准备保存此稿", exact: true }).click();
  const prepared = await page.getByLabel("下一条消息").inputValue();
  expect(prepared).toContain("保留我的备注。");
  expect(prepared).toContain("原样保存");
  expect(prepared).toContain("守灯人 · 第 1 稿");
  await expect(page.getByLabel("下一条消息")).toBeFocused();
  await expect(page.getByRole("button", { name: /删除引用/ })).toHaveCount(2);
  await page.getByRole("button", { name: "准备保存此稿", exact: true }).click();
  await expect(page.getByLabel("下一条消息")).toHaveValue(prepared);
  expect(posts).toEqual([]);
  await page.screenshot({ path: "/tmp/mochi-write-save-preparation.png" });
  f.mochi.freeIntent = "save_current";
  const saving = await send(page, prepared);
  expect(saving.binding?.selectedDraft).toEqual(f.free.candidates.ref(first));
  expect(saving.input.refs).toHaveLength(2);
  await f.invoke(saving, "save_character", {
    mode: "commit",
    draft_id: first.id,
    draft_revision: "1",
    draft_hash: first.draftHash,
  });
  f.mochi.finish(saving.executionRun!.runId!);
  await expect(page.locator(".free-draft-status")).toContainText("已保存");
  await expect(page.locator(".free-draft-status")).not.toContainText("未保存");
  await expect(
    page.getByRole("button", { name: "准备保存此稿", exact: true }),
  ).toHaveCount(0);
});

test("draft reading keeps metadata behind one details entry on desktop and mobile", async ({
  page,
}) => {
  const task = await send(page, "构思角色");
  const result = await f.invoke(task, "save_character", {
    mode: "draft",
    name: "守灯人",
    markdown: "海风吹过灯塔。\n\n他合上手中的书。",
    genres: [],
    age_band: "",
    occupation: "守塔人",
  });
  const candidate = await f.free.candidates.get(
    task.conversationId,
    (result.data as { draft_id: string }).draft_id,
  );
  await finish(task);
  await show(page, candidate);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 390)
      await page.getByRole("tab", { name: "信息", exact: true }).click();
    const body = page.getByRole("region", { name: "信息正文", exact: true });
    await expect(
      body.getByText("海风吹过灯塔。", { exact: true }),
    ).toBeVisible();
    await expect(body.locator(".metadata, .tags, .free-identity")).toHaveCount(
      0,
    );
    await expect(page.locator(".free-info-heading > details")).toHaveCount(1);
    const details = page.locator(".free-reading-details");
    await expect(details).not.toHaveAttribute("open");
    await details.getByText("稿件详情", { exact: true }).click();
    await expect(details).toContainText("基础版本");
    await expect(details).toContainText("守塔人");
    await details.getByText("稿件详情", { exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/mochi-write-clean-reading-${width}.png`,
    });
  }
});

test("save preparation rejects other candidate references without changing the message", async ({
  page,
}) => {
  const task = await send(page, "构思两个角色");
  const first = await draft(task, "守灯人", "甲正文");
  const other = await draft(task, "渡船人", "乙正文");
  await finish(task);
  await show(page, other);
  await page.getByRole("button", { name: "引用到对话", exact: true }).click();
  await show(page, first);
  await page.getByLabel("下一条消息").fill("先看看，不保存");
  await page.getByRole("button", { name: "准备保存此稿", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("请先移除其他草稿引用");
  await expect(page.getByLabel("下一条消息")).toHaveValue("先看看，不保存");
  await expect(page.getByRole("button", { name: /删除引用/ })).toHaveCount(1);
  await expect(page.locator(".free-composer-references")).toContainText(
    "渡船人",
  );
});

test("same-group comparison reads both exact versions and closes without changing reading or composer", async ({
  page,
}) => {
  const task = await send(page, "构思角色");
  const body = Array.from(
    { length: 40 },
    (_, i) => `第${i}段：旧稿人物仍守在灯塔。`,
  ).join("\n\n");
  const first = await draft(task, "守灯人", body);
  const second = await draft(task, "守灯人", "第二稿人物已经离开海岸。", first);
  await draft(task, "另一组", "其他组不参与当前对照");
  await finish(task);
  await show(page, first);
  await page.getByLabel("下一条消息").fill("保留未发送反馈");
  const reading = page.getByRole("region", { name: "信息正文", exact: true });
  await reading.evaluate((element) => {
    element.scrollTop = 180;
  });
  await page.getByRole("button", { name: "并排对照", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "稿件版本对照" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("左侧版本").locator("option")).toHaveCount(2);
  await expect(dialog.getByRole("region", { name: "左侧稿件" })).toContainText(
    "旧稿人物仍守在灯塔",
  );
  await expect(dialog.getByRole("region", { name: "右侧稿件" })).toContainText(
    "第二稿人物已经离开海岸",
  );
  await page.screenshot({ path: "/tmp/mochi-write-comparison-desktop.png" });
  await dialog.getByLabel("左侧版本").selectOption(second.id);
  await expect(dialog.getByRole("region", { name: "左侧稿件" })).toContainText(
    "第二稿人物已经离开海岸",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("版本", { exact: true })).toHaveValue(first.id);
  await expect
    .poll(() => reading.evaluate((element) => element.scrollTop))
    .toBe(180);
  await expect(page.getByLabel("下一条消息")).toHaveValue("保留未发送反馈");
  await expect(page.getByRole("button", { name: /删除引用/ })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "并排对照", exact: true }),
  ).toBeFocused();
  await page.route(`**/drafts/${second.id}`, (route) =>
    route.fulfill({ status: 404, json: { error: "reference_unavailable" } }),
  );
  await page.getByRole("button", { name: "并排对照", exact: true }).click();
  await expect(
    dialog.getByRole("region", { name: "右侧稿件" }).getByRole("alert"),
  ).toBeVisible();
  await expect(
    dialog.getByRole("region", { name: "右侧稿件" }),
  ).not.toContainText("旧稿人物仍守在灯塔");
  await dialog.getByRole("button", { name: "关闭对照", exact: true }).click();
});

test("save preparation respects the eight-reference limit and unknown original save results", async ({
  page,
}) => {
  const task = await send(page, "构思角色");
  const first = await draft(task, "守灯人", "安全保留的草稿");
  await finish(task);
  await show(page, first);
  const refs = [];
  for (let index = 0; index < 8; index++) {
    const asset = await f.store.commit(
      entity("world", worldContent(`背景 ${index}`)),
      null,
    );
    refs.push({
      ref: assetReference(asset),
      title: asset.content.name,
      recorded: false,
    });
  }
  await page.evaluate(
    ({ key, refs }) => {
      const state = JSON.parse(sessionStorage.getItem(key)!);
      state.composer = { message: "保留原来的想法", refs };
      sessionStorage.setItem(key, JSON.stringify(state));
    },
    { key: `mochi-free:${task.conversationId}`, refs },
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "准备保存此稿", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "准备保存此稿", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("最多引用 8 项");
  await expect(page.getByLabel("下一条消息")).toHaveValue("保留原来的想法");
  await expect(page.getByRole("button", { name: /删除引用/ })).toHaveCount(8);
  await page.route(`**/drafts/${first.id}`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        claim: {
          operationId: "unknown-original-operation",
          status: "verifying",
        },
      },
    });
  });
  await page.reload();
  await expect(page.getByText("保存结果待核实", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "准备保存此稿", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("下一条消息")).toHaveValue("保留原来的想法");
});

test("initialization comparison expands both complete packages at desktop and mobile widths", async ({
  page,
}) => {
  f.mochi.targetKind = "story";
  const task = await send(page, "构思一个新故事和首章");
  const versions: Candidate[] = [];
  for (const name of ["旧", "新"]) {
    const result = await f.invoke(task, "initialize_story", {
      mode: "draft",
      title: "灯塔故事",
      assets: [
        { kind: "snapshot", title: "守灯人", body: `${name}版人物完整正文` },
        { kind: "setting", title: "海岸设定", body: `${name}版设定完整正文` },
      ],
      chapter: { title: "第一章", body: `${name}版首章完整正文` },
      ...(versions.length
        ? {
            group_id: versions[0]!.groupId,
            parent_ref: f.free.candidates.ref(versions[0]!),
          }
        : {}),
    });
    versions.push(
      await f.free.candidates.get(
        task.conversationId,
        (result.data as { draft_id: string }).draft_id,
      ),
    );
  }
  await finish(task);
  await show(page, versions[0]!);
  await page.getByRole("button", { name: "准备保存此稿", exact: true }).click();
  await expect(page.getByLabel("下一条消息")).toHaveValue(
    /守灯人[\s\S]*海岸设定[\s\S]*第一章/,
  );
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 390)
      await page.getByRole("tab", { name: "信息", exact: true }).click();
    await page.getByRole("button", { name: "并排对照", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "稿件版本对照" });
    for (const [side, name] of [
      ["左侧", "旧"],
      ["右侧", "新"],
    ]) {
      const column = dialog.getByRole("region", { name: `${side}稿件` });
      await expect(
        column.getByRole("heading", { name: "本版本保存范围" }),
      ).toHaveCount(0);
      for (const field of ["人物", "设定", "首章"]) {
        const content = column.getByText(`${name}版${field}完整正文`, {
          exact: true,
        });
        await expect(content).toHaveCount(1);
        await expect(content).toBeVisible();
      }
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (width === 390)
      await page.screenshot({ path: "/tmp/mochi-write-comparison-mobile.png" });
    await dialog.getByRole("button", { name: "关闭对照", exact: true }).click();
  }
});

test("material comparison includes every member and preserves each frozen baseline", async ({
  page,
}) => {
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
  const { task, conversation } = await f.free.start({
    clientRequestId: randomUUID(),
    message: "为灯塔新增角色快照，更新林舟、设定和大纲，仅预览",
    provider: "deepseek",
    model: "test",
    refs: [assetReference(story)],
  });
  const resolved = await materialResolve(f.free, task);
  const first = await materialDraft(f.free, resolved, {
    members: materialRequests().map((member) => ({
      key: member.key,
      name: member.name ?? member.key,
      markdown: `旧版 ${member.key} 资料全文`,
    })),
  });
  const next = await f.free.submit(conversation.id, {
    clientRequestId: randomUUID(),
    message: "改写这份资料，只预览",
    provider: "deepseek",
    model: "test",
    refs: [f.free.candidates.ref(first)],
  });
  const feedback = await materialResolve(f.free, next, []);
  await materialDraft(f.free, feedback, {
    group_id: first.groupId,
    parent_ref: f.free.candidates.ref(first),
    members: materialRequests().map((member) => ({
      key: member.key,
      name: member.name ?? member.key,
      markdown: `新版 ${member.key} 资料全文`,
    })),
  });
  await f.free.cancel(feedback.id);
  await page.goto(`${f.address}/#free/conversation/${conversation.id}`);
  await show(page, first);
  await page.getByRole("button", { name: "并排对照", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "稿件版本对照" });
  for (const [side, version] of [
    ["左侧", "旧版"],
    ["右侧", "新版"],
  ]) {
    const column = dialog.getByRole("region", { name: `${side}稿件` });
    for (const member of materialRequests())
      await expect(
        column.getByText(`${version} ${member.key} 资料全文`, { exact: true }),
      ).toBeVisible();
    await expect(column).toContainText("更新 · 基于 v1");
    await expect(column).toContainText("新增 · 无基础版本");
  }
});

for (const kind of ["world", "chapter"] as const)
  test(`${kind} versions compare their full content`, async ({ page }) => {
    f.mochi.targetKind = kind === "world" ? "world" : "story";
    if (kind === "chapter") {
      f.mochi.targetMode = "explicit";
      const id = randomUUID();
      await f.store.commit(
        {
          ...entity("story", worldContent("章节故事"), id, id),
          status: "ready",
        },
        null,
      );
      await f.store.commit(entity("chapter", worldContent("首章"), id), null);
      await page.getByLabel("下一条消息").fill("@章节故事");
      await page.getByLabel("引用补全").getByRole("button").click();
      await expect(page.getByRole("button", { name: /删除引用/ })).toHaveCount(
        1,
      );
    }
    const task = await send(
      page,
      kind === "world" ? "构思世界观" : "续写下一章，只预览",
    );
    const versions: Candidate[] = [];
    for (const version of ["旧", "新"]) {
      const result = await f.invoke(
        task,
        kind === "world" ? "save_world" : "create_chapter",
        {
          mode: "draft",
          ...(kind === "world"
            ? {
                name: "雾海世界",
                markdown: `${version}版世界观完整正文`,
                genres: [],
              }
            : { title: "第二章", body: `${version}版章节完整正文` }),
          ...(versions.length
            ? {
                group_id: versions[0]!.groupId,
                parent_ref: f.free.candidates.ref(versions[0]!),
              }
            : {}),
        },
      );
      versions.push(
        await f.free.candidates.get(
          task.conversationId,
          (result.data as { draft_id: string }).draft_id,
        ),
      );
    }
    await finish(task);
    await show(page, versions[0]!);
    await page.getByRole("button", { name: "并排对照", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "稿件版本对照" });
    await expect(
      dialog.getByRole("region", { name: "左侧稿件" }),
    ).toContainText(`旧版${kind === "world" ? "世界观" : "章节"}完整正文`);
    await expect(
      dialog.getByRole("region", { name: "右侧稿件" }),
    ).toContainText(`新版${kind === "world" ? "世界观" : "章节"}完整正文`);
  });
