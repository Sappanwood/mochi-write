import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { registerCreative } from "../src/server/creative-routes.js";
import { Creative } from "../src/server/creative.js";
import { MemoryStore } from "./support/memory-store.js";
import { MemoryCreativeStore } from "./support/creative-store.js";
import { FakeCreativeMochi } from "./support/creative-mochi.js";
it("recovers a lost first response by request key without POST or disclosure to service identities", async () => {
  const config = loadConfig({
    ENTRA_TENANT_ID: randomUUID(),
    ENTRA_OWNER_OID: randomUUID(),
    ENTRA_SPA_CLIENT_ID: randomUUID(),
    ENTRA_API_CLIENT_ID: randomUUID(),
    APP_ORIGIN: "http://localhost:18080",
    COSMOS_ENDPOINT: "https://example.documents.azure.com",
  });
  const app = await createApp({
    config,
    checkStorage: async () => {},
    verify: async (h) => {
      if (h !== "Bearer person") throw Error();
    },
  });
  const content = new MemoryStore(),
    records = new MemoryCreativeStore(content),
    mochi = new FakeCreativeMochi();
  mochi.holdIntent = true;
  const host = new Creative(content, records, mochi, { pollMs: 5 });
  registerCreative(app, host);
  const headers = { authorization: "Bearer person", origin: config.origin },
    base = "/api/creative/conversations",
    input = {
      clientRequestId: randomUUID(),
      message: "先讨论",
      provider: "deepseek",
      model: "test",
    };
  try {
    const first = await app.inject({
      method: "POST",
      url: base,
      headers,
      payload: input,
    });
    expect(first.statusCode).toBe(200);
    const url = base + "/by-request/" + input.clientRequestId;
    expect(
      (await app.inject({ url, headers: { authorization: "Bearer service" } }))
        .statusCode,
    ).toBe(401);
    const calls = mochi.creativePosts().length;
    const restored = await app.inject({ url, headers });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({
      conversation: { id: first.json().conversation.id },
      task: { id: input.clientRequestId },
    });
    expect(restored.json().task).not.toHaveProperty("authorization");
    expect(mochi.creativePosts()).toHaveLength(calls);
    expect(
      (await app.inject({ url: base + "/by-request/" + randomUUID(), headers }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: base,
          headers,
          payload: { ...input, storyId: randomUUID() },
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await host.close();
    await app.close();
  }
});
