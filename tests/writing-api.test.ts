import { afterEach, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { registerWriting } from "../src/server/writing-routes.js";
import { Writing } from "../src/server/writing.js";
import { MemoryStore } from "./support/memory-store.js";
import { MemoryWritingStore } from "./support/writing-store.js";
import { FakeMochi } from "./support/fake-mochi.js";
const config = loadConfig({
  ENTRA_TENANT_ID: "11111111-1111-4111-8111-111111111111",
  ENTRA_OWNER_OID: "22222222-2222-4222-8222-222222222222",
  ENTRA_SPA_CLIENT_ID: "33333333-3333-4333-8333-333333333333",
  ENTRA_API_CLIENT_ID: "44444444-4444-4444-8444-444444444444",
  APP_ORIGIN: "http://127.0.0.1:18080",
  COSMOS_ENDPOINT: "https://example.documents.azure.com/",
});
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
async function setup() {
  const store = new MemoryStore();
  const app = await createApp({
    config,
    checkStorage: async () => {},
    verify: async (h) => {
      if (h !== "Bearer fixture") throw Error();
    },
  });
  registerWriting(
    app,
    new Writing(store, new MemoryWritingStore(store), new FakeMochi()),
  );
  apps.push(app);
  return app;
}
test("writing endpoints reject anonymous and cross-origin writes before reading input", async () => {
  const app = await setup();
  for (const url of [
    "/api/writing/models",
    "/api/writing/conversations?type=library&id=library",
    "/api/writing/drafts/11111111-1111-4111-8111-111111111111?type=library&id=library",
  ])
    expect((await app.inject({ url })).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/writing/conversations",
        headers: {
          authorization: "Bearer fixture",
          origin: "https://other.example",
        },
        payload: { type: "library", id: "library" },
      })
    ).statusCode,
  ).toBe(403);
});
test("scope/session mapping rejects foreign history and strict schemas reject unknown authorization fields", async () => {
  const app = await setup();
  const headers = { authorization: "Bearer fixture", origin: config.origin };
  const c = await app.inject({
    method: "POST",
    url: "/api/writing/conversations",
    headers,
    payload: { type: "library", id: "library" },
  });
  expect(c.statusCode).toBe(200);
  expect(
    (
      await app.inject({
        url: "/api/writing/history?type=library&id=library&conversationId=11111111-1111-4111-8111-111111111111",
        headers,
      })
    ).statusCode,
  ).toBe(404);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/writing/conversations",
        headers,
        payload: { type: "library", id: "library", app_id: "other" },
      })
    ).statusCode,
  ).toBe(400);
});
