import { test, expect } from "@playwright/test";
import { freeFixture } from "./free-fixture.js";
import { entity } from "../../src/server/entities.js";
let f: Awaited<ReturnType<typeof freeFixture>>;
let browserErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  browserErrors = [];
  page.on("pageerror", (e) => browserErrors.push(e.message));
  f = await freeFixture();
  await page.goto(f.address);
  await page.getByRole("button", { name: "使用 Microsoft 账号登录" }).click();
});
test.afterEach(async () => {
  await f?.close();
  expect(browserErrors).toEqual([]);
});
test("default modes and asset entry preserve explicit initial context and local edits", async ({
  page,
}) => {
  await expect(
    page.getByRole("heading", { name: "今天想写点什么？" }),
  ).toBeVisible();
  const doc = entity("character", {
    name: "导航角色",
    markdown: "正式正文",
    genres: [],
    ageBand: "",
    sourceMetadata: {},
  });
  await f.store.commit(doc, null);
  await page.getByRole("link", { name: "角色库", exact: true }).click();
  await page.getByRole("button", { name: /导航角色/ }).click();
  await expect(page.getByText("正式正文", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "编辑资料", exact: true }).click();
  await page.getByLabel("资料正文").fill("人工未保存正文");
  await page.getByRole("button", { name: "带此资产新建会话" }).click();
  await expect(page.getByText("初始上下文 · 仅作为资料")).toBeVisible();
  const response = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith("/creative/free/conversations"),
  );
  await page.getByLabel("下一条消息").fill("讨论角色");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const result = await (await response).json();
  expect(result.conversation.initialRefs[0].asset_id).toBe(doc.id);
  expect(result.task.input.message).toBe("讨论角色");
  await page.getByLabel("下一条消息").fill("下一轮未发送内容");
  await page.getByRole("link", { name: "角色库", exact: true }).click();
  await page.getByRole("button", { name: /导航角色/ }).click();
  await expect(page.getByLabel("资料正文")).toHaveValue("人工未保存正文");
  await page.getByText("返回已有会话", { exact: true }).click();
  await page.getByRole("link", { name: /继续会话：讨论角色/ }).click();
  await expect(page.getByLabel("下一条消息")).toHaveValue("下一轮未发送内容");
  await page.reload();
  await expect(page.getByLabel("下一条消息")).toHaveValue("下一轮未发送内容");
  await expect(page.locator(".writing-host")).toHaveCount(0);
});

async function send(page: import("@playwright/test").Page, text: string) {
  await page.getByLabel("下一条消息").fill(text);
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
test("session summaries show the latest request and never infer a save without a receipt", async ({
  page,
}) => {
  const task = await send(page, "讨论海雾与灯塔，不保存");
  await finish(task);
  await page.route(
    "**/api/creative/free/conversations/*/tasks",
    async (route) => {
      const response = await route.fetch();
      const result = await response.json();
      await route.fulfill({
        response,
        json: {
          ...result,
          items: result.items.map((t: object) => ({
            ...t,
            state: "committed",
            receipt: undefined,
            output: "我已经保存了",
          })),
        },
      });
    },
  );
  await page.getByRole("link", { name: "最近会话", exact: true }).click();
  const row = page.locator("[data-session-id]");
  await expect(row).toContainText("最近消息：讨论海雾与灯塔，不保存");
  await expect(row).toContainText("保存结果待核实");
  await expect(row).toContainText("0 次已确认保存");
  await expect(row.locator("time")).toHaveAttribute("datetime", /T/);
  await expect(row.locator(".session-footer")).toContainText("0 次已确认保存");
  await expect(row.locator(".session-footer time")).toBeVisible();
  await expect(row.locator(".session-preview")).toHaveCSS(
    "-webkit-line-clamp",
    "1",
  );
});
async function finish(task: import("../../src/shared/free.js").FreeTask) {
  f.mochi.finish(task.executionRun!.runId!);
  const response = await fetch(
    `${f.address}/api/creative/free/conversations/${task.conversationId}/tasks/${task.id}/verify`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${f.token}`,
        origin: f.address,
        "content-type": "application/json",
      },
      body: "{}",
    },
  );
  expect(response.status).toBe(200);
  await expect
    .poll(async () => (await f.free.task(task.id)).executionRun?.status)
    .toBe("succeeded");
  // Keep chronological fixtures stable when the host wall clock is adjusted.
  const record = f.records.rows.get(`library:task:${task.id}`);
  if (record?.kind === "task")
    record.createdAt = new Date(
      Date.UTC(2026, 0, 1) + record.epoch * 1000,
    ).toISOString();
}
test("session rows recover unsaved ideas and saved multi-asset sessions only once; receipts round trip", async ({
  page,
}) => {
  const first = await send(page, "发展一个新人物");
  const frozen = await f.invoke(first, "save_character", {
    mode: "draft",
    name: "往返角色",
    markdown: "候选成为正式正文",
    genres: [],
    age_band: "",
  });
  const d = await f.free.candidates.get(
    first.conversationId,
    (frozen.data as { draft_id: string }).draft_id,
  );
  await finish(first);
  await page.getByRole("button", { name: /查看：往返角色/ }).click();
  await page.getByLabel("下一条消息").fill("未发送的阅读反馈");
  await page.getByRole("link", { name: "最近会话", exact: true }).click();
  await expect(page.locator("[data-session-id]")).toHaveCount(1);
  await expect(page.getByText("1 组草稿 · 0 次已确认保存")).toBeVisible();
  await expect(
    page.getByText("尚无正式成果，也可以继续此会话。"),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("link", { name: "继续会话：发展一个新人物" }).click();
  await expect(page.getByLabel("下一条消息")).toHaveValue("未发送的阅读反馈");
  await expect(page.getByRole("region", { name: "信息正文" })).toContainText(
    "候选成为正式正文",
  );
  await page.getByRole("button", { name: "引用到对话", exact: true }).click();
  f.mochi.freeIntent = "save_current";
  const saving = await send(page, "保存这个版本为角色母版");
  const saved = await f.invoke(saving, "save_character", {
    mode: "commit",
    draft_id: d.id,
    draft_revision: "1",
    draft_hash: d.draftHash,
  });
  await finish(saving);
  expect(saved.receipt).toBeTruthy();
  await page.getByLabel("下一条消息").fill("保存后还要继续讨论");
  await page.getByRole("button", { name: "打开正式内容", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "往返角色", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("候选成为正式正文", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("link", { name: "返回原自由会话", exact: true }).click();
  await expect(page.getByLabel("下一条消息")).toHaveValue("保存后还要继续讨论");
  await expect(page.getByRole("region", { name: "信息正文" })).toContainText(
    "候选成为正式正文",
  );
  f.mochi.freeIntent = "draft";
  const second = await send(page, "再构思另一个人物");
  const draft2 = await f.invoke(second, "save_character", {
    mode: "draft",
    name: "另一角色",
    markdown: "独立正文",
    genres: [],
    age_band: "",
  });
  const d2 = await f.free.candidates.get(
    first.conversationId,
    (draft2.data as { draft_id: string }).draft_id,
  );
  await finish(second);
  await page.getByRole("button", { name: /查看：另一角色/ }).click();
  await page.getByRole("button", { name: "引用到对话", exact: true }).click();
  f.mochi.freeIntent = "save_current";
  const save2 = await send(page, "保存这份独立角色");
  await f.invoke(save2, "save_character", {
    mode: "commit",
    draft_id: d2.id,
    draft_revision: "1",
    draft_hash: d2.draftHash,
  });
  await finish(save2);
  await page.getByRole("link", { name: "最近会话", exact: true }).click();
  await expect(page.locator("[data-session-id]")).toHaveCount(1);
  await expect(page.locator(".free-associations a")).toHaveCount(2);
  await expect(page.locator(".free-associations")).toContainText("往返角色");
  await expect(page.locator(".free-associations")).toContainText("另一角色");
  await expect(page.getByText("2 组草稿 · 2 次已确认保存")).toBeVisible();
  await page.screenshot({
    path: "/tmp/mwt044-session-list.png",
    fullPage: true,
  });
  const assetLink = page.locator(".free-associations a").first();
  const unavailableId = (await assetLink.getAttribute("href"))!
    .split("/")
    .at(-1)!;
  await page.route(`**/api/library/${unavailableId}`, (route) =>
    route.fulfill({ status: 503, json: { error: "temporarily unavailable" } }),
  );
  await page.reload();
  await expect(page.locator("[data-session-id]")).toHaveCount(1);
  await expect(page.locator(".free-associations a")).toHaveCount(2);
  await expect(page.locator(".free-associations")).toContainText(
    "内容暂不可用",
  );
  await expect(
    page.getByRole("link", { name: /继续会话：发展一个新人物/ }),
  ).toBeVisible();
});

test("new character and story intents are editable; story and world entries stay read-only initial references at 390px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "角色库", exact: true }).click();
  await page.getByRole("button", { name: "新建角色", exact: true }).click();
  await expect(page.getByLabel("下一条消息")).toHaveValue("我想构思一个角色：");
  await page.getByLabel("下一条消息").fill("人物想法尚未发送");
  await page.getByRole("link", { name: "故事书架", exact: true }).click();
  await page.getByRole("button", { name: "新建故事", exact: true }).click();
  await expect(page.getByLabel("下一条消息")).toHaveValue("我想构思一个故事：");
  expect((await f.records.list("conversation")).length).toBe(0);
  const { randomUUID } = await import("node:crypto");
  const id = randomUUID();
  await f.store.commit(
    {
      ...entity(
        "story",
        {
          name: "入口故事",
          markdown: "故事说明",
          genres: [],
          ageBand: "",
          sourceMetadata: {},
        },
        id,
        id,
      ),
      status: "ready",
    },
    null,
  );
  await page.getByRole("link", { name: "故事书架", exact: true }).click();
  await page.getByRole("button", { name: /入口故事/ }).click();
  await expect(
    page.getByRole("heading", { name: "入口故事", exact: true, level: 1 }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "带此故事新建会话", exact: true })
    .click();
  await page.reload();
  await expect(page.getByText("初始上下文 · 仅作为资料")).toBeVisible();
  await page.locator(".free-initial .free-references button").click();
  await expect(page.getByRole("region", { name: "信息正文" })).toContainText(
    "故事说明",
  );
  await page.getByRole("tab", { name: "讨论", exact: true }).click();
  f.mochi.freeIntent = "discuss";
  const task = await send(page, "讨论故事的角色，不保存");
  expect(
    (await f.free.conversation(task.conversationId)).initialRefs[0],
  ).toMatchObject({ kind: "story", story_id: id });
  expect(task.binding).toBeUndefined();
  await finish(task);
  await page.screenshot({ path: "/tmp/mwt030-mobile.png" });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const world = await f.store.commit(
    entity("world", {
      name: "星海世界",
      markdown: "仅供参考的世界观",
      genres: [],
      ageBand: "",
      sourceMetadata: {},
    }),
    null,
  );
  await page.getByRole("link", { name: "世界观", exact: true }).click();
  await page.getByRole("button", { name: /星海世界/ }).click();
  await page.getByRole("button", { name: "带此资产新建会话" }).click();
  await page.locator(".free-initial .free-references button").click();
  await expect(page.getByRole("region", { name: "信息正文" })).toContainText(
    "仅供参考的世界观",
  );
  await expect(page.getByRole("button", { name: /保存/ })).toHaveCount(0);
  await page.getByRole("button", { name: "引用到对话", exact: true }).click();
  await page.getByRole("tab", { name: "讨论", exact: true }).click();
  const worldTask = await send(page, "只讨论这个世界的故事方向");
  expect(worldTask.input.refs[0]).toMatchObject({
    asset_id: world.id,
    kind: "world",
  });
  expect(worldTask.binding).toBeUndefined();
});

test("stale initial context rejects submission and explicit refresh keeps the typed intent", async ({
  page,
}) => {
  const doc = await f.store.commit(
    entity("character", {
      name: "版本角色",
      markdown: "原正文",
      genres: [],
      ageBand: "",
      sourceMetadata: {},
    }),
    null,
  );
  await page.getByRole("link", { name: "角色库", exact: true }).click();
  await page.getByRole("button", { name: /版本角色/ }).click();
  await page.getByRole("button", { name: "带入新会话" }).click();
  await page.getByLabel("下一条消息").fill("保留我的讨论意图");
  const { Library } = await import("../../src/server/library.js");
  const changed = await new Library(f.store).save(doc.id, doc.revision, {
    ...doc.content,
    markdown: "并发保存的新正文",
  });
  await page.reload();
  await expect(page.locator(".free-initial")).toContainText("v1");
  const rejected = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith("/creative/free/conversations"),
  );
  await page.getByRole("button", { name: "发送", exact: true }).click();
  expect((await rejected).status()).toBe(409);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("下一条消息")).toHaveValue("保留我的讨论意图");
  expect((await f.records.list("conversation")).length).toBe(0);
  await page
    .getByRole("button", { name: "重新读取初始资料", exact: true })
    .click();
  await expect(page.locator(".free-initial")).toContainText("v2");
  await expect(page.getByLabel("下一条消息")).toHaveValue("保留我的讨论意图");
  f.mochi.freeIntent = "discuss";
  const task = await send(page, "保留我的讨论意图");
  expect(
    (await f.free.conversation(task.conversationId)).initialRefs[0],
  ).toMatchObject({ revision: changed.revision });
  expect(task.input.refs).toEqual([]);
});

test("receipt reading bypasses unsaved manual edits while retaining their original CAS baseline", async ({
  page,
}) => {
  const original = await f.store.commit(
    entity("character", {
      name: "并行编辑角色",
      markdown: "第一版正式正文",
      genres: [],
      ageBand: "",
      sourceMetadata: {},
    }),
    null,
  );
  await page.getByRole("link", { name: "角色库", exact: true }).click();
  await page.getByRole("button", { name: /并行编辑角色/ }).click();
  await page.getByRole("button", { name: "编辑资料", exact: true }).click();
  await page.getByLabel("资料正文").fill("保留这份未保存的人工正文");
  await page.getByRole("button", { name: "带此资产新建会话" }).click();
  await page.locator(".free-initial .free-references button").click();
  await page.getByRole("button", { name: "引用到对话", exact: true }).click();
  f.mochi.targetMode = "explicit";
  const drafting = await send(page, "修改这个角色的正文给我看");
  const result = await f.invoke(drafting, "save_character", {
    mode: "draft",
    name: original.content.name,
    markdown: "Agent 保存的第二版正式正文",
    genres: [],
    age_band: "",
  });
  const candidate = await f.free.candidates.get(
    drafting.conversationId,
    (result.data as { draft_id: string }).draft_id,
  );
  expect(candidate.payload.draftContext.baseRevision).toBe(original.revision);
  await finish(drafting);
  await page.getByRole("button", { name: /查看：并行编辑角色/ }).click();
  await page.getByRole("button", { name: "引用到对话", exact: true }).click();
  f.mochi.freeIntent = "save_current";
  const saving = await send(page, "保存这个版本");
  expect(saving.binding?.action).toBe("update_character");
  await f.invoke(saving, "save_character", {
    mode: "commit",
    draft_id: candidate.id,
    draft_revision: "1",
    draft_hash: candidate.draftHash,
  });
  await finish(saving);
  await page.getByLabel("下一条消息").fill("返回后继续讨论的未发送消息");
  await page.getByRole("button", { name: "打开正式内容", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: original.content.name,
      exact: true,
      level: 1,
    }),
  ).toBeVisible();
  await expect(page.locator(".main-content .markdown")).toContainText(
    "Agent 保存的第二版正式正文",
  );
  await expect(page.getByLabel("资料正文")).toHaveCount(0);
  await page.screenshot({
    path: "/tmp/mwt030-r1-formal-reading.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "继续未保存编辑", exact: true })
    .click();
  await expect(page.getByLabel("资料正文")).toHaveValue(
    "保留这份未保存的人工正文",
  );
  const failedSave = page.waitForResponse(
    (r) =>
      r.request().method() === "PUT" &&
      r.url().endsWith(`/library/${original.id}`),
  );
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  const response = await failedSave;
  expect(response.request().postDataJSON().revision).toBe(original.revision);
  expect(response.status()).toBe(409);
  await expect(page.getByRole("alert")).toContainText("版本已变化");
  await expect(page.getByLabel("资料正文")).toHaveValue(
    "保留这份未保存的人工正文",
  );
  expect((await f.store.get(original.id, null))?.content.markdown).toBe(
    "Agent 保存的第二版正式正文",
  );
  await page.getByRole("link", { name: "返回原自由会话", exact: true }).click();
  await expect(page.getByLabel("下一条消息")).toHaveValue(
    "返回后继续讨论的未发送消息",
  );
  await expect(page.getByRole("region", { name: "信息正文" })).toContainText(
    "Agent 保存的第二版正式正文",
  );
});

for (const width of [1280, 390]) {
  test(`world feedback, old draft save and formal reading return at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const discussion = async () => {
      if (width === 390)
        await page.getByRole("tab", { name: "讨论", exact: true }).click();
    };
    await page.getByRole("link", { name: "世界观", exact: true }).click();
    await page.getByRole("button", { name: "新建世界观", exact: true }).click();
    await expect(page.getByLabel("下一条消息")).toHaveValue(
      "我想构思一个世界观：",
    );
    expect((await f.records.list("conversation")).length).toBe(0);
    f.mochi.targetKind = "world";
    const first = await send(page, "构思雾海，只预览");
    const a = await f.invoke(first, "save_world", {
      mode: "draft",
      name: "雾海初稿",
      markdown: "雾海第一版\n三座灯塔。",
      genres: ["奇幻"],
      era: "古代",
    });
    const old = await f.free.candidates.get(
      first.conversationId,
      (a.data as { draft_id: string }).draft_id,
    );
    await finish(first);
    const sessionId = (await f.free.conversation(first.conversationId))
      .sessionId;
    await page.getByRole("button", { name: /查看：雾海初稿/ }).click();
    await expect(page.getByRole("region", { name: "信息正文" })).toContainText(
      "三座灯塔",
    );
    await page.getByRole("button", { name: "引用到对话", exact: true }).click();
    await discussion();
    f.mochi.targetMode = "explicit";
    const feedback = await send(page, "把这份候选改成四座灯塔，仅预览");
    await f.invoke(feedback, "save_world", {
      mode: "draft",
      name: "雾海二稿",
      markdown: "四座灯塔。",
      genres: ["奇幻"],
      group_id: old.groupId,
      parent_ref: f.free.candidates.ref(old),
    });
    await finish(feedback);
    expect(f.store.heads.size).toBe(0);
    await page.getByRole("button", { name: /查看：雾海初稿/ }).click();
    await expect(page.getByRole("region", { name: "信息正文" })).toContainText(
      "三座灯塔",
    );
    await page.getByRole("button", { name: "引用到对话", exact: true }).click();
    await discussion();
    f.mochi.freeIntent = "save_current";
    const saving = await send(page, "原样保存选定旧稿为世界观母版");
    const saved = await f.invoke(saving, "save_world", {
      mode: "commit",
      draft_id: old.id,
      draft_revision: "1",
      draft_hash: old.draftHash,
    });
    await finish(saving);
    const receipt =
      saved.receipt as import("../../src/shared/free.js").ReceiptV2;
    expect(receipt.kind).toBe("world_created");
    const target = receipt.target;
    if (target.kind !== "world") throw Error("world target required");
    expect((await f.store.get(target.asset_id, null))?.content).toEqual(
      old.payload.content,
    );
    await page.getByLabel("下一条消息").fill("回来继续世界观讨论");
    await page
      .getByRole("button", { name: "打开正式内容", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "雾海初稿", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("三座灯塔。", { exact: false })).toBeVisible();
    await page.reload();
    await page
      .getByRole("link", { name: "返回原自由会话", exact: true })
      .click();
    await discussion();
    await expect(page.getByLabel("下一条消息")).toHaveValue(
      "回来继续世界观讨论",
    );
    expect((await f.free.conversation(first.conversationId)).sessionId).toBe(
      sessionId,
    );
    await page.getByRole("link", { name: "最近会话", exact: true }).click();
    await expect(page.locator("[data-session-id]")).toHaveCount(1);
    await expect(page.locator(".free-associations")).toContainText("世界观");
    await page.screenshot({
      path: `/tmp/mwt022-world-${width}.png`,
      fullPage: true,
    });
  });
}

test("legacy conversation explains world capability and opens an independent new entry", async ({
  page,
}) => {
  const first = await send(page, "保留原会话");
  await finish(first);
  const current = await f.free.conversation(first.conversationId);
  const old = { ...current };
  delete old.toolsetVersion;
  await f.records.transaction("library", [
    { record: old, revision: current.revision },
  ]);
  const persistedOld = await f.free.conversation(first.conversationId);
  await page.reload();
  await expect(
    page.getByRole("complementary", { name: "旧会话能力" }),
  ).toContainText("世界观可讨论和阅读");
  await page.getByLabel("下一条消息").fill("留在原会话的消息");
  await page
    .getByRole("button", { name: "新建支持世界观的会话", exact: true })
    .click();
  await expect(page.getByLabel("下一条消息")).toHaveValue(
    "我想构思一个世界观：",
  );
  expect((await f.records.list("conversation")).length).toBe(1);
  expect(await f.free.conversation(first.conversationId)).toEqual(persistedOld);
  await page.goto(`${f.address}/#free/conversation/${first.conversationId}`);
  await expect(page.getByLabel("下一条消息")).toHaveValue("留在原会话的消息");
});

test("initial names keep their exact version in the session and list", async ({
  page,
}) => {
  const original = await f.store.commit(
    entity("character", {
      name: "旧名灯塔守卫",
      markdown: "第一版正文",
      genres: [],
      ageBand: "",
      sourceMetadata: {},
    }),
    null,
  );
  await page.getByRole("link", { name: "角色库", exact: true }).click();
  await page.getByRole("button", { name: /旧名灯塔守卫/ }).click();
  await page.getByRole("button", { name: "带入新会话" }).click();
  await expect(page.locator(".free-initial")).toContainText("旧名灯塔守卫");
  f.mochi.freeIntent = "discuss";
  const task = await send(page, "带着旧资料讨论灯塔");
  await finish(task);
  const { Library } = await import("../../src/server/library.js");
  await new Library(f.store).save(original.id, original.revision, {
    ...original.content,
    name: "新版远航者",
  });
  await page.reload();
  const initial = page.locator(".free-initial");
  await expect(initial).toContainText("旧名灯塔守卫");
  await expect(initial).not.toContainText("新版远航者");
  await expect(initial).not.toContainText(original.id.slice(0, 8));
  await page.getByRole("link", { name: "最近会话", exact: true }).click();
  const row = page.locator(`[data-session-id="${task.conversationId}"]`);
  await expect(row.locator(".free-associations > span")).toContainText(
    "旧名灯塔守卫 · 第 1 版",
  );
  await expect(row.locator(".free-associations > span")).not.toContainText(
    "新版远航者",
  );
  await expect(row.locator(".free-associations > span")).not.toContainText(
    original.id.slice(0, 8),
  );
  await row.getByText("更多", { exact: true }).click();
  await expect(row.locator(".free-identity")).toContainText(original.id);
  f.store.history.delete(`${original.id}:1`);
  await page.reload();
  await expect(row.locator(".free-associations > span")).toContainText(
    "原版本不可用 · 第 1 版",
  );
  await expect(row.locator(".free-associations > span")).not.toContainText(
    "新版远航者",
  );
  await page.goto(`${f.address}/#free/conversation/${task.conversationId}`);
  await expect(initial).toContainText("原版本不可用");
  await expect(initial).not.toContainText("新版远航者");
});
