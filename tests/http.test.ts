import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";

const config = loadConfig({
  ENTRA_TENANT_ID: "11111111-1111-4111-8111-111111111111",
  ENTRA_OWNER_OID: "22222222-2222-4222-8222-222222222222",
  ENTRA_SPA_CLIENT_ID: "33333333-3333-4333-8333-333333333333",
  ENTRA_API_CLIENT_ID: "44444444-4444-4444-8444-444444444444",
  APP_ORIGIN: "http://127.0.0.1:18080",
  COSMOS_ENDPOINT: "https://example.documents.azure.com/",
});
const apps: FastifyInstance[] = [];
async function app(ready = true) {
  const server = await createApp({
    config,
    verify: async (header) => {
      if (header !== "Bearer fixture") throw new Error("private-token-details");
    },
    checkStorage: async () => {
      if (!ready) throw new Error("private-database-details");
    },
  });
  server.get("/api/test", () => ({ content: "private content" }));
  server.post("/api/test", () => ({ saved: true }));
  apps.push(server);
  return server;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((server) => server.close()));
});

describe("HTTP access boundary", () => {
  it("allows only non-sensitive auth config and health without authentication", async () => {
    const server = await app();
    const response = await server.inject("/api/auth-config");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      tenantId: config.auth.tenantId,
      spaClientId: config.auth.spaClientId,
      scope: `api://${config.auth.apiClientId}/Write.Access`,
    });
    expect((await server.inject("/health/live")).statusCode).toBe(200);
    expect((await server.inject("/health/ready")).statusCode).toBe(200);
  });
  it("rejects unauthenticated and identity-header requests without exposing errors", async () => {
    const server = await app();
    for (const headers of [
      {},
      { "x-user-oid": config.auth.ownerOid },
      { authorization: "Bearer invalid" },
    ]) {
      const response = await server.inject({ url: "/api/test", headers });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain("private");
    }
  });
  it("requires JSON and a matching Origin for mutations", async () => {
    const server = await app();
    for (const origin of [undefined, "https://attacker.example", "null"]) {
      const response = await server.inject({
        method: "POST",
        url: "/api/test",
        payload: {},
        headers: {
          authorization: "Bearer fixture",
          ...(origin ? { origin } : {}),
        },
      });
      expect(response.statusCode).toBe(403);
    }
    const badType = await server.inject({
      method: "POST",
      url: "/api/test",
      payload: "text",
      headers: {
        authorization: "Bearer fixture",
        origin: config.origin,
        "content-type": "text/plain",
      },
    });
    expect(badType.statusCode).toBe(415);
    const good = await server.inject({
      method: "POST",
      url: "/api/test",
      payload: {},
      headers: { authorization: "Bearer fixture", origin: config.origin },
    });
    expect(good.statusCode).toBe(200);
  });
  it("sets no-store and avoids cross-origin access headers on private data", async () => {
    const response = await (
      await app()
    ).inject({
      url: "/api/test",
      headers: { authorization: "Bearer fixture" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
  it("reports storage unavailability without disclosing database details", async () => {
    const server = await app(false);
    expect((await server.inject("/health/live")).statusCode).toBe(200);
    const response = await server.inject("/health/ready");
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("private");
  });
});
