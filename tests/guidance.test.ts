import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { registerBusiness } from "../src/server/routes.js";
import { entity } from "../src/server/entities.js";
import { exportFiles } from "../src/server/export.js";
import { importFiles } from "../src/server/import.js";
import { MemoryStore } from "./support/memory-store.js";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function fixture() {
  const store = new MemoryStore();
  const id = randomUUID();
  const story = await store.commit(
    {
      ...entity(
        "story",
        {
          name: "灯塔",
          markdown: "故事简介",
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
  const origin = "http://localhost:18080";
  const app = await createApp({
    config: loadConfig({
      ENTRA_TENANT_ID: randomUUID(),
      ENTRA_OWNER_OID: randomUUID(),
      ENTRA_SPA_CLIENT_ID: randomUUID(),
      ENTRA_API_CLIENT_ID: randomUUID(),
      APP_ORIGIN: origin,
      COSMOS_ENDPOINT: "https://example.documents.azure.com",
    }),
    checkStorage: async () => {},
    verify: async (header) => {
      if (header !== "Bearer person") throw Error();
    },
  });
  apps.push(app);
  registerBusiness(app, store);
  const headers = { authorization: "Bearer person", origin };
  const url = `/api/stories/${id}/guidance`;
  const save = (text: string, revision = story.revision) =>
    app.inject({ method: "PUT", url, headers, payload: { text, revision } });
  return { store, app, story, headers, url, save };
}

it("persists story guidance separately, versions edits and round-trips through export", async () => {
  const f = await fixture();
  const response = await f.save("  慢热，不提前揭晓身份。\n少用旁白。  ");
  expect(response.statusCode).toBe(200);
  const saved = response.json();
  expect(saved.guidance).toBe("慢热，不提前揭晓身份。\n少用旁白。");
  expect(saved.content).toEqual(f.story.content);
  expect(saved.currentVersion).toBe(2);
  expect(
    await f.store.getVersion(f.story.id, f.story.id, 1),
  ).not.toHaveProperty("guidance");
  const read = await f.app.inject({
    url: `/api/stories/${f.story.id}`,
    headers: f.headers,
  });
  expect(read.json().guidance).toBe(saved.guidance);
  const restored = new MemoryStore();
  await importFiles(restored, await exportFiles(f.store), "guidance-roundtrip");
  expect(await restored.get(f.story.id, f.story.id)).toMatchObject({
    guidance: saved.guidance,
  });
  const cleared = await f.save("", saved.revision);
  expect(cleared.statusCode).toBe(200);
  expect(cleared.json().guidance).toBe("");
});

it("rejects stale revisions and concurrent overwrites without changing the winner", async () => {
  const f = await fixture();
  const responses = await Promise.all([f.save("第一份"), f.save("第二份")]);
  expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  const winner = responses.find((r) => r.statusCode === 200)!.json();
  expect((await f.save("覆盖旧版")).statusCode).toBe(409);
  expect(await f.store.get(f.story.id, f.story.id)).toMatchObject({
    guidance: winner.guidance,
  });
});

it("validates length, access, origin, existence and ready story scope", async () => {
  const f = await fixture();
  expect((await f.save("文".repeat(4001))).statusCode).toBe(400);
  expect(
    (
      await f.app.inject({
        method: "PUT",
        url: f.url,
        payload: { text: "x", revision: f.story.revision },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await f.app.inject({
        method: "PUT",
        url: f.url,
        headers: {
          authorization: "Bearer person",
          origin: "https://elsewhere.example",
        },
        payload: { text: "x", revision: f.story.revision },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await f.app.inject({
        method: "PUT",
        url: `/api/stories/${randomUUID()}/guidance`,
        headers: f.headers,
        payload: { text: "x", revision: f.story.revision },
      })
    ).statusCode,
  ).toBe(404);
  f.store.heads.set(`${f.story.id}:${f.story.id}`, {
    ...f.story,
    deleted: true,
  });
  expect((await f.save("x")).statusCode).toBe(404);
  f.store.heads.set(`${f.story.id}:${f.story.id}`, {
    ...f.story,
    status: "building",
  });
  expect((await f.save("x")).statusCode).toBe(404);
});
