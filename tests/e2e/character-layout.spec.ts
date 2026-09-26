import { test, expect } from "@playwright/test";
import { freeFixture } from "./free-fixture.js";
import { entity } from "../../src/server/entities.js";

let f: Awaited<ReturnType<typeof freeFixture>>;
test.afterEach(async () => {
  await f?.close();
});

test("character profile keeps identity, reading and management usable on desktop and phone", async ({
  page,
}) => {
  f = await freeFixture();
  const doc = await f.store.commit(
    entity("character", {
      name: "林舟 · 海上来信的记录者",
      markdown:
        "## 人物小传\n\n林舟守着海边的旧灯塔，替远航的人保管来信。\n\n## 性格与习惯\n\n她习惯先听完别人的故事，再翻开自己的笔记。\n\n## 外貌\n\n银色短发，绿色眼睛，深蓝色旅行外套。",
      genres: ["奇幻"],
      ageBand: "青年",
      sourceMetadata: { age: "24", occupation: "灯塔守望者", gender: "" },
    }),
    null,
  );
  await page.goto(`${f.address}/#asset/${doc.id}`);
  await page.getByRole("button", { name: "使用 Microsoft 账号登录" }).click();
  const profile = page.getByRole("region", { name: "角色档案", exact: true });
  await expect(
    profile.getByRole("heading", { name: doc.content.name }),
  ).toBeVisible();
  await expect(profile.getByText("灯塔守望者", { exact: true })).toBeVisible();
  await expect(profile.getByText("性别", { exact: true })).toHaveCount(0);
  const portraitBounds = await profile.locator(".portrait-image").boundingBox();
  expect(portraitBounds!.width / portraitBounds!.height).toBeCloseTo(3 / 4, 2);
  await expect(page.getByLabel("采用的生图提示词")).not.toBeVisible();
  const portraitManager = profile.getByRole("button", {
    name: "头像与提示词",
    exact: true,
  });
  await expect(portraitManager).toHaveCount(1);
  await expect(profile.getByText(/^(添加头像|更换头像)$/)).toHaveCount(0);
  await portraitManager.focus();
  await page.keyboard.press("Enter");
  await expect(portraitManager).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByLabel("采用的生图提示词")).toBeVisible();
  await page.keyboard.press("Space");
  await expect(portraitManager).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByLabel("采用的生图提示词")).not.toBeVisible();
  await page.screenshot({
    path: "/tmp/mochi-character-desktop.png",
    fullPage: true,
  });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(portraitManager).toBeVisible();
    const bounds = await profile.locator(".portrait-image").boundingBox();
    expect(bounds!.width / bounds!.height).toBeCloseTo(3 / 4, 2);
    const managerBounds = await portraitManager.boundingBox();
    expect(managerBounds!.height).toBeGreaterThanOrEqual(44);
    await portraitManager.click();
    await expect(page.getByLabel("采用的生图提示词")).toBeVisible();
    await portraitManager.click();
    await profile.getByText("更多", { exact: true }).click();
    await expect(
      page.getByRole("button", { name: "删除角色", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await profile.getByText("更多", { exact: true }).click();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    (await page.getByRole("heading", { name: "人物小传" }).boundingBox())!.y,
  ).toBeLessThan(500);
  await page.screenshot({
    path: "/tmp/mochi-character-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "带入新会话", exact: true }).click();
  await expect(page.getByText("初始上下文 · 仅作为资料")).toBeVisible();
  expect((await f.records.list("conversation", "")).length).toBe(0);
  await page.goto(`${f.address}/#asset/${doc.id}`);
  await page.getByRole("button", { name: "编辑资料", exact: true }).click();
  await expect(
    page.getByText("修改仅影响角色库，已有故事中的角色保持不变。", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel("名称", { exact: true }).fill("林舟");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "林舟", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "返回角色库" }).click();
  await expect(page.locator(".character-card")).toHaveCount(1);
  const cardPortrait = await page
    .locator(".character-card .portrait-image")
    .boundingBox();
  expect(cardPortrait!.width / cardPortrait!.height).toBeCloseTo(3 / 4, 2);
  await page.screenshot({
    path: "/tmp/mochi-character-library.png",
    fullPage: true,
  });
});
