import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { freeFixture } from "./free-fixture.js";
import { entity } from "../../src/server/entities.js";

let f: Awaited<ReturnType<typeof freeFixture>>;
test.beforeEach(async ({ page }) => {
  f = await freeFixture();
  await page.goto(f.address);
  await page.getByRole("button", { name: "使用 Microsoft 账号登录" }).click();
});
test.afterEach(async () => {
  await f?.close();
});

test("cards expose readable summaries and update dates, with empty and long content at 390px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "角色库", exact: true }).click();
  await expect(page.getByText(/没有匹配的角色/)).toBeVisible();
  const longName = "负责守护海上灯塔与远航来信的年轻记录员".repeat(3);
  for (const [name, markdown] of [
    [
      longName,
      "# 角色档案\n\n守护灯塔，记录**远航者**的来信。\n\n![装饰](https://example.com/image.png)",
    ],
    ["空白角色", ""],
  ] as const) {
    await f.store.commit(
      entity("character", {
        name,
        markdown,
        genres: [],
        ageBand: "",
        sourceMetadata: {},
      }),
      null,
    );
  }
  await page.reload();
  const card = page.locator(".asset-card").filter({ hasText: longName });
  await expect(
    card.getByText("守护灯塔，记录远航者的来信。", { exact: true }),
  ).toBeVisible();
  await expect(card.locator("time")).toHaveAttribute("datetime", /T/);
  await expect(card.locator("time")).not.toContainText(/T.*Z/);
  await expect(
    page.locator(".asset-card").filter({ hasText: "空白角色" }),
  ).toContainText("暂无内容摘要");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "/tmp/mwt044-characters.png", fullPage: true });
});

test("story summaries survive pagination without duplicate titles or changed destinations", async ({
  page,
}) => {
  for (let i = 0; i < 41; i++) {
    const id = randomUUID();
    await f.store.commit(
      {
        ...entity(
          "story",
          {
            name: `灯塔故事${i}`,
            markdown: `# 灯塔故事${i}\n\n第${i}座岛上的来信与航行。`,
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
  }
  await page.getByRole("link", { name: "故事书架", exact: true }).click();
  await expect(page.locator(".story-card")).toHaveCount(40);
  const first = page.locator(".story-card").first();
  await expect(first.locator("h2, h3")).toHaveCount(1);
  await expect(first.locator(".content-summary")).toContainText("来信与航行");
  await page.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect(page.locator(".story-card")).toHaveCount(41);
  await expect(
    page.getByRole("button", { name: "加载更多", exact: true }),
  ).toHaveCount(0);
  await first.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/mwt044-stories.png" });
  const title = await first.locator("h2").innerText();
  await first.click();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
});
