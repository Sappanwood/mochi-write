import { test, expect, type Page } from "@playwright/test";
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
  await expect(
    page.getByRole("region", { name: "信息正文", exact: true }),
  ).toContainText(d.payload.content.markdown);
}
async function selectParagraph(page: Page) {
  const paragraph = page.locator(".free-reading .markdown p").first();
  await paragraph.click();
  await paragraph.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

test("explicit whole-draft feedback preserves input, pins old version and focuses composer", async ({
  page,
}) => {
  const task = await send(page, "构思角色");
  const first = await draft(task, "守灯人", "旧稿中的灯塔段落。");
  const second = await draft(task, "守灯人", "新稿中的海岸段落。", first);
  await finish(task);
  await show(page, first);
  await page.getByLabel("下一条消息").fill("保留这条改稿要求");
  await expect(page.getByRole("button", { name: /删除引用/ })).toHaveCount(0);
  await page
    .getByRole("button", { name: "针对这一稿提意见", exact: true })
    .click();
  await expect(page.getByLabel("下一条消息")).toHaveValue("保留这条改稿要求");
  await expect(page.getByLabel("下一条消息")).toBeFocused();
  await page.getByLabel("版本", { exact: true }).selectOption(second.id);
  const feedback = await send(page, "请让人物更果断");
  expect(feedback.input.refs).toEqual([f.free.candidates.ref(first)]);
  expect(feedback.binding).toBeUndefined();
});

test("selection feedback appends editable quote and only explicitly attaches the displayed draft", async ({
  page,
}) => {
  const task = await send(page, "构思角色");
  const first = await draft(
    task,
    "守灯人",
    [
      "灯塔下的人迟迟没有回头。",
      ...Array.from(
        { length: 24 },
        (_, i) => `第 ${i + 2} 段：海上的风卷过台阶，远处的灯影晃动。`,
      ),
    ].join("\n\n"),
  );
  await finish(task);
  await show(page, first);
  await page.getByLabel("下一条消息").fill("让行动更具体。");
  await selectParagraph(page);
  const button = page.getByRole("button", {
    name: "针对选中段落提意见",
    exact: true,
  });
  await expect(button).toBeEnabled();
  await expect(page.getByRole("button", { name: /删除引用/ })).toHaveCount(0);
  await button.click();
  await expect(page.getByLabel("下一条消息")).toHaveValue(
    /让行动更具体。[\s\S]*> 灯塔下的人迟迟没有回头。/,
  );
  await expect(page.getByLabel("下一条消息")).toBeFocused();
  await expect(page.locator(".free-composer-references")).toContainText(
    "守灯人 · 第 1 稿",
  );
  await page.screenshot({ path: "/tmp/mochi-write-feedback-desktop.png" });
  const text = await page.getByLabel("下一条消息").inputValue();
  const feedback = await send(page, text);
  expect(feedback.input.refs).toEqual([f.free.candidates.ref(first)]);
  expect(feedback.input.message).toContain("> 灯塔下的人迟迟没有回头。");
  expect(feedback.binding).toBeUndefined();
});

test("switching versions drops the previous selection and unavailable drafts disable feedback", async ({
  page,
}) => {
  const task = await send(page, "构思角色");
  const first = await draft(task, "守灯人", "旧稿的选区不可串到新稿。");
  const second = await draft(task, "守灯人", "新稿正文。", first);
  await finish(task);
  await show(page, first);
  await selectParagraph(page);
  const selected = page.getByRole("button", {
    name: "针对选中段落提意见",
    exact: true,
  });
  await expect(selected).toBeEnabled();
  await page.getByLabel("版本", { exact: true }).selectOption(second.id);
  await expect(page.getByRole("region", { name: "信息正文" })).toContainText(
    "新稿正文。",
  );
  await expect(selected).toBeDisabled();
  await expect(page.getByRole("button", { name: /删除引用/ })).toHaveCount(0);
  await page.route(`**/drafts/${first.id}`, (route) =>
    route.fulfill({ status: 404, json: { error: "reference_unavailable" } }),
  );
  await page.getByLabel("版本", { exact: true }).selectOption(first.id);
  await expect(
    page.getByRole("region", { name: "信息正文" }).getByRole("alert"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "针对这一稿提意见", exact: true }),
  ).toBeDisabled();
  await expect(selected).toBeDisabled();
});

test("reference limit rejects an entire feedback action and accepts an already attached draft", async ({
  page,
}) => {
  const task = await send(page, "构思角色");
  const references = [];
  for (let index = 0; index < 8; index++) {
    const other = await draft(
      task,
      `其他资料 ${index}`,
      `第 ${index} 份资料正文`,
    );
    references.push({
      ref: f.free.candidates.ref(other),
      title: other.title,
      recorded: true,
    });
  }
  await finish(task);
  const next = await send(page, "再构思一个角色");
  const first = await draft(next, "守灯人", "不能丢失的正文。");
  await finish(next);
  await show(page, first);
  await page.evaluate(
    ({ key, references }) => {
      const state = JSON.parse(sessionStorage.getItem(key)!);
      state.composer = {
        message: "已有输入",
        refs: references,
      };
      sessionStorage.setItem(key, JSON.stringify(state));
    },
    {
      key: `mochi-free:${task.conversationId}`,
      references,
    },
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("草稿", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "信息正文" })).toContainText(
    "不能丢失的正文。",
  );
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByLabel("草稿", { exact: true }).locator("option"),
  ).toHaveCount(9);
  await selectParagraph(page);
  await page
    .getByRole("button", { name: "针对选中段落提意见", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("每条消息最多引用 8 项");
  await expect(page.getByLabel("下一条消息")).toHaveValue("已有输入");
  await expect(page.getByRole("button", { name: /删除引用/ })).toHaveCount(8);
  await page
    .getByRole("button", { name: "删除引用 其他资料 0", exact: true })
    .click();
  await page
    .getByRole("button", { name: "针对这一稿提意见", exact: true })
    .click();
  await expect(page.getByLabel("下一条消息")).toBeFocused();
  await expect(page.getByRole("button", { name: /删除引用/ })).toHaveCount(8);
  await selectParagraph(page);
  await page
    .getByRole("button", { name: "针对选中段落提意见", exact: true })
    .click();
  await expect(page.getByLabel("下一条消息")).toHaveValue(
    /已有输入[\s\S]*> 不能丢失的正文。/,
  );
  await expect(page.getByRole("button", { name: /删除引用/ })).toHaveCount(8);
});

test("recorded references use the loaded work title and matching draft cards show distinct groups", async ({
  page,
}) => {
  const task = await send(page, "构思同名角色");
  const first = await draft(task, "守灯人", "第一组正文");
  const second = await draft(task, "守灯人", "第二组正文");
  await finish(task);
  await show(page, first);
  await page.evaluate(
    ({ key, title }) => {
      const state = JSON.parse(sessionStorage.getItem(key)!);
      state.reading.current.title = title;
      sessionStorage.setItem(key, JSON.stringify(state));
    },
    {
      key: `mochi-free:${task.conversationId}`,
      title: `候选 · 组 ${first.groupId} · ${first.id}`,
    },
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("草稿", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "信息正文" })).toContainText(
    "第一组正文",
  );
  await expect(page.locator(".free-pane-heading h2")).toHaveText(
    "守灯人 · 第 1 稿",
  );
  for (const candidate of [first, second]) {
    const button = page.getByRole("button", {
      name: `查看：${candidate.title} · 第 ${candidate.ordinal} 稿 · 组 ${candidate.groupId.slice(0, 8)}`,
      exact: true,
    });
    await expect(button.locator("..")).toContainText(
      candidate.groupId.slice(0, 8),
    );
  }
});
