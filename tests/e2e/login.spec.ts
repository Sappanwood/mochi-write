import { resolve } from "node:path";
import { test, expect } from "@playwright/test";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { createApp } from "../../src/server/app.js";
import { loadConfig } from "../../src/server/config.js";

let server: FastifyInstance;
let address: string;
test.beforeAll(async () => {
  server = await createApp({
    config: loadConfig({
      ENTRA_TENANT_ID: "11111111-1111-4111-8111-111111111111",
      ENTRA_OWNER_OID: "22222222-2222-4222-8222-222222222222",
      ENTRA_SPA_CLIENT_ID: "33333333-3333-4333-8333-333333333333",
      ENTRA_API_CLIENT_ID: "44444444-4444-4444-8444-444444444444",
      APP_ORIGIN: "http://127.0.0.1:18080",
      COSMOS_ENDPOINT: "https://example.documents.azure.com/",
    }),
    checkStorage: async () => {},
  });
  await server.register(fastifyStatic, {
    root: resolve("dist/web"),
    wildcard: false,
  });
  address = await server.listen({ host: "127.0.0.1", port: 0 });
});
test.afterAll(async () => {
  await server?.close();
});

test("anonymous login shell renders and private API rejects access", async ({
  page,
  request,
}) => {
  await page.goto(address);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "让人物与世界",
  );
  await expect(
    page.getByRole("button", { name: "使用 Microsoft 账号登录" }),
  ).toBeEnabled();
  expect((await request.get(`${address}/api/session`)).status()).toBe(401);
});
test("login configuration failure is visible", async ({ page }) => {
  await page.route("**/api/auth-config", (route) =>
    route.fulfill({ status: 503, body: "{}" }),
  );
  await page.goto(address);
  await expect(page.getByRole("alert")).toContainText("登录服务暂不可用");
  await expect(page.getByRole("button")).toBeDisabled();
});
test("mobile login shell fits the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(address);
  await expect(page.getByRole("button")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("serves the isolated redirect bridge without a COOP header", async ({
  request,
}) => {
  const response = await request.get(`${address}/redirect.html`);
  expect(response.status()).toBe(200);
  expect(response.headers()["cross-origin-opener-policy"]).toBeUndefined();
  expect(await response.text()).not.toContain('id="root"');
});
