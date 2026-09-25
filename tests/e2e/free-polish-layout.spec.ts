import { test, expect } from "@playwright/test";
import { freeFixture } from "./free-fixture.js";

let f: Awaited<ReturnType<typeof freeFixture>>;
test.beforeEach(async ({ page }) => {
  f = await freeFixture();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(f.address);
  await page.getByRole("button", { name: "使用 Microsoft 账号登录" }).click();
});
test.afterEach(async () => {
  await f?.close();
});

test("navigation collapse restores space and remains reachable on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 950, height: 800 });
  const sidebar = (await page.locator(".sidebar").boundingBox())!;
  const toggle = (await page
    .getByRole("button", { name: "收起主导航", exact: true })
    .boundingBox())!;
  const brand = (await page.locator(".sidebar .wordmark").boundingBox())!;
  expect(toggle.x + toggle.width).toBeLessThanOrEqual(
    sidebar.x + sidebar.width - 8,
  );
  expect(brand.x + brand.width).toBeLessThanOrEqual(toggle.x - 4);
  await page.setViewportSize({ width: 1440, height: 900 });
  const content = page.locator(".main-content");
  const initial = (await content.boundingBox())!.width;
  await page.getByRole("button", { name: "收起主导航", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "主导航" }),
  ).not.toBeVisible();
  expect((await content.boundingBox())!.width).toBeGreaterThan(initial + 100);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "展开主导航", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "展开主导航", exact: true }).click();
  await page.getByRole("link", { name: "故事书架", exact: true }).click();
  await expect(page).toHaveURL(/#stories$/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("split gives prose more space, supports keyboard and pointer resizing, and restores preference", async ({
  page,
}) => {
  await page.getByRole("button", { name: "资料与草稿", exact: true }).click();
  const divider = page.getByRole("separator", { name: "调整讨论与稿件宽度" });
  await expect(divider).toHaveAttribute("aria-valuenow", "40");
  const discussion = (await page.locator(".free-discussion").boundingBox())!;
  const information = (await page.locator(".free-information").boundingBox())!;
  expect(information.width / discussion.width).toBeCloseTo(1.5, 1);
  await divider.focus();
  await divider.press("ArrowRight");
  await expect(divider).toHaveAttribute("aria-valuenow", "42");
  await divider.press("Home");
  await divider.press("ArrowLeft");
  await expect(divider).toHaveAttribute("aria-valuenow", "30");
  const box = (await divider.boundingBox())!;
  const columns = (await page.locator(".free-columns").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(columns.x + columns.width / 2, box.y + box.height / 2);
  await page.mouse.up();
  await expect(divider).toHaveAttribute("aria-valuenow", "50");
  await page.screenshot({ path: "/tmp/mochi-polish-split-1440.png" });
  await page.getByRole("button", { name: "收起主导航", exact: true }).click();
  await page.screenshot({ path: "/tmp/mochi-polish-collapsed-1440.png" });
  await page.setViewportSize({ width: 1024, height: 768 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.reload();
  await expect(divider).toHaveAttribute("aria-valuenow", "50");
  await page.getByRole("button", { name: "收起资料", exact: true }).click();
  await expect(divider).not.toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(divider).not.toBeVisible();
  await expect(page.getByLabel("下一条消息", { exact: true })).toBeVisible();
});
