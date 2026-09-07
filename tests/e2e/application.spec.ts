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
