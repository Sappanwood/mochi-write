import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { freeFixture } from "./free-fixture.js";
import { entity } from "../../src/server/entities.js";

for (const width of [1280, 390]) {
  test(`removes sessions from recent and associated lists without losing content at ${width}px`, async ({
    page,
  }) => {
    const f = await freeFixture();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      f.free.options.autoStart = false;
      const asset = await f.store.commit(
        entity("character", {
          name: "保留角色",
          markdown: "正式内容保留",
          genres: [],
          ageBand: "",
          sourceMetadata: {},
        }),
        null,
      );
      const { conversation, task } = await f.free.start({
        clientRequestId: randomUUID(),
        message: "待移除的会话",
        provider: "fake",
        model: "fake",
      });
      await f.records.transaction("library", [
        {
          record: {
            ...conversation,
            associatedAssets: [{ kind: "character", asset_id: asset.id }],
          },
          revision: conversation.revision,
        },
      ]);
      await f.free.change(task.id, (t) => {
        t.state = "authorized";
        t.draftContext = { mode: "new_character", baseRevision: null };
      });
      const draft = await f.free.candidates.freeze(
        await f.free.task(task.id),
        {
          artifactKind: "character",
          content: {
            ...asset.content,
            name: "未保存草稿",
            markdown: "草稿内容保留",
          },
        },
        "draft",
      );
      await f.free.change(task.id, (t) => {
        t.state = "succeeded";
        t.output = "讨论内容保留";
      });
      const originalTask = await f.free.task(task.id);
      await page.setViewportSize({ width, height: 844 });
      await page.goto(f.address);
      await page
        .getByRole("button", { name: "使用 Microsoft 账号登录" })
        .click();
      await page.getByRole("link", { name: "最近会话", exact: true }).click();
      const row = page.locator(`[data-session-id="${conversation.id}"]`);
      await expect(row).toContainText("待移除的会话");
      page.once("dialog", async (dialog) => {
        expect(dialog.message()).toContain("聊天、草稿和已保存内容仍保留");
        await dialog.dismiss();
      });
      await row.getByRole("button", { name: "从列表移除" }).click();
      await expect(row).toBeVisible();
      expect(await f.free.conversation(conversation.id)).not.toHaveProperty(
        "hiddenAt",
      );

      const hideUrl = `**/api/creative/free/conversations/${conversation.id}/hide`;
      await page.route(hideUrl, (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "存储暂不可用" }),
        }),
      );
      page.once("dialog", (dialog) => dialog.accept());
      await row.getByRole("button", { name: "从列表移除" }).click();
      await expect(page.getByRole("alert")).toContainText("移除未确认，请重试");
      await expect(row).toBeVisible();
      await page.unroute(hideUrl);
      page.once("dialog", (dialog) => dialog.accept());
      await row.getByRole("button", { name: "从列表移除" }).click();
      await expect(row).toHaveCount(0);
      await page.reload();
      await expect(
        page.getByText("暂无自由会话。发送第一条消息后会出现在这里。"),
      ).toBeVisible();

      await page.getByRole("link", { name: "角色库", exact: true }).click();
      await page.getByRole("button", { name: /保留角色/ }).click();
      await expect(
        page.getByText("正式内容保留", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("region", { name: "角色档案", exact: true })
        .getByText("更多", { exact: true })
        .click();
      await page.getByText("返回已有会话", { exact: true }).click();
      await expect(
        page.getByText("暂无关联自由会话。发送第一条消息后会出现在这里。"),
      ).toBeVisible();
      await page.goto(`${f.address}/#free/conversation/${conversation.id}`);
      await expect(
        page.getByText("讨论内容保留", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: /查看：未保存草稿/ }).click();
      await expect(
        page.getByRole("region", { name: "信息正文" }),
      ).toContainText("草稿内容保留");
      expect(await f.free.candidates.get(conversation.id, draft.id)).toEqual(
        draft,
      );
      expect(await f.store.get(asset.id, null)).toEqual(asset);
      expect(await f.free.task(task.id)).toEqual(originalTask);
      expect(errors).toEqual([]);
    } finally {
      await f.close();
    }
  });
}
