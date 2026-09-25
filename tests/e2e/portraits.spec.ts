import { test, expect } from "@playwright/test";
import sharp from "sharp";
import { freeFixture } from "./free-fixture.js";
import { entity } from "../../src/server/entities.js";
let f: Awaited<ReturnType<typeof freeFixture>>;
test.afterEach(async () => {
  await f?.close();
});
test("uploads and crops a portrait, preserves prompt drafts, resolves conflicts and opens an unsent 2.5D request", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const values = new Map<string, Buffer>();
  f = await freeFixture({
    async put(id, data) {
      values.set(id, data);
    },
    async get(id) {
      return values.get(id);
    },
  });
  const doc = await f.store.commit(
    entity("character", {
      name: "银发旅人",
      markdown: "银色短发，绿眼睛。",
      genres: [],
      ageBand: "",
      sourceMetadata: {},
    }),
    null,
  );
  await page.goto(`${f.address}/#asset/${doc.id}`);
  await page.getByRole("button", { name: "使用 Microsoft 账号登录" }).click();
  await page.getByText("头像与提示词", { exact: true }).click();
  await page
    .getByLabel("采用的生图提示词")
    .fill("2.5D，银色短发，绿眼睛，柔和体积光影。");
  const manager = page.getByRole("button", {
    name: "头像与提示词",
    exact: true,
  });
  await manager.click();
  await expect(page.getByLabel("采用的生图提示词")).not.toBeVisible();
  await expect(page.getByText("尚未保存", { exact: true })).toBeVisible();
  await page.reload();
  await expect(manager).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByLabel("采用的生图提示词")).toHaveValue(/银色短发/);
  await page.getByLabel("上传头像").setInputFiles({
    name: "portrait.png",
    mimeType: "image/png",
    buffer: await sharp({
      create: { width: 160, height: 240, channels: 3, background: "#64748b" },
    })
      .png()
      .toBuffer(),
  });
  await expect(page.getByLabel("头像裁剪预览")).toBeVisible();
  await page.getByLabel("缩放", { exact: true }).fill("1.5");
  await page.getByRole("button", { name: "使用此裁剪" }).click();
  await expect(page.getByRole("img", { name: "银发旅人的头像" })).toBeVisible();
  await page.getByRole("button", { name: "保存头像与提示词" }).click();
  await expect(
    page.getByText("头像与提示词已保存", { exact: true }),
  ).toBeVisible();
  let saved = (await f.store.get(doc.id, null))!;
  expect(saved.portrait?.imageId).toBeTruthy();
  await page.reload();
  await expect(page.getByRole("img", { name: "银发旅人的头像" })).toBeVisible();
  await page.getByText("头像与提示词", { exact: true }).click();
  await page.getByLabel("采用的生图提示词").fill("2.5D，保留新的提示词草稿");
  await f.store.commit(
    {
      ...saved,
      currentVersion: saved.currentVersion + 1,
      content: { ...saved.content, markdown: "最新正文，仍是银发" },
    },
    saved.revision,
  );
  await page.getByRole("button", { name: "保存头像与提示词" }).click();
  await expect(page.getByRole("alert")).toContainText("版本已变化");
  await page.getByRole("button", { name: "读取最新头像，保留草稿" }).click();
  await expect(
    page.getByText("服务器最新头像与提示词", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "保存头像与提示词" }).click();
  await expect(
    page.getByText("头像与提示词已保存", { exact: true }),
  ).toBeVisible();
  saved = (await f.store.get(doc.id, null))!;
  expect(saved.content.markdown).toBe("最新正文，仍是银发");
  expect(saved.portrait?.prompt).toContain("新的提示词草稿");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "整理 2.5D 提示词" }).click();
  await expect(page.getByLabel("下一条消息")).toHaveValue(/2.5D/);
  await expect(page.getByLabel("下一条消息")).toHaveValue(/建议补充/);
  await expect(page.getByText("初始上下文 · 仅作为资料")).toBeVisible();
  expect((await f.records.list("conversation", "")).length).toBe(0);
  await page.goto(`${f.address}/#asset/${doc.id}`);
  await page.getByText("头像与提示词", { exact: true }).click();
  await page.getByRole("button", { name: "移除头像", exact: true }).click();
  await page.getByRole("button", { name: "保存头像与提示词" }).click();
  await expect(
    page.getByText("头像与提示词已保存", { exact: true }),
  ).toBeVisible();
  expect((await f.store.get(doc.id, null))?.portrait).toEqual({
    prompt: "2.5D，保留新的提示词草稿",
  });
  expect(values.size).toBe(1);
  expect(errors).toEqual([]);
});
