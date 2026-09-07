import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath, URL } from "node:url";
import { join, isAbsolute } from "node:path";
import { mock } from "node:test";

const mochiRoot = process.env.MOCHI_REPO_ROOT;
assert.ok(
  mochiRoot && isAbsolute(mochiRoot),
  "Set MOCHI_REPO_ROOT to the absolute path of the Mochi repository",
);
const writeRoot = fileURLToPath(new URL("../../", import.meta.url));
const { createServer } = await import(
  pathToFileURL(join(mochiRoot, "src/server.ts"))
);
const { createAuthenticator } = await import(
  pathToFileURL(join(mochiRoot, "src/auth.ts"))
);
const { TaskStore } = await import(
  pathToFileURL(join(mochiRoot, "src/task-store.ts"))
);
const { Tasks } = await import(pathToFileURL(join(mochiRoot, "src/tasks.ts")));
const { createPi } = await import(pathToFileURL(join(mochiRoot, "src/pi.ts")));
const { piExecutor } = await import(
  pathToFileURL(join(mochiRoot, "src/executor.ts"))
);
const { createApp } = await import(
  pathToFileURL(join(writeRoot, "src/server/app.ts"))
);
const { createVerifier } = await import(
  pathToFileURL(join(writeRoot, "src/server/auth.ts"))
);
const { loadConfig } = await import(
  pathToFileURL(join(writeRoot, "src/server/config.ts"))
);
const { registerBusiness } = await import(
  pathToFileURL(join(writeRoot, "src/server/routes.ts"))
);
const { registerWriting } = await import(
  pathToFileURL(join(writeRoot, "src/server/writing-routes.ts"))
);
const { Writing } = await import(
  pathToFileURL(join(writeRoot, "src/server/writing.ts"))
);
const { MochiClient } = await import(
  pathToFileURL(join(writeRoot, "src/server/mochi-client.ts"))
);
const { entity } = await import(
  pathToFileURL(join(writeRoot, "src/server/entities.ts"))
);
const { MemoryStore } = await import(
  pathToFileURL(join(writeRoot, "tests/support/memory-store.ts"))
);
const { MemoryWritingStore } = await import(
  pathToFileURL(join(writeRoot, "tests/support/writing-store.ts"))
);
const require = createRequire(join(mochiRoot, "package.json"));
const { InMemoryCredentialStore, createAssistantMessageEventStream } =
  await import(
    pathToFileURL(
      join(mochiRoot, "node_modules/@earendil-works/pi-ai/dist/index.js"),
    )
  );
const { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } = await import(
  pathToFileURL(require.resolve("jose"))
);
const key = await generateKeyPair("RS256");
const jwks = createLocalJWKSet({
  keys: [{ ...(await exportJWK(key.publicKey)), kid: "integration" }],
});
const tenant = randomUUID(),
  audience = randomUUID(),
  client = randomUUID(),
  principal = randomUUID();
const otherClient = randomUUID(),
  otherPrincipal = randomUUID();
const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
async function token(aud, claims) {
  return new SignJWT({ tid: tenant, ver: "2.0", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "integration" })
    .setIssuer(issuer)
    .setAudience(aud)
    .setIssuedAt()
    .setNotBefore("0s")
    .setExpirationTime("5m")
    .sign(key.privateKey);
}
const appToken = await token(audience, {
  azp: client,
  oid: principal,
  roles: ["Mochi.Invoke"],
  idtyp: "app",
});
const otherToken = await token(audience, {
  azp: otherClient,
  oid: otherPrincipal,
  roles: ["Mochi.Invoke"],
  idtyp: "app",
});
const authenticate = createAuthenticator(
  {
    tenant,
    issuer,
    audience,
    role: "Mochi.Invoke",
    callers: new Map([
      [client, { appId: "mochi-write", principalId: principal }],
      [otherClient, { appId: "other-app", principalId: otherPrincipal }],
    ]),
  },
  jwks,
);
const root = await mkdtemp("/tmp/mochi-write-real-api-");
let store, tasks, service, app;
const queue = [];
try {
  store = await TaskStore.open(root);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("deepseek", async () => ({
    type: "api_key",
    key: "isolated-test-key",
  }));
  const pi = await createPi(credentials);
  let modelCalls = 0;
  mock.method(pi.runtime, "streamSimple", (model, context) => {
    modelCalls++;
    assert.deepEqual(context.tools ?? [], []);
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "灯塔的光照亮了归途。" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 8,
        output: 8,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 16,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    stream.push({ type: "done", reason: "stop", message });
    return stream;
  });
  tasks = new Tasks(
    store,
    {
      send: async (id) => {
        queue.push(id);
      },
    },
    () => pi.models(),
  );
  function server() {
    return createServer({
      tasks,
      authenticate,
      isReady: () => true,
      log: () => {},
    });
  }
  service = server();
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  let serviceOrigin = `http://127.0.0.1:${service.address().port}`;
  const spa = randomUUID(),
    owner = randomUUID(),
    apiId = randomUUID();
  const userToken = await token(apiId, {
    azp: spa,
    oid: owner,
    scp: "Write.Access",
  });
  const config = loadConfig({
    ENTRA_TENANT_ID: tenant,
    ENTRA_OWNER_OID: owner,
    ENTRA_SPA_CLIENT_ID: spa,
    ENTRA_API_CLIENT_ID: apiId,
    APP_ORIGIN: "http://127.0.0.1",
    COSMOS_ENDPOINT: "https://unused.documents.azure.com",
  });
  const content = new MemoryStore();
  const storyId = randomUUID();
  await content.commit(
    {
      ...entity(
        "story",
        {
          name: "灯塔",
          markdown: "",
          genres: [],
          ageBand: "",
          sourceMetadata: {},
        },
        storyId,
        storyId,
      ),
      status: "ready",
    },
    null,
  );
  app = await createApp({
    config,
    verify: createVerifier(config.auth, jwks),
    checkStorage: async () => {},
  });
  registerBusiness(app, content);
  registerWriting(
    app,
    new Writing(
      content,
      new MemoryWritingStore(content),
      new MochiClient(serviceOrigin, async () => appToken),
    ),
  );
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  async function request(path, body, expected = 200) {
    const response = await globalThis.fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${userToken}`,
        origin: config.origin,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  }
  const scope = { type: "story", id: storyId };
  const conversation = await request("/api/writing/conversations", scope);
  const catalog = await request("/api/writing/models");
  const model = catalog.models.find((m) => m.provider === "deepseek");
  assert.ok(model?.context_window > 0);
  const input = {
    conversationId: conversation.id,
    clientRequestId: randomUUID(),
    provider: model.provider,
    model: model.id,
    message: "写一段灯塔引导船只回港的结尾。",
    pageContext: { schemaVersion: 1, scope, location: null, selection: null },
    attachedRefs: [],
    target: { id: null, revision: null, name: "归途", order: 1 },
  };
  const submitted = await request("/api/writing/submit", input);
  assert.equal(submitted.status, "queued");
  assert.equal(queue.length, 1);
  await tasks.execute(queue[0], piExecutor(pi));
  const query = `?type=story&id=${storyId}`;
  const draft = await request(`/api/writing/drafts/${submitted.id}${query}`);
  assert.equal(draft.status, "succeeded");
  assert.equal(draft.output, "灯塔的光照亮了归途。");
  const events = await request(
    `/api/writing/drafts/${submitted.id}/events${query}`,
  );
  assert.ok(events.events.length >= 2);
  const resumedEvents = await request(
    `/api/writing/drafts/${submitted.id}/events${query}&after=${events.next_cursor}`,
  );
  assert.equal(resumedEvents.events.length, 0);
  const accepted = await request(
    `/api/writing/drafts/${submitted.id}/accept${query}`,
    {},
  );
  assert.deepEqual(
    await request(`/api/writing/drafts/${submitted.id}/accept${query}`, {}),
    accepted,
  );
  const chapter = await content.get(accepted.id, storyId);
  assert.equal(chapter.currentVersion, 1);
  assert.equal(chapter.content.markdown, draft.output);
  const history = await request(
    `/api/writing/history${query}&conversationId=${conversation.id}`,
  );
  assert.equal(history.messages.length, 2);
  const foreign = await globalThis.fetch(
    `${serviceOrigin}/v1/runs/${draft.runId}`,
    {
      headers: { authorization: `Bearer ${otherToken}` },
    },
  );
  assert.equal(foreign.status, 403);
  await app.close();
  app = undefined;
  await new Promise((resolve) => service.close(resolve));
  service = undefined;
  await tasks.close();
  await store.close();
  store = await TaskStore.open(root);
  tasks = new Tasks(store, { send: async (id) => queue.push(id) }, () =>
    pi.models(),
  );
  service = server();
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  serviceOrigin = `http://127.0.0.1:${service.address().port}`;
  const recovered = await globalThis.fetch(
    `${serviceOrigin}/v1/runs/${draft.runId}`,
    {
      headers: { authorization: `Bearer ${appToken}` },
    },
  );
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).result.text, draft.output);
  assert.equal(modelCalls, 1);
  console.log(
    JSON.stringify({
      ok: true,
      real_http_services: 2,
      real_pi_session: true,
      provider_stream: "isolated substitute",
      persisted_run_restart: true,
      app_isolation: true,
      event_resume: true,
      chapter_accept_once: true,
      model_calls: modelCalls,
    }),
  );
} finally {
  if (app) await app.close();
  if (service) await new Promise((resolve) => service.close(resolve));
  if (tasks) await tasks.close();
  if (store) await store.close();
  mock.restoreAll();
  await rm(root, { recursive: true, force: true });
}
