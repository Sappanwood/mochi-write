import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import {
  registerAgentTools,
  type ToolTaskContext,
} from "../src/server/tool-routes.js";
import { AssetTools } from "../src/server/asset-tools.js";
import { ToolError, type ToolCallback } from "../src/shared/creative-tools.js";
import { MemoryStore } from "./support/memory-store.js";
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
async function fixture(creation = false) {
  const store = new MemoryStore();
  const app = await createApp({
    config,
    checkStorage: async () => {},
    verify: async (header) => {
      if (header !== "Bearer person") throw new Error();
    },
    verifyTools: async (header) => {
      if (header !== "Bearer service") throw new Error();
      return "mochi-write";
    },
  });
  apps.push(app);
  const context: ToolTaskContext = {
    taskId: "task",
    sessionId: "session",
    storyId: randomUUID(),
    sourceMessageId: "message",
    operationId: "operation",
    recordSource: vi.fn(async () => {}),
    bindRun: vi.fn(async (id: string) => {
      if (id !== "run") throw new ToolError("forbidden_scope");
    }),
  };
  const resolve = vi.fn(async (id: string) =>
    id === context.taskId ? context : undefined,
  );
  const receipt = {
    operation_id: "operation",
    status: "committed" as const,
    story_id: context.storyId,
    chapter_id: randomUUID(),
    revision: "1",
    content_hash: "sha256:abc",
  };
  const createChapter = vi.fn(async () => ({
    data: { chapter_id: receipt.chapter_id },
    receipt,
  }));
  registerAgentTools(app, {
    assets: new AssetTools(store),
    resolveTask: resolve,
    ...(creation
      ? {
          createChapter,
          operation: async (operation_id: string) => ({
            protocol_version: 1 as const,
            operation_id,
            status: "committed" as const,
            receipt,
          }),
        }
      : {}),
  });
  app.post("/api/test-edit", async () => ({ ok: true }));
  const body: ToolCallback = {
    protocol_version: 1,
    app_id: "mochi-write",
    session_id: "session",
    task_id: "task",
    run_id: "run",
    scope: {
      story_id: context.storyId,
      source_message_id: "message",
      operation_id: "operation",
    },
    tool: { name: "search_assets", version: "1" },
    tool_call_id: "call",
    invocation_id: "invocation",
    arguments: { query: "" },
  };
  const call = (payload: unknown = body, authorization = "Bearer service") =>
    app.inject({
      method: "POST",
      url: "/api/agent/tools",
      headers: { authorization, "content-type": "application/json" },
      payload: JSON.stringify(payload),
    });
  return { app, call, body, context, resolve, createChapter, receipt };
}
describe("application callback boundary", () => {
  it("accepts service JSON without browser Origin, while preserving personal API protection", async () => {
    const f = await fixture();
    const result = await f.call();
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({
      protocol_version: 1,
      invocation_id: "invocation",
      outcome: "ok",
      data: { items: [], next_cursor: null },
    });
    expect((await f.call(f.body, "Bearer person")).statusCode).toBe(401);
    expect((await f.call(f.body, "")).statusCode).toBe(401);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/test-edit",
          headers: { authorization: "Bearer service", origin: config.origin },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/test-edit",
          headers: { authorization: "Bearer person" },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/test-edit",
          headers: { authorization: "Bearer person", origin: config.origin },
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
  });
  it("checks persisted binding and rejects scope substitution, unknown tools and body app identity", async () => {
    const f = await fixture();
    for (const payload of [
      { ...f.body, app_id: "other-app" },
      { ...f.body, task_id: "other-task" },
      { ...f.body, session_id: "other-session" },
      { ...f.body, run_id: "other-run" },
      ...[
        "story_id",
        "source_message_id",
        "operation_id",
        "authorization_id",
      ].map((key) => ({
        ...f.body,
        scope: { ...f.body.scope, [key]: "other" },
      })),
    ]) {
      const result = await f.call(payload);
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({
        outcome: "error",
        error: { code: "forbidden_scope", retryable: false },
      });
    }
    for (const name of ["shell", "create_chapter"])
      expect(
        (await f.call({ ...f.body, tool: { name, version: "1" } })).json(),
      ).toMatchObject({ error: { code: "invalid_arguments" } });
  });
  it("rejects extra fields, oversized UTF-8 bodies, wrong content type and mismatched tool version", async () => {
    const f = await fixture();
    for (const payload of [
      { ...f.body, authorized: true },
      { ...f.body, tool: { ...f.body.tool, version: "2" } },
    ])
      expect((await f.call(payload)).statusCode).toBe(400);
    expect(
      (await f.call({ ...f.body, arguments: { query: "中".repeat(50000) } }))
        .statusCode,
    ).toBe(413);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/agent/tools",
          headers: {
            authorization: "Bearer service",
            "content-type": "text/plain",
          },
          payload: JSON.stringify(f.body),
        })
      ).statusCode,
    ).toBe(415);
  });
  it("fails closed without an enabled callback verifier", async () => {
    const app = await createApp({
      config,
      verify: async () => {},
      checkStorage: async () => {},
    });
    apps.push(app);
    registerAgentTools(app, {
      assets: new AssetTools(new MemoryStore()),
      resolveTask: async () => undefined,
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/agent/tools",
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
  });
});

it("routes chapter writes through the bound task and returns durable receipts", async () => {
  const f = await fixture(true);
  const payload = {
    ...f.body,
    tool: { name: "create_chapter", version: "1" },
    arguments: {
      mode: "commit",
      draft_id: "draft",
      draft_revision: "1",
      draft_hash: "sha256:abc",
    },
  };
  expect((await f.call(payload)).json()).toMatchObject({
    outcome: "ok",
    receipt: f.receipt,
  });
  expect(f.createChapter).toHaveBeenCalledWith(
    f.context,
    payload.arguments,
    "invocation",
  );
  await f.call({ ...payload, scope: { ...payload.scope, story_id: "other" } });
  expect(f.createChapter).toHaveBeenCalledTimes(1);
});
it("protects operation recovery with service identity and exposes the original receipt", async () => {
  const f = await fixture(true);
  const url = "/api/agent/operations/operation";
  expect(
    (
      await f.app.inject({ url, headers: { authorization: "Bearer service" } })
    ).json(),
  ).toMatchObject({
    protocol_version: 1,
    operation_id: "operation",
    status: "committed",
    receipt: f.receipt,
  });
  expect(
    (await f.app.inject({ url, headers: { authorization: "Bearer person" } }))
      .statusCode,
  ).toBe(401);
});
