import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import fastifyStatic from "@fastify/static";
import { createApp } from "../../src/server/app.js";
import { createVerifier } from "../../src/server/auth.js";
import { loadConfig } from "../../src/server/config.js";
import { registerBusiness } from "../../src/server/routes.js";
import type { PortraitStore } from "../../src/server/portraits.js";
import { registerFree } from "../../src/server/free-routes.js";
import { FreeSession } from "../../src/server/free-session.js";
import { MemoryStore } from "../support/memory-store.js";
import { MemoryFreeStore } from "../support/free-store.js";
import { FakeCreativeMochi } from "../support/creative-mochi.js";
import { FreeCallback } from "../../src/server/free-callback.js";
import { freeScope } from "../../src/server/free-workflow.js";
import type { FreeTask } from "../../src/shared/free.js";
export class FreeBrowserMochi extends FakeCreativeMochi {
  freeIntent = "draft";
  targetKind = "character";
  targetMode = "new";
  override async request<T>(path: string, raw?: unknown): Promise<T> {
    const result = await super.request<T>(path, raw);
    if (path.endsWith("/runs") && raw) {
      const body = raw as { scope?: unknown; prompt: string };
      if (!body.scope) {
        const prompt = JSON.parse(body.prompt) as { user_message: string };
        const run = result as { run_id: string; result: unknown };
        const text = prompt.user_message;
        const resultText = JSON.stringify({
          intent: this.freeIntent,
          evidence: { start: 0, end: text.length, text },
          target: {
            kind: this.targetKind,
            mode: this.targetMode,
            predicates: [],
          },
        });
        this.runs.get(run.run_id)!.result = { text: resultText };
        run.result = { text: resultText };
      }
    }
    return result;
  }
}
export async function freeFixture(images?: PortraitStore) {
  const config = loadConfig({
    ENTRA_TENANT_ID: randomUUID(),
    ENTRA_OWNER_OID: randomUUID(),
    ENTRA_SPA_CLIENT_ID: randomUUID(),
    ENTRA_API_CLIENT_ID: randomUUID(),
    APP_ORIGIN: "http://127.0.0.1:18080",
    COSMOS_ENDPOINT: "https://example.documents.azure.com/",
  });
  const keys = await generateKeyPair("RS256"),
    jwk = await exportJWK(keys.publicKey);
  async function sign(owner = config.auth.ownerOid) {
    return new SignJWT({
      tid: config.auth.tenantId,
      oid: owner,
      azp: config.auth.spaClientId,
      scp: "Write.Access",
      ver: "2.0",
    })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer(
        `https://login.microsoftonline.com/${config.auth.tenantId}/v2.0`,
      )
      .setAudience(config.auth.apiClientId)
      .setIssuedAt()
      .setExpirationTime("20m")
      .sign(keys.privateKey);
  }
  const token = await sign(),
    otherToken = await sign(randomUUID());
  const server = await createApp({
    config,
    verify: createVerifier(
      config.auth,
      createLocalJWKSet({ keys: [{ ...jwk, kid: "fixture" }] }),
    ),
    checkStorage: async () => {},
  });
  const store = new MemoryStore(),
    records = new MemoryFreeStore(store),
    mochi = new FreeBrowserMochi(),
    free = new FreeSession(store, records, mochi, { pollMs: 10 });
  registerBusiness(server, store, images);
  registerFree(server, free);
  server.get("/api/writing/models", async () => mochi.request("/v1/models"));
  server.get("/fixture-token", async (_request, reply) =>
    reply.header("cache-control", "no-store").send({ token }),
  );
  await server.register(fastifyStatic, {
    root: resolve(".data/browser"),
    wildcard: false,
  });
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  config.origin = address;
  console.log(`FREE_FIXTURE_ADDRESS=${address}`);
  async function invoke(
    task: FreeTask,
    name: string,
    args: Record<string, unknown>,
  ) {
    const latest = await free.task(task.id),
      { task_id: _task, ...scope } = freeScope(latest, "execute");
    void _task;
    const callback = new FreeCallback(free);
    const result = await callback.invoke({
      protocol_version: 2,
      app_id: "mochi-write",
      session_id: latest.executionRun!.sessionId,
      run_id: latest.executionRun!.runId,
      task_id: task.id,
      scope,
      invocation_id: randomUUID(),
      tool_call_id: randomUUID(),
      tool: { name, version: "2" },
      arguments: args,
    });
    if (!("data" in result)) throw Error(JSON.stringify(result));
    return result;
  }
  return {
    server,
    store,
    records,
    mochi,
    free,
    address,
    token,
    otherToken,
    invoke,
    close: async () => {
      await free.close();
      server.server.closeAllConnections();
      await server.close();
    },
  };
}
