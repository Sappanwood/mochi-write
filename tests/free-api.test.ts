import { it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { registerFree } from "../src/server/free-routes.js";
import { FreeSession } from "../src/server/free-session.js";
import { MemoryStore } from "./support/memory-store.js";
import { MemoryFreeStore } from "./support/free-store.js";
import type { FastifyInstance } from "fastify";
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
async function fixture() {
  const origin = "http://localhost:18080";
  const config = loadConfig({
    ENTRA_TENANT_ID: randomUUID(),
    ENTRA_OWNER_OID: randomUUID(),
    ENTRA_SPA_CLIENT_ID: randomUUID(),
    ENTRA_API_CLIENT_ID: randomUUID(),
    APP_ORIGIN: origin,
    COSMOS_ENDPOINT: "https://example.documents.azure.com",
  });
  const app = await createApp({
    config,
    checkStorage: async () => {},
    verify: async (h) => {
      if (h !== "Bearer person") throw Error();
    },
  });
  apps.push(app);
  const free = new FreeSession(
    new MemoryStore(),
    new MemoryFreeStore(),
    {
      async request() {
        throw Error("No model call");
      },
    },
    { autoStart: false },
  );
  registerFree(app, free);
  return {
    app,
    free,
    headers: { authorization: "Bearer person", origin },
    root: "/api/creative/free",
    input: {
      clientRequestId: randomUUID(),
      message: "讨论角色",
      provider: "fake",
      model: "fake",
    },
  };
}
it("serves the accepted scoped task wire and rejects cross-conversation access", async () => {
  const f = await fixture();
  const { conversation, task } = (
    await f.app.inject({
      method: "POST",
      url: f.root + "/conversations",
      headers: f.headers,
      payload: f.input,
    })
  ).json();
  const get = await f.app.inject({
    url: `${f.root}/conversations/${conversation.id}/tasks/${task.id}`,
    headers: f.headers,
  });
  expect(get.statusCode).toBe(200);
  expect(get.json().task.id).toBe(task.id);
  const descriptor = (
    await f.app.inject({
      url: `${f.root}/conversations/${conversation.id}`,
      headers: f.headers,
    })
  ).json();
  expect(descriptor.conversation.id).toBe(conversation.id);
  expect(
    (
      await f.app.inject({
        url: `${f.root}/conversations/${randomUUID()}/tasks/${task.id}`,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(403);
});
it("cancel stays HTTP202 while original remote stop is unknown", async () => {
  const f = await fixture();
  const { conversation, task } = await f.free.start(f.input);
  await f.free.change(task.id, (t) => {
    t.executionRun = {
      key: "original",
      sessionId: randomUUID(),
      dispatchStarted: true,
      payload: {},
    };
  });
  const response = await f.app.inject({
    method: "POST",
    url: `${f.root}/conversations/${conversation.id}/tasks/${task.id}/cancel`,
    headers: f.headers,
    payload: {},
  });
  expect(response.statusCode).toBe(202);
  expect(response.json().state).toBe("cancel_pending");
});
it("new API rejects authority claims and honors person authentication", async () => {
  const f = await fixture();
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: f.root + "/conversations",
        headers: f.headers,
        payload: {
          ...f.input,
          target: { kind: "character", asset_id: randomUUID() },
        },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await f.app.inject({ url: f.root + "/conversations" })).statusCode,
  ).toBe(401);
});
