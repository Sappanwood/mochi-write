import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { registerCreative } from "../src/server/creative-routes.js";
import type { Creative } from "../src/server/creative.js";
const config = loadConfig({
  ENTRA_TENANT_ID: randomUUID(),
  ENTRA_OWNER_OID: randomUUID(),
  ENTRA_SPA_CLIENT_ID: randomUUID(),
  ENTRA_API_CLIENT_ID: randomUUID(),
  APP_ORIGIN: "http://localhost:18080",
  COSMOS_ENDPOINT: "https://example.documents.azure.com",
});
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function fixture() {
  const app = await createApp({
    config,
    checkStorage: async () => {},
    verify: async (h) => {
      if (h !== "Bearer person") throw Error();
    },
  });
  apps.push(app);
  const storyId = randomUUID(),
    id = randomUUID(),
    conversationId = randomUUID();
  const task = {
    id,
    storyId,
    conversationId,
    message: "给我看看",
    status: "running",
    output: "",
    sources: [],
    artifacts: [],
    authorization: { id: "private-grant", status: "active" },
    intentEvidence: { text: "raw evidence" },
    sourceHash: "private",
    operationId: "private-op",
  };
  const service = {
    submit: vi.fn(async () => task),
    task: vi.fn(async () => task),
    tasks: vi.fn(async () => [task]),
    cancel: vi.fn(async () => task),
    drafts: vi.fn(async () => []),
    createConversation: vi.fn(async () => ({ id: conversationId })),
    conversations: vi.fn(async () => []),
  };
  registerCreative(app, service as unknown as Creative);
  const base = `/api/stories/${storyId}/creative`;
  const headers = { authorization: "Bearer person", origin: config.origin };
  const input = {
    conversationId,
    clientRequestId: id,
    message: "给我看看",
    provider: "deepseek",
    model: "model",
  };
  return { app, base, headers, input, service, id };
}
it("rejects browser authorization claims and invalid identities before dispatch", async () => {
  const f = await fixture();
  for (const extra of [
    { authorized: true },
    { authorizationId: "grant" },
    { operationId: "op" },
    { target: "chapter" },
  ]) {
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: f.base + "/tasks",
          headers: f.headers,
          payload: { ...f.input, ...extra },
        })
      ).statusCode,
    ).toBe(400);
  }
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: f.base + "/tasks",
        headers: f.headers,
        payload: { ...f.input, clientRequestId: "invalid" },
      })
    ).statusCode,
  ).toBe(400);
  expect(f.service.submit).not.toHaveBeenCalled();
});
it("protects reads and mutations and returns a task without backend authority fields", async () => {
  const f = await fixture();
  expect(
    (await f.app.inject({ url: f.base + `/tasks/${f.id}` })).statusCode,
  ).toBe(401);
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: f.base + "/tasks",
        headers: {
          authorization: "Bearer person",
          origin: "https://other.example",
        },
        payload: f.input,
      })
    ).statusCode,
  ).toBe(403);
  const result = await f.app.inject({
    method: "POST",
    url: f.base + "/tasks",
    headers: f.headers,
    payload: f.input,
  });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({ id: f.id, status: "running" });
  for (const key of [
    "authorization",
    "operationId",
    "sourceHash",
    "intentEvidence",
  ])
    expect(result.json()).not.toHaveProperty(key);
  const before = f.service.submit.mock.calls.length;
  await f.app.inject({ url: f.base + `/tasks/${f.id}`, headers: f.headers });
  expect(f.service.submit).toHaveBeenCalledTimes(before);
});
