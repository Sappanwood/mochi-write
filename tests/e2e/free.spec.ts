import { test, expect, type Page } from "@playwright/test";
import { freeFixture } from "./free-fixture.js";
import { entity, clean } from "../../src/server/entities.js";
import type { FreeTask } from "../../src/shared/free.js";
import type { Candidate } from "../../src/shared/free-candidates.js";
let browserErrors: string[] = [];
let f: Awaited<ReturnType<typeof freeFixture>>;
test.beforeEach(async ({ page }) => {
  browserErrors = [];
  page.on("pageerror", (e) => browserErrors.push(e.message));
  f = await freeFixture();
  await page.goto(`${f.address}/#free/new`);
  await page.getByRole("button", { name: "使用 Microsoft 账号登录" }).click();
  await expect(
    page.getByRole("heading", { name: "从一个想法继续" }),
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
const body = Array.from(
  { length: 55 },
  (_, i) => `第 ${i + 1} 段，旧稿甲保留独立人物设定。`,
).join("\n\n");
test("desktop groups, @ disambiguation, browsing and new drafts keep independent exact references", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const t = await send(page, "构思两个同名角色");
  const a = await draft(t, "林岚", body),
    b = await draft(t, "林岚", "乙1记者正文");
  await finish(t);
  await show(page, a);
  await page.getByRole("button", { name: "引用到对话", exact: true }).click();
  await page.getByLabel("下一条消息").fill("未发送反馈");
  await page.getByLabel("成果组", { exact: true }).selectOption(b.groupId);
  await expect(page.getByRole("region", { name: "信息正文" })).toContainText(
    "乙1记者正文",
  );
  await page
    .getByRole("button", { name: "打开 explorer", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "explorer · 资产与候选" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回详情", exact: true }).click();
  await expect(page.getByLabel("下一条消息")).toHaveValue("未发送反馈");
  await expect(
    page.getByRole("button", { name: "删除引用 林岚 · 第 1 稿", exact: true }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "删除引用 林岚 · 第 1 稿", exact: true })
    .click();
  await page.getByLabel("下一条消息").fill("@林岚");
  const completions = page.getByLabel("引用补全");
  await expect(completions.getByRole("button")).toHaveCount(2);
  await expect(completions).toContainText(a.groupId.slice(0, 8));
  await expect(completions).toContainText(b.groupId.slice(0, 8));
  await page.getByLabel("下一条消息").press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /删除引用/ })).toHaveCount(1);
  await page.getByRole("button", { name: /删除引用/ }).click();
  await page.getByLabel("下一条消息").fill("@林岚");
  await completions
    .getByRole("button")
    .filter({ hasText: a.groupId.slice(0, 8) })
    .click();
  const next = await send(page, "修改甲旧稿的节奏");
  expect(next.input.refs).toEqual([f.free.candidates.ref(a)]);
  await page.getByLabel("下一条消息").fill("下一轮保留");
  await page.getByRole("button", { name: "引用到对话", exact: true }).click();
  const a2 = await draft(next, "林岚", "甲2新稿", a);
  await finish(next);
  await expect(page.getByRole("region", { name: "信息正文" })).toContainText(
    "乙1记者正文",
  );
  await expect(page.getByLabel("下一条消息")).toHaveValue("下一轮保留");
  await expect(page.getByRole("button", { name: /删除引用/ })).toHaveCount(1);
  await page.getByLabel("成果组").selectOption(a.groupId);
  await page.getByLabel("组内版本").selectOption(a.id);
  await expect(page.getByRole("region", { name: "信息正文" })).toContainText(
    "旧稿甲",
  );
  expect(a2.ordinal).toBe(2);
  const left = await page
      .getByRole("region", { name: "讨论内容" })
      .boundingBox(),
    right = await page.getByRole("region", { name: "当前信息" }).boundingBox();
  expect(right!.x).toBeGreaterThan(left!.x + left!.width);
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "/tmp/mwt029-desktop.png" });
  await page.getByRole("button", { name: /删除引用/ }).click();
  await page.getByRole("button", { name: "引用到对话", exact: true }).click();
  f.mochi.freeIntent = "save_current";
  const saving = await send(page, "保存甲的第一稿为独立母版");
  expect(saving.input.refs).toEqual([f.free.candidates.ref(a)]);
  const target = saving.binding!.target;
  await page.getByLabel("成果组").selectOption(b.groupId);
  await expect(page.getByRole("region", { name: "信息正文" })).toContainText(
    "乙1记者正文",
  );
  expect((await f.free.task(saving.id)).binding!.target).toEqual(target);
  const saved = await f.invoke(saving, "save_character", {
    mode: "commit",
    draft_id: a.id,
    draft_revision: "1",
    draft_hash: a.draftHash,
  });
  f.mochi.finish(saving.executionRun!.runId!);
  await expect(
    page.getByText("独立角色母版已新建", { exact: true }),
  ).toBeVisible();
  expect(saved.receipt).toMatchObject({ draft_id: a.id, target });
  expect([...f.store.heads.values()][0]!.content.markdown).toBe(body);
  await page.screenshot({ path: "/tmp/mwt029-old-draft-saved.png" });
});
test("390px and refresh preserve reading, unsent input and references", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const t = await send(page, "构思角色");
  const a = await draft(t, "甲", body);
  await finish(t);
  await show(page, a);
  const reading = page.getByRole("region", { name: "信息正文" });
  await reading.evaluate((e) => {
    e.scrollTop = 300;
  });
  await page.getByRole("button", { name: "引用到对话", exact: true }).click();
  await page.getByRole("tab", { name: "讨论", exact: true }).click();
  await page.getByLabel("下一条消息").fill("手机保留反馈");
  await page.getByRole("tab", { name: "信息", exact: true }).click();
  expect(await reading.evaluate((e) => e.scrollTop)).toBe(300);
  await page.reload();
  await expect(reading).toContainText("旧稿甲");
  await expect.poll(() => reading.evaluate((e) => e.scrollTop)).toBe(300);
  await page.getByRole("tab", { name: "讨论", exact: true }).click();
  await expect(page.getByLabel("下一条消息")).toHaveValue("手机保留反馈");
  await expect(page.getByRole("button", { name: /删除引用/ })).toHaveCount(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "/tmp/mwt029-mobile.png" });
});
test("exact old autonomous sources survive updates/deletion and never substitute unavailable history", async ({
  page,
}) => {
  const doc = await f.store.commit(
    entity("character", {
      name: "来源",
      markdown: "精确旧来源正文",
      genres: [],
      ageBand: "",
      sourceMetadata: {},
    }),
    null,
  );
  f.mochi.freeIntent = "discuss";
  const t = await send(page, "讨论并自主取材");
  await f.free.references.agentRead(
    await f.free.conversation(t.conversationId),
    t.id,
    { asset_id: doc.id, revision: doc.revision },
    "source-read",
  );
  await finish(t);
  const newer = await f.store.commit(
    {
      ...clean(doc),
      currentVersion: 2,
      content: { ...doc.content, markdown: "不应显示的新正文" },
    },
    doc.revision,
  );
  await f.store.commit(
    { ...clean(newer), currentVersion: 3, deleted: true },
    newer.revision,
  );
  await page.getByText("本轮参考资料 · 1", { exact: true }).click();
  await expect(
    page.getByText("Agent 自主实际读取", { exact: true }),
  ).toBeVisible();
  const source = page.locator(".creative-sources").getByRole("button");
  await source.click();
  await expect(page.getByRole("region", { name: "信息正文" })).toContainText(
    "精确旧来源正文",
  );
  await expect(page.getByRole("region", { name: "当前信息" })).toContainText(
    "当前版本 v3",
  );
  await expect(page.getByRole("region", { name: "当前信息" })).toContainText(
    "当前资产已删除",
  );
  await expect(page.getByRole("button", { name: /删除引用/ })).toHaveCount(0);
  f.store.history.delete(doc.id + ":1");
  await source.click();
  await expect(page.getByRole("region", { name: "信息正文" })).toContainText(
    "原版本不可取得",
  );
  await expect(
    page.getByRole("button", { name: "引用到对话", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("region", { name: "信息正文" }),
  ).not.toContainText("不应显示的新正文");
  await page.screenshot({ path: "/tmp/mwt029-source-unavailable.png" });
});
test("public verify reconciles the original committed OP and remote terminal status with personal isolation", async ({
  page,
}) => {
  f.mochi.targetKind = "story";
  const t = await send(page, "构思故事");
  const d = await f.invoke(t, "initialize_story", {
    mode: "draft",
    title: "核实故事",
    assets: [],
    chapter: { title: "首章", body: "准确正文" },
  });
  const candidate = await f.free.candidates.get(
    t.conversationId,
    (d.data as { draft_id: string }).draft_id,
  );
  await finish(t);
  await show(page, candidate);
  await page.getByRole("button", { name: "引用到对话", exact: true }).click();
  f.mochi.freeIntent = "save_current";
  const saving = await send(page, "保存这个版本");
  await f.free.close();
  const saved = await f.invoke(saving, "initialize_story", {
    mode: "commit",
    draft_id: candidate.id,
    draft_revision: "1",
    draft_hash: candidate.draftHash,
  });
  expect(saved.receipt).toBeTruthy();
  await f.free.change(saving.id, (t) => {
    t.receipt = undefined;
    t.state = "verifying";
  });
  f.mochi.finish(saving.executionRun!.runId!);
  const base = `${f.address}/api/creative/free/conversations/${t.conversationId}/tasks/${saving.id}`;
  const headers = {
    authorization: `Bearer ${f.token}`,
    origin: f.address,
    "content-type": "application/json",
  };
  const before = await fetch(base, { headers });
  expect((await before.json()).task.state).toBe("verifying");
  expect((await f.free.task(saving.id)).executionRun?.status).toBe("running");
  const other = await fetch(base + "/verify", {
    method: "POST",
    headers: { ...headers, authorization: `Bearer ${f.otherToken}` },
    body: "{}",
  });
  expect(other.status).toBe(401);
  await page.getByLabel("下一条消息").fill("下一轮保留请求");
  const posts = f.mochi.calls.filter(
    (c) => c.body && c.path.endsWith("/runs"),
  ).length;
  const writes = f.store.heads.size;
  const verify = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url() === base + "/verify",
  );
  await page
    .getByRole("button", { name: "核实原任务与保存结果", exact: true })
    .last()
    .click();
  expect((await verify).status()).toBe(200);
  await expect(
    page.getByText("作品与首章已保存", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("下一条消息")).toHaveValue("下一轮保留请求");
  expect((await f.free.task(saving.id)).receipt).toEqual(saved.receipt);
  expect((await f.free.task(saving.id)).executionRun?.status).toBe("succeeded");
  expect(
    f.mochi.calls.filter((c) => c.body && c.path.endsWith("/runs")).length,
  ).toBe(posts);
  expect(f.store.heads.size).toBe(writes);
  await page.screenshot({ path: "/tmp/mwt029-public-verify.png" });
  await page.getByRole("button", { name: "打开正式内容", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(
      `/chapter/${(await f.free.task(saving.id)).receipt!.chapter!.chapter_id}$`,
    ),
  );
  await expect(
    page.getByRole("heading", { name: "首章", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("准确正文", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "返回原自由会话", exact: true }).click();
  await expect(page.getByLabel("下一条消息")).toHaveValue("下一轮保留请求");
});

test("one session moves from unsaved role to story and back to an independently saved master", async ({
  page,
}) => {
  const t = await send(page, "构思独立角色");
  const a = await draft(t, "守灯人", "稳定属性：耐心");
  await finish(t);
  const session = (await f.free.conversation(t.conversationId)).sessionId;
  await show(page, a);
  await page.getByRole("button", { name: "引用到对话", exact: true }).click();
  f.mochi.targetKind = "story";
  const storyTask = await send(page, "用这位角色构思一个新故事");
  expect(storyTask.input.refs).toEqual([f.free.candidates.ref(a)]);
  const packResult = await f.invoke(storyTask, "initialize_story", {
    mode: "draft",
    title: "灯塔故事",
    assets: [{ kind: "snapshot", candidate_ref: f.free.candidates.ref(a) }],
    chapter: { title: "第一章", body: "剧情，角色收到来信" },
  });
  const pack = await f.free.candidates.get(
    t.conversationId,
    (packResult.data as { draft_id: string }).draft_id,
  );
  await finish(storyTask);
  await show(page, pack);
  await expect(page.getByRole("article", { name: "首章草稿" })).toContainText(
    "剧情，角色收到来信",
  );
  await page
    .getByRole("region", { name: "信息正文" })
    .getByText("快照 · 守灯人", { exact: true })
    .click();
  await page
    .getByRole("button", { name: "引用成员：守灯人", exact: true })
    .click();
  f.mochi.targetKind = "character";
  const reverse = await send(page, "从这个故事人物发展独立角色母版");
  const source = {
    ...f.free.candidates.ref(pack),
    member_id: pack.payload.members![0]!.member_id,
  };
  expect(reverse.input.refs).toEqual([source]);
  const masterResult = await f.invoke(reverse, "save_character", {
    mode: "draft",
    name: "独立守灯人",
    markdown: "独立完整人物。保留耐心，去除来信剧情。",
    genres: [],
    age_band: "",
    derived_from: source,
    derivation: {
      source_ref: source,
      retained: ["耐心"],
      rewritten: ["通用海岸经历"],
      excluded: ["来信剧情"],
    },
  });
  const master = await f.free.candidates.get(
    t.conversationId,
    (masterResult.data as { draft_id: string }).draft_id,
  );
  await finish(reverse);
  await show(page, master);
  await page.getByText("独立母版的保留、改写与排除", { exact: true }).click();
  await expect(page.getByRole("region", { name: "信息正文" })).toContainText(
    "来信剧情",
  );
  await page.getByRole("button", { name: "引用到对话", exact: true }).click();
  f.mochi.freeIntent = "save_current";
  const saving = await send(page, "新建独立母版，保存这个版本");
  expect(saving.binding?.action).toBe("create_character");
  const saved = await f.invoke(saving, "save_character", {
    mode: "commit",
    draft_id: master.id,
    draft_revision: "1",
    draft_hash: master.draftHash,
  });
  f.mochi.finish(saving.executionRun!.runId!);
  await expect(
    page.getByText("独立角色母版已新建", { exact: true }),
  ).toBeVisible();
  expect(saved.receipt).toBeTruthy();
  expect((await f.free.conversation(t.conversationId)).sessionId).toBe(session);
  expect(f.store.heads.size).toBe(1);
  expect(pack.payload.members![0]!.content.markdown).toBe("稳定属性：耐心");
  await page.screenshot({ path: "/tmp/mwt029-role-story-role.png" });
});
test("lost first POST is recovered through original GET and retains newer edits without replay", async ({
  page,
}) => {
  f.mochi.freeIntent = "discuss";
  let taskId = "";
  let conversationId = "";
  await page.route("**/api/creative/free/conversations", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    const result = await response.json();
    taskId = result.task.id;
    conversationId = result.conversation.id;
    await route.abort("failed");
  });
  await page.getByLabel("下一条消息").fill("首条自然讨论");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("button", { name: "查询原请求" })).toBeVisible();
  await page.getByLabel("下一条消息").fill("新的未发送反馈");
  await page.reload();
  await expect(page.getByLabel("下一条消息")).toHaveValue("新的未发送反馈");
  const request = page.waitForResponse(
    (r) =>
      r.url().includes("/conversations/by-request/") &&
      r.request().method() === "GET",
  );
  await page.getByRole("button", { name: "查询原请求", exact: true }).click();
  expect((await request).status()).toBe(200);
  await expect(page).toHaveURL(new RegExp(conversationId));
  await expect(page.getByLabel("下一条消息")).toHaveValue("新的未发送反馈");
  expect((await f.records.list("task", conversationId)).length).toBe(1);
  await finish(await f.free.task(taskId));
});
test("unresolved and ambiguous targets never derive authority from the current panel; cancellation remains distinct", async ({
  page,
}) => {
  const t = await send(page, "构思两个对象");
  const a = await draft(t, "甲", "甲正文"),
    b = await draft(t, "乙", "乙正文");
  await finish(t);
  await show(page, a);
  f.mochi.freeIntent = "unclear";
  f.mochi.targetMode = "unclear";
  await page.getByLabel("下一条消息").fill("修改这个");
  const response = page.waitForResponse(
    (r) => r.request().method() === "POST" && /\/tasks$/.test(r.url()),
  );
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const ambiguous = (await (await response).json()).task;
  await expect(page.getByText("需要澄清目标", { exact: true })).toBeVisible();
  expect((await f.free.task(ambiguous.id)).binding).toBeUndefined();
  expect((await f.free.task(ambiguous.id)).input.refs).toEqual([]);
  await show(page, b);
  f.mochi.freeIntent = "draft";
  f.mochi.targetMode = "new";
  f.mochi.holdIntent = true;
  await page.getByLabel("下一条消息").fill("先检索我之前的角色");
  const pending = page.waitForResponse(
    (r) => r.request().method() === "POST" && /\/tasks$/.test(r.url()),
  );
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const resolving = (await (await pending).json()).task;
  await expect(
    page.getByText("检索与核验目标 · 尚无正式写权限", { exact: true }),
  ).toBeVisible();
  expect((await f.free.task(resolving.id)).binding).toBeUndefined();
  await page.getByLabel("下一条消息").fill("保留撤回后的输入");
  await page
    .getByRole("button", { name: "停止并撤回授权", exact: true })
    .last()
    .click();
  await expect(
    page
      .getByRole("region", { name: `创作任务 ${resolving.id}`, exact: true })
      .getByText("已撤回", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("下一条消息")).toHaveValue("保留撤回后的输入");
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeEnabled();
});

test("assets complete before a session, explorer browsing stays passive and stale send preserves explicit input", async ({
  page,
}) => {
  const first = await f.store.commit(
    entity("character", {
      name: "同名资产",
      markdown: "第一个母版正文",
      genres: [],
      ageBand: "",
      sourceMetadata: {},
    }),
    null,
  );
  const second = await f.store.commit(
    entity("world", { ...first.content, markdown: "同名世界观正文" }),
    null,
  );
  await page
    .getByRole("button", { name: "打开 explorer", exact: true })
    .click();
  await page.getByLabel("按名称查找").fill("同名资产");
  const results = page.getByLabel("资产与候选结果");
  await expect(results.getByRole("button")).toHaveCount(2);
  await results
    .getByRole("button")
    .filter({ hasText: first.id.slice(0, 8) })
    .click();
  await expect(page.getByRole("region", { name: "信息正文" })).toContainText(
    "第一个母版正文",
  );
  await expect(page.getByRole("button", { name: /删除引用/ })).toHaveCount(0);
  expect((await f.records.list("conversation")).length).toBe(0);
  await page.getByLabel("下一条消息").fill("@同名资产");
  const choices = page.getByLabel("引用补全");
  await expect(choices.getByRole("button")).toHaveCount(2);
  await expect(choices).toContainText("世界观");
  await choices
    .getByRole("button")
    .filter({ hasText: second.id.slice(0, 8) })
    .click();
  await expect(
    page.getByRole("button", { name: /删除引用 同名资产/ }),
  ).toBeVisible();
  await f.store.commit(
    {
      ...clean(second),
      currentVersion: 2,
      content: { ...second.content, markdown: "已改变" },
    },
    second.revision,
  );
  await page.getByLabel("下一条消息").fill("请讨论这一版资料");
  const rejection = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      /\/creative\/free\/conversations$/.test(r.url()),
  );
  await page.getByRole("button", { name: "发送", exact: true }).click();
  expect((await rejection).status()).toBe(409);
  await expect(page.getByLabel("下一条消息")).toHaveValue("请讨论这一版资料");
  await expect(page.getByRole("button", { name: /删除引用/ })).toHaveCount(1);
  expect((await f.records.list("conversation")).length).toBe(0);
});

test("an in-flight @ selection gates send and cannot erase later input", async ({
  page,
}) => {
  await f.store.commit(
    entity("character", {
      name: "慢速引用",
      markdown: "已固定资料",
      genres: [],
      ageBand: "",
      sourceMetadata: {},
    }),
    null,
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/creative/free/references/resolve", async (route) => {
    await gate;
    await route.continue();
  });
  await page.getByLabel("下一条消息").fill("@慢速引用");
  const selected = page.waitForRequest((r) =>
    r.url().endsWith("/references/resolve"),
  );
  await page.getByLabel("引用补全").getByRole("button").click();
  await selected;
  try {
    await expect(
      page.getByRole("button", { name: "发送", exact: true }),
    ).toBeDisabled();
    await page.getByLabel("下一条消息").fill("新的反馈不含补全");
  } finally {
    release();
  }
  await expect(
    page.getByRole("button", { name: /删除引用 慢速引用/ }),
  ).toBeVisible();
  await expect(page.getByLabel("下一条消息")).toHaveValue("新的反馈不含补全");
  await expect(
    page.getByRole("button", { name: "发送", exact: true }),
  ).toBeEnabled();
});
