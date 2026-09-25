import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterEach, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { registerBusiness } from "../src/server/routes.js";
import { Library } from "../src/server/library.js";
import { entity } from "../src/server/entities.js";
import { exportFiles } from "../src/server/export.js";
import { importFiles, preflight } from "../src/server/import.js";
import { MemoryStore } from "./support/memory-store.js";

const content = {
  name: "头像角色",
  markdown: "银发，短发。",
  genres: [],
  ageBand: "",
  sourceMetadata: {},
};
const config = loadConfig({
  ENTRA_TENANT_ID: randomUUID(),
  ENTRA_OWNER_OID: randomUUID(),
  ENTRA_SPA_CLIENT_ID: randomUUID(),
  ENTRA_API_CLIENT_ID: randomUUID(),
  APP_ORIGIN: "http://127.0.0.1:18080",
  COSMOS_ENDPOINT: "https://example.documents.azure.com/",
});
const headers = { authorization: "Bearer fixture", origin: config.origin };
const apps: FastifyInstance[] = [];
function images() {
  const values = new Map<string, Buffer>();
  return {
    values,
    async put(id: string, data: Buffer) {
      if (!values.has(id)) values.set(id, data);
    },
    async get(id: string) {
      return values.get(id);
    },
  };
}
async function setup(withImages = true) {
  const store = new MemoryStore(),
    blobs = images();
  const app = await createApp({
    config,
    verify: async (h) => {
      if (h !== headers.authorization) throw new Error();
    },
    checkStorage: async () => {},
  });
  registerBusiness(app, store, withImages ? blobs : undefined);
  apps.push(app);
  const doc = await new Library(store).create("character", content);
  const png = await sharp({
    create: { width: 64, height: 80, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const upload = () =>
    app.inject({
      method: "POST",
      url: "/api/portraits",
      headers,
      payload: { data: png.toString("base64") },
    });
  const save = (revision: string, portrait: unknown) =>
    app.inject({
      method: "PUT",
      url: `/api/library/${doc.id}/portrait`,
      headers,
      payload: { revision, portrait },
    });
  return { app, store, blobs, doc, png, upload, save };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

it("normalizes uploaded images, authenticates reads and updates portraits with CAS", async () => {
  const f = await setup();
  const upload = await f.upload();
  expect(upload.statusCode).toBe(201);
  const { imageId } = upload.json();
  const jpeg = f.blobs.values.get(imageId)!;
  expect(await sharp(jpeg).metadata()).toMatchObject({
    format: "jpeg",
    width: 512,
    height: 512,
  });
  expect((await f.upload()).json().imageId).toBe(imageId);
  const url = `/api/portraits/${imageId}`;
  expect((await f.app.inject(url)).statusCode).toBe(401);
  expect((await f.app.inject({ url, headers })).json().data).toBe(
    jpeg.toString("base64"),
  );
  const portrait = { imageId, prompt: "2.5D，银色短发，固定脸型，头肩肖像。" };
  const saved = await f.save(f.doc.revision, portrait);
  expect(saved.statusCode).toBe(200);
  expect(saved.json().portrait).toEqual(portrait);
  expect(saved.json().content).toEqual(f.doc.content);
  expect((await f.save(f.doc.revision, null)).statusCode).toBe(409);
  const edited = await new Library(f.store).save(
    f.doc.id,
    saved.json().revision,
    { ...f.doc.content, markdown: "新正文" },
  );
  expect(edited.portrait).toEqual(portrait);
  expect(
    (await f.save(edited.revision, { prompt: portrait.prompt })).statusCode,
  ).toBe(200);
  expect((await f.store.getVersion(f.doc.id, null, 2))?.portrait).toEqual(
    portrait,
  );
  expect(f.blobs.values.has(imageId)).toBe(true);
});

it("rejects invalid images, unknown references, world portraits and unsafe writes", async () => {
  const f = await setup();
  for (const data of [
    "not-base64",
    Buffer.from(
      "<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/>",
    ).toString("base64"),
  ]) {
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/portraits",
          headers,
          payload: { data },
        })
      ).statusCode,
    ).toBe(400);
  }
  expect(
    (await f.save(f.doc.revision, { imageId: "a".repeat(64), prompt: "" }))
      .statusCode,
  ).toBe(400);
  expect(
    (
      await f.save(f.doc.revision, {
        imageId: "https://evil/image",
        prompt: "",
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: "/api/portraits",
        headers: { ...headers, origin: "https://evil.example" },
        payload: { data: f.png.toString("base64") },
      })
    ).statusCode,
  ).toBe(403);
  const world = await new Library(f.store).create("world", content);
  expect(
    (
      await f.app.inject({
        method: "PUT",
        url: `/api/library/${world.id}/portrait`,
        headers,
        payload: { revision: world.revision, portrait: { prompt: "" } },
      })
    ).statusCode,
  ).toBe(404);
  expect(f.blobs.values.size).toBe(0);
});

it("keeps prompt editing available without image storage and reports unavailable uploads", async () => {
  const f = await setup(false);
  expect((await f.upload()).statusCode).toBe(503);
  expect((await f.save(f.doc.revision, { prompt: "2.5D" })).statusCode).toBe(
    200,
  );
});

it("freezes portraits in story snapshots and round-trips complete image bundles", async () => {
  const f = await setup();
  const { imageId } = (await f.upload()).json();
  const portrait = { imageId, prompt: "2.5D，银发" };
  const saved = (await f.save(f.doc.revision, portrait)).json();
  const storyId = randomUUID();
  await f.store.commit(
    { ...entity("story", content, storyId, storyId), status: "ready" },
    null,
  );
  const snapshot = await new Library(f.store).addSnapshot(
    storyId,
    f.doc.id,
    randomUUID(),
  );
  expect(snapshot.portrait).toEqual(portrait);
  await f.save(saved.revision, null);
  const bundle = await exportFiles(f.store, f.blobs);
  expect(bundle.filter((v) => v.path.startsWith("portraits/"))).toHaveLength(1);
  const restored = new MemoryStore(),
    target = images();
  await importFiles(restored, bundle, "restore", target);
  expect((await restored.get(snapshot.id, storyId))?.portrait).toEqual(
    portrait,
  );
  expect(target.values.get(imageId)).toEqual(f.blobs.values.get(imageId));
  expect(await importFiles(restored, bundle, "restore", target)).toMatchObject({
    created: 0,
  });
  expect(() =>
    preflight(
      bundle.filter((v) => !v.path.startsWith("portraits/")),
      "missing",
    ),
  ).toThrow();
  const broken = structuredClone(bundle);
  broken.find((v) => v.path.startsWith("portraits/"))!.text = JSON.stringify({
    data: f.png.toString("base64"),
  });
  await expect(
    importFiles(new MemoryStore(), broken, "bad", images()),
  ).rejects.toThrow();
  await expect(exportFiles(f.store)).rejects.toMatchObject({ statusCode: 503 });
});
