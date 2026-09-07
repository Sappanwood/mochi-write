import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { registerBusiness } from "../src/server/routes.js";
import { MemoryStore } from "./support/memory-store.js";
import { readBundle } from "../src/server/filesystem.js";
const config = loadConfig({
  ENTRA_TENANT_ID: "11111111-1111-4111-8111-111111111111",
  ENTRA_OWNER_OID: "22222222-2222-4222-8222-222222222222",
  ENTRA_SPA_CLIENT_ID: "33333333-3333-4333-8333-333333333333",
  ENTRA_API_CLIENT_ID: "44444444-4444-4444-8444-444444444444",
  APP_ORIGIN: "http://127.0.0.1:18080",
  COSMOS_ENDPOINT: "https://example.documents.azure.com/",
});
const headers = { authorization: "Bearer fixture", origin: config.origin };
const content = {
  name: "新角色",
  markdown: "正文",
  genres: ["奇幻"],
  ageBand: "成年",
  sourceMetadata: { custom: "保留" },
};
const apps: FastifyInstance[] = [];
async function setup() {
  const store = new MemoryStore();
  const app = await createApp({
    config,
    verify: async (h) => {
      if (h !== "Bearer fixture") throw new Error();
    },
    checkStorage: async () => {},
  });
  registerBusiness(app, store);
  apps.push(app);
  return { app, store };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
describe("business API", () => {
  it("validates asset edits and returns 409 for stale revisions, 503 for failed saves", async () => {
    const { app, store } = await setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/library",
      headers,
      payload: { kind: "character", content },
    });
    expect(created.statusCode).toBe(201);
    const doc = created.json();
    const url = `/api/library/${doc.id}`;
    const bad = await app.inject({
      method: "PUT",
      url,
      headers,
      payload: {
        revision: doc.revision,
        content: { ...content, genres: ["未知"] },
      },
    });
    expect(bad.statusCode).toBe(400);
    const saved = await app.inject({
      method: "PUT",
      url,
      headers,
      payload: {
        revision: doc.revision,
        content: { ...content, name: "已更新" },
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "PUT",
          url,
          headers,
          payload: { revision: doc.revision, content },
        })
      ).statusCode,
    ).toBe(409);
    store.failNext = true;
    expect(
      (
        await app.inject({
          method: "PUT",
          url,
          headers,
          payload: { revision: saved.json().revision, content },
        })
      ).statusCode,
    ).toBe(503);
    expect((await app.inject({ url, headers })).json().content.name).toBe(
      "已更新",
    );
  });
  it("serves ordered story content after import and supports export", async () => {
    const { app } = await setup();
    const files = await readBundle("tests/fixtures/novel");
    const imported = await app.inject({
      method: "POST",
      url: "/api/import",
      headers,
      payload: { files, batchId: randomUUID() },
    });
    expect(imported.statusCode).toBe(200);
    const stories = (await app.inject({ url: "/api/stories", headers })).json();
    expect(stories.items).toHaveLength(1);
    const story = stories.items[0];
    const chapters = (
      await app.inject({
        url: `/api/stories/${story.id}/documents?kind=chapter`,
        headers,
      })
    ).json();
    expect(chapters.items).toHaveLength(2);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/export",
          headers,
          payload: {},
        })
      )
        .json()
        .files.some((f: { path: string }) => f.path === "manifest.json"),
    ).toBe(true);
    expect(
      (
        await app.inject({
          url: `/api/stories/${randomUUID()}/documents/${chapters.items[0].id}`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
  });
  it("rejects anonymous business access and malformed inputs", async () => {
    const { app } = await setup();
    for (const url of ["/api/library", "/api/stories", "/api/vocabulary"])
      expect((await app.inject(url)).statusCode).toBe(401);
    expect(
      (await app.inject({ url: "/api/library?limit=10000", headers }))
        .statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ url: "/api/library/not-a-uuid", headers }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/import",
          headers,
          payload: { files: [], batchId: "test" },
        })
      ).statusCode,
    ).toBe(400);
  });
});
