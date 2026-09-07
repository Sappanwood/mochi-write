import { registerWriting } from "../../src/server/writing-routes.js";
import { Writing } from "../../src/server/writing.js";
import { MemoryWritingStore } from "../support/writing-store.js";
import { FakeMochi } from "../support/fake-mochi.js";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { createApp } from "../../src/server/app.js";
import { createVerifier } from "../../src/server/auth.js";
import { loadConfig } from "../../src/server/config.js";
import { registerBusiness } from "../../src/server/routes.js";
import { importFiles } from "../../src/server/import.js";
import { readBundle } from "../../src/server/filesystem.js";
import { MemoryStore } from "../support/memory-store.js";
import type { Document } from "../../src/shared/model.js";
import { Library } from "../../src/server/library.js";
let writingRecords: MemoryWritingStore, mochi: FakeMochi;
let server: FastifyInstance,
  address: string,
  store: MemoryStore,
  asset: Document;
test.beforeAll(async () => {
  const config = loadConfig({
    ENTRA_TENANT_ID: "11111111-1111-4111-8111-111111111111",
    ENTRA_OWNER_OID: "22222222-2222-4222-8222-222222222222",
    ENTRA_SPA_CLIENT_ID: "33333333-3333-4333-8333-333333333333",
    ENTRA_API_CLIENT_ID: "44444444-4444-4444-8444-444444444444",
    APP_ORIGIN: "http://127.0.0.1:18080",
    COSMOS_ENDPOINT: "https://example.documents.azure.com/",
  });
  const keys = await generateKeyPair("RS256");
  const jwk = await exportJWK(keys.publicKey);
  const token = await new SignJWT({
    tid: config.auth.tenantId,
    oid: config.auth.ownerOid,
    azp: config.auth.spaClientId,
    scp: "Write.Access",
    ver: "2.0",
  })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(`https://login.microsoftonline.com/${config.auth.tenantId}/v2.0`)
    .setAudience(config.auth.apiClientId)
    .setIssuedAt()
    .setExpirationTime("20m")
    .sign(keys.privateKey);
  store = new MemoryStore();
  server = await createApp({
    config,
    verify: createVerifier(
      config.auth,
      createLocalJWKSet({ keys: [{ ...jwk, kid: "fixture" }] }),
    ),
    checkStorage: async () => {},
  });
  registerBusiness(server, store);
  writingRecords = new MemoryWritingStore(store);
  mochi = new FakeMochi();
  registerWriting(server, new Writing(store, writingRecords, mochi));
  server.get("/fixture-token", async (_request, reply) =>
    reply.header("cache-control", "no-store").send({ token }),
  );
  await server.register(fastifyStatic, {
    root: resolve(".data/browser"),
    wildcard: false,
  });
  address = await server.listen({ host: "127.0.0.1", port: 0 });
  config.origin = address;
});
test.afterAll(async () => {
  await server?.close();
});
test.beforeEach(async ({ page }) => {
  writingRecords.values.clear();
  writingRecords.sessions.clear();
  writingRecords.requests.clear();
  mochi.runs.clear();
  mochi.calls = [];
  mochi.status = "succeeded";
  store.heads.clear();
  store.history.clear();
  store.failNext = false;
  await importFiles(
    store,
    await readBundle("tests/fixtures/novel"),
    randomUUID(),
  );
  asset = (await store.list({ projectId: null, kind: "character" })).items[0]!;
  await page.goto(address);
  await page.getByRole("button", { name: "使用 Microsoft 账号登录" }).click();
  await expect(
    page.getByRole("heading", { name: "角色", exact: true }),
  ).toBeVisible();
});
test("browse, filter and persist an asset edit across refresh", async ({
  page,
}) => {
  await page.screenshot({ path: "/tmp/mwt002-library.png", fullPage: true });
  await page.getByLabel("名称", { exact: true }).fill("不存在");
  await expect(page.getByText("没有匹配的角色")).toBeVisible();
  await page.getByLabel("名称", { exact: true }).fill("林舟");
  await page.getByRole("button", { name: /林舟.*阅读与编辑/ }).click();
  await page.getByRole("button", { name: "编辑资产" }).click();
  await page.getByLabel("资料正文").fill("更新后的灯塔资料。");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByRole("status")).toHaveText("已保存");
  await page.reload();
  await expect(page.getByText("更新后的灯塔资料。")).toBeVisible();
  expect(
    (await store.get(asset.id, null))?.content.sourceMetadata.custom_field,
  ).toEqual({ color: "蓝" });
});
test("failed saves and real stale revisions retain the draft", async ({
  page,
}) => {
  await page.goto(`${address}/#asset/${asset.id}`);
  await page.getByRole("button", { name: "编辑资产" }).click();
  await page.getByLabel("资料正文").fill("我的未保存草稿");
  store.failNext = true;
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByRole("alert")).toContainText("保存失败");
  await expect(page.getByLabel("资料正文")).toHaveValue("我的未保存草稿");
  await new Library(store).save(asset.id, asset.revision, {
    ...asset.content,
    markdown: "另一个窗口的版本",
  });
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByRole("alert")).toContainText("版本已变化");
  await page.getByRole("button", { name: "读取最新版本，保留草稿" }).click();
  await expect(
    page.getByText("另一个窗口的版本", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "世界观", exact: true }).click();
  await page.getByRole("link", { name: "林舟", exact: true }).click();
  await expect(page.getByLabel("资料正文")).toHaveValue("我的未保存草稿");
});
test("reads ordered chapters, settings and independent snapshots with safe Markdown", async ({
  page,
}) => {
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await page.getByRole("link", { name: "故事书架" }).click();
  await page.getByRole("button", { name: /灯塔.*故事/ }).click();
  await expect(
    page.getByRole("heading", { name: "第一章 来信", exact: true }),
  ).toBeVisible();
  expect(await page.locator(".markdown script").count()).toBe(0);
  expect(await page.locator('.markdown a[href^="javascript:"]').count()).toBe(
    0,
  );
  expect(dialogs).toEqual([]);
  await page.getByRole("button", { name: "下一章" }).click();
  await expect(
    page.getByRole("heading", { name: "第二章 远航", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "设定与关系", exact: true }).click();
  await expect(page.getByText("林舟与渡船船长是朋友。")).toBeVisible();
  await new Library(store).remove(asset.id, asset.revision);
  await page.getByRole("button", { name: "故事资产", exact: true }).click();
  await page.getByRole("button", { name: "林舟", exact: true }).click();
  await expect(page.getByText("守护灯塔，收集远方的来信。")).toBeVisible();
  await expect(page.getByText("随身带着一张褪色的海图。")).toBeVisible();
});
test("previews and repeats folder import, then downloads Markdown ZIP", async ({
  page,
}) => {
  writingRecords.values.clear();
  writingRecords.sessions.clear();
  writingRecords.requests.clear();
  mochi.runs.clear();
  mochi.calls = [];
  mochi.status = "succeeded";
  store.heads.clear();
  store.history.clear();
  await page.getByRole("link", { name: "导入与导出" }).click();
  await page
    .locator("input[type=file]")
    .setInputFiles(resolve("tests/fixtures/novel"));
  await page.getByRole("button", { name: "预检资料" }).click();
  await expect(page.getByRole("heading", { name: /预检通过/ })).toBeVisible();
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("status")).toContainText("导入完成");
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("status")).toContainText("新增 0 项");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 Markdown 导出包" }).click();
  expect((await download).suggestedFilename()).toMatch(/mochi-write-.*\.zip$/);
});
test("mobile workspace has no horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "角色", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("writing sidebar freezes target through navigation, rewrites and atomically accepts", async ({
  page,
}) => {
  const story = (await store.list({ kind: "story" })).items[0]!;
  await page.goto(`${address}/#story/${story.id}/chapter`);
  await page.getByRole("button", { name: "打开写作助手" }).click();
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await page.getByLabel("新章节名称", { exact: true }).fill("灯塔归途");
  await page.getByLabel("章节顺序", { exact: true }).fill("3");
  await page.getByLabel("本次要求", { exact: true }).fill("写灯塔归途");
  await page.getByRole("button", { name: "预览发送内容" }).click();
  await expect(
    page.getByText("目标：灯塔归途", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "确认发送", exact: true }).click();
  await expect(
    page.getByText("状态：succeeded", { exact: true }),
  ).toBeVisible();
  const first = [...writingRecords.values.values()][0]!;
  await page.getByRole("button", { name: "设定与关系", exact: true }).click();
  await expect(
    page.getByText("状态：succeeded", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "反馈重写", exact: true }).click();
  await page.getByLabel("本次要求", { exact: true }).fill("更简练");
  await page.getByRole("button", { name: "预览发送内容" }).click();
  await page.getByRole("button", { name: "确认发送", exact: true }).click();
  await expect(page.getByText("状态：succeeded", { exact: true })).toHaveCount(
    2,
  );
  const drafts = [...writingRecords.values.values()];
  expect(drafts[1]!.targetId).toBe(first.targetId);
  await page.getByRole("button", { name: "采纳到固定章节" }).last().click();
  await expect(page.getByText(/已采纳，/)).toBeVisible();
  expect((await store.get(first.targetId!, story.id))?.content.name).toBe(
    "灯塔归途",
  );
  await page.reload();
  await page.getByRole("button", { name: "打开写作助手" }).click();
  await expect(page.getByText("状态：accepted", { exact: true })).toBeVisible();
});
test("running task survives refresh and can be cancelled without adoption", async ({
  page,
}) => {
  mochi.status = "running";
  const story = (await store.list({ kind: "story" })).items[0]!;
  await page.goto(`${address}/#story/${story.id}/chapter`);
  await page.getByRole("button", { name: "打开写作助手" }).click();
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await page.getByLabel("本次要求", { exact: true }).fill("继续");
  await page.getByRole("button", { name: "预览发送内容" }).click();
  await page.getByRole("button", { name: "确认发送", exact: true }).click();
  await expect(page.getByText("状态：running", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "打开写作助手" }).click();
  await expect(page.getByText("状态：running", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消任务", exact: true }).click();
  await expect(
    page.getByText("状态：cancelled", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "采纳到固定章节" }),
  ).toHaveCount(0);
});
test("library conversation supplies context but has no chapter adoption", async ({
  page,
}) => {
  await page.getByRole("button", { name: "打开写作助手" }).click();
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await page.getByLabel("本次要求", { exact: true }).fill("总结角色");
  await page.getByRole("button", { name: "预览发送内容" }).click();
  await page.getByRole("button", { name: "确认发送", exact: true }).click();
  await expect(
    page.getByText("状态：succeeded", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "采纳到固定章节" }),
  ).toHaveCount(0);
});

test("editing the target preserves explicitly selected references", async ({
  page,
}) => {
  const story = (await store.list({ kind: "story" })).items[0]!;
  await page.goto(`${address}/#story/${story.id}/chapter`);
  await page.getByRole("button", { name: "打开写作助手" }).click();
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  const checks = page.getByRole("checkbox");
  await checks.first().uncheck();
  await checks.nth(1).check();
  await checks.nth(2).check();
  await page.getByLabel("新章节名称", { exact: true }).fill("保留引用");
  await page.getByLabel("章节顺序", { exact: true }).fill("5");
  await page.waitForTimeout(250);
  await expect(checks.first()).not.toBeChecked();
  await expect(checks.nth(1)).toBeChecked();
  await expect(checks.nth(2)).toBeChecked();
  await page.getByLabel("本次要求", { exact: true }).fill("使用选中资料");
  const [sent] = await Promise.all([
    page.waitForRequest((r) => r.url().endsWith("/api/writing/context")),
    page.getByRole("button", { name: "预览发送内容" }).click(),
  ]);
  expect(sent.postDataJSON().attachedRefs).toHaveLength(2);
  const first = (await store.list({ projectId: story.id, kind: "chapter" }))
    .items[0]!;
  expect(
    sent
      .postDataJSON()
      .attachedRefs.some((r: { id: string }) => r.id === first.id),
  ).toBe(false);
});

test("returning to a scope restores the explicitly selected older conversation", async ({
  page,
}) => {
  const story = (await store.list({ kind: "story" })).items[0]!;
  await page.goto(`${address}/#story/${story.id}/chapter`);
  await page.getByRole("button", { name: "打开写作助手" }).click();
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  const older = await page.getByLabel("会话", { exact: true }).inputValue();
  await page.getByRole("button", { name: "新建会话", exact: true }).click();
  await page.getByLabel("会话", { exact: true }).selectOption(older);
  await page.goto(`${address}/#library/character`);
  await page.getByRole("button", { name: "打开写作助手" }).click();
  await expect(page.getByLabel("会话", { exact: true })).toHaveValue("");
  await page.goto(`${address}/#story/${story.id}/chapter`);
  await page.getByRole("button", { name: "打开写作助手" }).click();
  await expect(page.getByLabel("会话", { exact: true })).toHaveValue(older);
});
