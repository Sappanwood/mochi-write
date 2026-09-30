import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { registerBusiness } from "../src/server/routes.js";
import { MemoryStore } from "./support/memory-store.js";
import { readBundle } from "../src/server/filesystem.js";
import { importFiles } from "../src/server/import.js";
import { Library } from "../src/server/library.js";
import { FreeSession } from "../src/server/free-session.js";
import { MemoryFreeStore } from "./support/free-store.js";
import { resolveReference } from "../src/server/free-discovery.js";
import { freeDigest } from "../src/server/free-references.js";
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
  async function deletionFixture() {
    const f = await setup();
    await importFiles(
      f.store,
      await readBundle("tests/fixtures/novel"),
      randomUUID(),
    );
    const story = (await f.store.list({ kind: "story" })).items[0]!;
    return { ...f, story };
  }
  it("soft-deletes a story, excludes its whole contents from reading/export, and retains masters and history", async () => {
    const { app, store, story } = await deletionFixture();
    const docs = (await store.list({ projectId: story.id })).items;
    const masters = (await store.list({ projectId: null })).items;
    const url = `/api/stories/${story.id}`;
    expect(
      (
        await app.inject({
          method: "DELETE",
          url,
          headers,
          payload: { revision: story.revision },
        })
      ).statusCode,
    ).toBe(204);
    expect(await store.get(story.id, story.id)).toMatchObject({
      deleted: true,
      currentVersion: 2,
    });
    expect(await store.getVersion(story.id, story.id, 1)).toMatchObject({
      content: story.content,
    });
    expect(
      (await app.inject({ url: "/api/stories", headers })).json().items,
    ).toEqual([]);
    for (const path of [
      url,
      `${url}/documents?kind=chapter`,
      `${url}/documents/${docs.find((d) => d.kind === "chapter")!.id}`,
    ])
      expect((await app.inject({ url: path, headers })).statusCode).toBe(404);
    for (const doc of docs.filter((d) => d.kind !== "story"))
      expect(await store.get(doc.id, story.id)).toEqual(doc);
    expect((await store.list({ projectId: null })).items).toEqual(masters);
    const exported = (
      await app.inject({
        method: "POST",
        url: "/api/export",
        headers,
        payload: {},
      })
    ).json().files;
    expect(
      exported.some((f: { path: string }) => f.path.startsWith("projects/")),
    ).toBe(false);
    const master = masters.find((d) => d.kind === "character")!;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${url}/snapshots`,
          headers,
          payload: { assetId: master.id, requestId: randomUUID() },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url,
          headers,
          payload: { revision: story.revision },
        })
      ).statusCode,
    ).toBe(404);
  });
  it("protects story deletion with identity, origin, revision and ready scope, and leaves data intact on failure", async () => {
    const { app, store, story } = await deletionFixture();
    const url = `/api/stories/${story.id}`;
    for (const [requestHeaders, payload, status] of [
      [{}, { revision: story.revision }, 401],
      [
        { ...headers, origin: "https://elsewhere.example" },
        { revision: story.revision },
        403,
      ],
      [headers, {}, 400],
      [headers, { revision: "stale" }, 409],
      [headers, { revision: story.revision, cascade: true }, 400],
    ] as const) {
      expect(
        (
          await app.inject({
            method: "DELETE",
            url,
            headers: requestHeaders,
            payload,
          })
        ).statusCode,
      ).toBe(status);
      expect(await store.get(story.id, story.id)).toEqual(story);
    }
    store.failNext = true;
    expect(
      (
        await app.inject({
          method: "DELETE",
          url,
          headers,
          payload: { revision: story.revision },
        })
      ).statusCode,
    ).toBe(503);
    expect(await store.get(story.id, story.id)).toEqual(story);
    store.heads.set(`${story.id}:${story.id}`, {
      ...story,
      status: "building",
    });
    expect(
      (
        await app.inject({
          method: "DELETE",
          url,
          headers,
          payload: { revision: story.revision },
        })
      ).statusCode,
    ).toBe(404);
  });
  it("allows only one concurrent story edit or deletion to commit", async () => {
    const { app, store, story } = await deletionFixture();
    const results = await Promise.all([
      app.inject({
        method: "DELETE",
        url: `/api/stories/${story.id}`,
        headers,
        payload: { revision: story.revision },
      }),
      app.inject({
        method: "PUT",
        url: `/api/stories/${story.id}/guidance`,
        headers,
        payload: { revision: story.revision, text: "新指引" },
      }),
    ]);
    expect(results.filter((r) => r.statusCode < 300)).toHaveLength(1);
    expect([404, 409]).toContain(
      results.find((r) => r.statusCode >= 300)!.statusCode,
    );
    expect((await store.get(story.id, story.id))!.currentVersion).toBe(2);
  });
  it("rejects new references to deleted story contents while preserving previously recorded exact sources", async () => {
    const { app, store, story } = await deletionFixture();
    const records = new MemoryFreeStore();
    const free = new FreeSession(
      store,
      records,
      {
        async request() {
          throw Error("No model calls");
        },
      },
      { autoStart: false },
    );
    const chapter = (await store.list({ kind: "chapter", projectId: story.id }))
      .items[0]!;
    const ref = {
      type: "asset" as const,
      kind: "chapter" as const,
      asset_id: chapter.id,
      story_id: story.id,
      revision: chapter.revision,
      version: chapter.currentVersion,
      content_hash: freeDigest(chapter.content),
    };
    const selection = {
      type: ref.type,
      kind: ref.kind,
      asset_id: ref.asset_id,
      story_id: ref.story_id,
      revision: ref.revision,
      version: ref.version,
    };
    const conversationId = randomUUID();
    await records.transaction("library", [
      {
        record: free.references.source(
          conversationId,
          randomUUID(),
          ref,
          "agent_read",
        ),
        revision: null,
      },
    ]);
    await app.inject({
      method: "DELETE",
      url: `/api/stories/${story.id}`,
      headers,
      payload: { revision: story.revision },
    });
    await expect(resolveReference(free, null, selection)).rejects.toMatchObject(
      { statusCode: 404 },
    );
    await expect(free.references.read(randomUUID(), ref)).rejects.toMatchObject(
      { statusCode: 404 },
    );
    expect(await free.references.read(conversationId, ref)).toEqual({
      content: chapter.content,
    });
  });
  it.each(["character", "world"] as const)(
    "deletes %s masters without changing independent story snapshots",
    async (kind) => {
      const { app, store, story } = await deletionFixture();
      const master = (await store.list({ kind, projectId: null })).items[0]!;
      const snapshot = await new Library(store).addSnapshot(
        story.id,
        master.id,
        randomUUID(),
      );
      const url = `/api/library/${master.id}`;
      expect(
        (
          await app.inject({
            method: "DELETE",
            url,
            headers,
            payload: { revision: "stale" },
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: "DELETE",
            url,
            headers,
            payload: { revision: master.revision },
          })
        ).statusCode,
      ).toBe(204);
      expect((await app.inject({ url, headers })).statusCode).toBe(404);
      expect((await store.list({ kind, projectId: null })).items).toEqual([]);
      expect(await store.get(snapshot.id, story.id)).toEqual(snapshot);
    },
  );
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
