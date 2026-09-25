import { test, expect } from "@playwright/test";
import { freeFixture } from "./free-fixture.js";
import { entity } from "../../src/server/entities.js";

let f: Awaited<ReturnType<typeof freeFixture>>;
test.beforeEach(async () => {
  f = await freeFixture();
});
test.afterEach(async () => {
  await f?.close();
});

for (const [kind, label] of [
  ["character", "角色"],
  ["world", "世界观"],
] as const) {
  test(`${kind} waits for the first response before offering an empty-library action`, async ({
    page,
  }) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/library?**", async (route) => {
      await pending;
      await route.continue();
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${f.address}/#library/${kind}`);
    await page.getByRole("button", { name: "使用 Microsoft 账号登录" }).click();
    await expect(page.getByRole("status")).toHaveText(`正在读取${label}…`);
    await expect(page.locator(".asset-grid[aria-busy=true]")).toBeVisible();
    await expect(page.locator(".asset-placeholder")).toHaveCount(3);
    await expect(page.locator(".empty")).toHaveCount(0);
    release();
    await expect(page.getByText(`还没有${label}`)).toBeVisible();
    await expect(page.locator(".asset-placeholder")).toHaveCount(0);
    await page.getByRole("button", { name: `创建第一个${label}` }).click();
    await expect(page.getByRole("textbox", { name: "下一条消息" })).toHaveValue(
      `我想构思一个${label}：`,
    );
    expect((await f.store.list({ kind })).items).toHaveLength(0);
  });
}

test("failed list requests can retry and unmatched filters can be cleared", async ({
  page,
}) => {
  await f.store.commit(
    entity("character", {
      name: "林舟",
      markdown: "守护灯塔的记录员。",
      genres: ["奇幻"],
      ageBand: "青年",
      sourceMetadata: {},
    }),
    null,
  );
  let fail = true;
  await page.route("**/api/library?**", async (route) => {
    if (fail) {
      fail = false;
      await route.fulfill({ status: 503, json: { error: "暂时无法读取" } });
    } else await route.continue();
  });
  await page.goto(`${f.address}/#library/character`);
  await page.getByRole("button", { name: "使用 Microsoft 账号登录" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.locator(".empty")).toHaveCount(0);
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator(".asset-card")).toHaveCount(1);
  await page.getByLabel("名称", { exact: true }).fill("不存在");
  await page
    .getByRole("combobox", { name: "题材", exact: true })
    .selectOption("奇幻");
  await page
    .getByRole("combobox", { name: "年龄层", exact: true })
    .selectOption("青年");
  await expect(page.getByText(/没有匹配的角色/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "创建第一个角色" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(page.getByLabel("名称", { exact: true })).toHaveValue("");
  await expect(
    page.getByRole("combobox", { name: "题材", exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("combobox", { name: "年龄层", exact: true }),
  ).toHaveValue("");
  await expect(page.locator(".asset-card")).toHaveCount(1);
});

test("pagination retries its original cursor and cannot append to a newer filter", async ({
  page,
}) => {
  for (let index = 0; index < 41; index++) {
    await f.store.commit(
      entity("character", {
        name: `林舟${String(index).padStart(3, "0")}`,
        markdown: "守护灯塔的记录员。",
        genres: [],
        ageBand: "",
        sourceMetadata: {},
      }),
      null,
    );
  }
  const cursors: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/library?**", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    if (!cursor) return route.continue();
    cursors.push(cursor);
    if (cursors.length === 1)
      return route.fulfill({ status: 503, json: { error: "分页暂不可用" } });
    const response = await route.fetch();
    await pending;
    await route.fulfill({ response });
  });
  await page.goto(`${f.address}/#library/character`);
  await page.getByRole("button", { name: "使用 Microsoft 账号登录" }).click();
  await expect(page.locator(".asset-card")).toHaveCount(40);
  await page.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.locator(".asset-card")).toHaveCount(40);
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "加载更多", exact: true }),
  ).toBeDisabled();
  await expect.poll(() => cursors.length).toBe(2);
  expect(cursors[1]).toBe(cursors[0]);
  await page.getByLabel("名称", { exact: true }).fill("林舟000");
  await expect(page.locator(".asset-card")).toHaveCount(1);
  await expect(page.locator(".asset-card h2")).toHaveText("林舟000");
  const staleResponse = page.waitForResponse((response) =>
    new URL(response.url()).searchParams.has("cursor"),
  );
  release();
  await (await staleResponse).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.locator(".asset-card")).toHaveCount(1);
  await expect(page.locator(".asset-card h2")).toHaveText("林舟000");
});
