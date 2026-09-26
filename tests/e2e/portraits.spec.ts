import { test, expect } from "@playwright/test";
import sharp from "sharp";
import { freeFixture } from "./free-fixture.js";
import { entity } from "../../src/server/entities.js";
let f: Awaited<ReturnType<typeof freeFixture>>;
test.afterEach(async () => {
  await f?.close();
});

test("pastes a clipboard image into cropping, saves it and preserves normal prompt pasting", async ({
  page,
  context,
}) => {
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
      name: "剪贴板测试",
      markdown: "合成测试角色",
      genres: [],
      ageBand: "",
      sourceMetadata: {},
    }),
    null,
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`${f.address}/#asset/${doc.id}`);
  await page.getByRole("button", { name: "使用 Microsoft 账号登录" }).click();
  await page.getByText("头像与提示词", { exact: true }).click();
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 160;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#4488aa";
    ctx.fillRect(0, 0, 120, 160);
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b!), "image/png"),
    );
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  });
  const paste = page.getByRole("button", { name: "粘贴头像图片", exact: true });
  await paste.click();
  await page.keyboard.press("ControlOrMeta+V");
  await expect(page.getByLabel("头像裁剪预览")).toBeVisible();
  expect(values.size).toBe(0);
  expect((await f.store.get(doc.id, null))?.portrait).toBeUndefined();
  await page.getByRole("button", { name: "使用此裁剪" }).click();
  await expect(
    page.getByRole("img", { name: "剪贴板测试的头像" }),
  ).toBeVisible();
  await page.evaluate(() =>
    navigator.clipboard.writeText("生活氛围，窗边阅读"),
  );
  await page.getByLabel("采用的生图提示词").focus();
  await page.keyboard.press("ControlOrMeta+V");
  await expect(page.getByLabel("采用的生图提示词")).toHaveValue(
    "生活氛围，窗边阅读",
  );
  await page.getByRole("button", { name: "保存头像与提示词" }).click();
  await expect(
    page.getByText("头像与提示词已保存", { exact: true }),
  ).toBeVisible();
  const saved = (await f.store.get(doc.id, null))!;
  expect(saved.portrait?.prompt).toBe("生活氛围，窗边阅读");
  expect(
    await sharp(values.get(saved.portrait!.imageId!)!).metadata(),
  ).toMatchObject({ width: 768, height: 1024 });
  await page.reload();
  await expect(
    page.getByRole("img", { name: "剪贴板测试的头像" }),
  ).toBeVisible();
});

test("clipboard input rejects non-images, unsupported types and oversized files without uploading", async ({
  page,
}) => {
  f = await freeFixture();
  const doc = await f.store.commit(
    entity("character", {
      name: "无效剪贴板",
      markdown: "合成测试角色",
      genres: [],
      ageBand: "",
      sourceMetadata: {},
    }),
    null,
  );
  await page.goto(`${f.address}/#asset/${doc.id}`);
  await page.getByRole("button", { name: "使用 Microsoft 账号登录" }).click();
  await page.getByText("头像与提示词", { exact: true }).click();
  const paste = page.getByRole("button", { name: "粘贴头像图片", exact: true });
  for (const [type, size, message] of [
    ["text/plain", 0, "剪贴板中没有图片"],
    ["image/gif", 10, "PNG、JPEG 或 WebP"],
    ["image/png", 8 * 1024 * 1024 + 1, "不超过 8 MiB"],
  ] as const) {
    await paste.evaluate(
      (element, { type, size }) => {
        const data = new DataTransfer();
        if (size)
          data.items.add(
            new File([new Uint8Array(size)], "clipboard", { type }),
          );
        else data.setData(type, "https://example.com/picture.png");
        element.dispatchEvent(
          new ClipboardEvent("paste", {
            clipboardData: data,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      { type, size },
    );
    await expect(page.getByRole("alert")).toContainText(message);
    await expect(page.getByLabel("头像裁剪预览")).toHaveCount(0);
  }
  expect((await f.store.get(doc.id, null))?.portrait).toBeUndefined();
});

test("crops landscape and tall images without stretching and supports edge positioning", async ({
  page,
}) => {
  f = await freeFixture();
  const doc = await f.store.commit(
    entity("character", {
      name: "裁剪测试",
      markdown: "测试角色",
      genres: [],
      ageBand: "",
      sourceMetadata: {},
    }),
    null,
  );
  await page.goto(`${f.address}/#asset/${doc.id}`);
  await page.getByRole("button", { name: "使用 Microsoft 账号登录" }).click();
  await page.getByText("头像与提示词", { exact: true }).click();
  for (const [width, height, center, edge] of [
    [240, 160, [120, 80], [210, 40]],
    [120, 240, [60, 120], [90, 40]],
  ] as const) {
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 3;
        pixels[offset] = x;
        pixels[offset + 1] = y;
        pixels[offset + 2] = 100;
      }
    }
    await page.getByLabel("上传头像").setInputFiles({
      name: "coordinates.png",
      mimeType: "image/png",
      buffer: await sharp(pixels, { raw: { width, height, channels: 3 } })
        .png()
        .toBuffer(),
    });
    const canvas = page.getByLabel("头像裁剪预览");
    await expect(canvas).toBeVisible();
    const sample = () =>
      canvas.evaluate((element) => {
        const c = element as HTMLCanvasElement;
        const ctx = c.getContext("2d")!;
        const middle = ctx.getImageData(c.width / 2, c.height / 2, 1, 1).data;
        const offset = ctx.getImageData(
          c.width / 2 + 96,
          c.height / 2 + 96,
          1,
          1,
        ).data;
        return {
          x: middle[0]!,
          y: middle[1]!,
          dx: offset[0]! - middle[0]!,
          dy: offset[1]! - middle[1]!,
        };
      });
    await expect
      .poll(async () => {
        const point = await sample();
        return (
          Math.abs(point.x - center[0]) <= 1 &&
          Math.abs(point.y - center[1]) <= 1 &&
          Math.abs(point.dx - point.dy) <= 1
        );
      })
      .toBe(true);
    await page.getByLabel("缩放", { exact: true }).fill("2");
    await page.getByLabel("水平位置").fill("100");
    await page.getByLabel("垂直位置").fill("0");
    await expect
      .poll(async () => {
        const point = await sample();
        return (
          Math.abs(point.x - edge[0]) <= 1 &&
          Math.abs(point.y - edge[1]) <= 1 &&
          Math.abs(point.dx - point.dy) <= 1
        );
      })
      .toBe(true);
    await page.getByRole("button", { name: "取消裁剪" }).click();
  }
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
  await expect(page.getByLabel("头像裁剪预览")).toHaveAttribute("width", "768");
  await expect(page.getByLabel("头像裁剪预览")).toHaveAttribute(
    "height",
    "1024",
  );
  await page.getByLabel("缩放", { exact: true }).fill("1.5");
  await page.getByRole("button", { name: "使用此裁剪" }).click();
  await expect(page.getByRole("img", { name: "银发旅人的头像" })).toBeVisible();
  await page.getByRole("button", { name: "保存头像与提示词" }).click();
  await expect(
    page.getByText("头像与提示词已保存", { exact: true }),
  ).toBeVisible();
  let saved = (await f.store.get(doc.id, null))!;
  expect(saved.portrait?.imageId).toBeTruthy();
  expect(
    await sharp(values.get(saved.portrait!.imageId!)!).metadata(),
  ).toMatchObject({ width: 768, height: 1024 });
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
  await expect(page.getByLabel("下一条消息")).toHaveValue(/3:4/);
  await expect(page.getByLabel("下一条消息")).toHaveValue(/生活.*学习.*工作/);
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
