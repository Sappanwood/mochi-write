import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { freeFixture } from "./free-fixture.js";
import { importFiles } from "../../src/server/import.js";
import { readBundle } from "../../src/server/filesystem.js";

let f: Awaited<ReturnType<typeof freeFixture>>;
test.beforeEach(async ({ page }) => {
  f = await freeFixture();
  await importFiles(
    f.store,
    await readBundle("tests/fixtures/novel"),
    randomUUID(),
  );
  await page.goto(f.address);
  await page.getByRole("button", { name: "使用 Microsoft 账号登录" }).click();
});
test.afterEach(async () => {
  await f?.close();
});

test("navigation has one current destination and preserves legacy links under more", async ({
  page,
}) => {
  await page.getByRole("link", { name: "故事书架", exact: true }).click();
  await expect(page.locator('a[aria-current="page"]')).toHaveCount(1);
  await expect(
    page.getByRole("link", { name: "资产阅览", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "旧创作会话与草稿" }),
  ).not.toBeVisible();
  await page.getByText("更多", { exact: true }).click();
  await expect(
    page.getByRole("link", { name: "旧创作会话与草稿" }),
  ).toHaveAttribute("href", "#creative/conversations");
  await page.getByRole("link", { name: "导入与导出", exact: true }).click();
  await expect(page).toHaveURL(/#transfer$/);
});

for (const width of [1440, 390]) {
  test(`reader shows prose above the fold and preserves chapter navigation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.getByRole("link", { name: "故事书架", exact: true }).click();
    await page.getByRole("button", { name: /灯塔.*阅读故事/ }).click();
    const prose = page.getByText("林舟在灯塔下捡到了一封信。", { exact: true });
    await expect(prose).toBeInViewport();
    await expect(
      page.getByRole("heading", { name: "关联自由会话" }),
    ).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "带此故事新建会话", exact: true }),
    ).toBeVisible();
    await page.getByText("章节目录", { exact: true }).click();
    await expect(page.getByRole("button", { name: "02ch02" })).toBeVisible();
    await page.getByRole("button", { name: "02ch02" }).click();
    await expect(
      page.getByRole("button", { name: "下一章", exact: true }),
    ).toBeDisabled();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "下一章", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "上一章", exact: true }).click();
    await expect(prose).toBeVisible();
    await page.getByText("返回已有会话", { exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "关联自由会话" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByText("返回已有会话", { exact: true }).click();
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `/tmp/mwt042-reader-${width}.png` });
  });
}
