import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join, isAbsolute } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../../src/server/app.ts";
import { createVerifier } from "../../src/server/auth.ts";
import { createToolVerifier } from "../../src/server/tool-auth.ts";
import { loadConfig } from "../../src/server/config.ts";
import { registerBusiness } from "../../src/server/routes.ts";
import { registerCreative } from "../../src/server/creative-routes.ts";
import { registerAgentTools } from "../../src/server/tool-routes.ts";
import { Creative } from "../../src/server/creative.ts";
import { AssetTools } from "../../src/server/asset-tools.ts";
import { LibraryTools } from "../../src/server/library-tools.ts";
import { LIFECYCLE_TOOLS } from "../../src/server/creative-tools.ts";
import { MochiClient } from "../../src/server/mochi-client.ts";
import { entity } from "../../src/server/entities.ts";
import { MemoryStore } from "../support/memory-store.ts";
import { MemoryCreativeStore } from "../support/creative-store.ts";

export async function creativeHarness(options = {}) {
  const mochiRoot = process.env.MOCHI_REPO_ROOT;
  assert.ok(mochiRoot && isAbsolute(mochiRoot), "Set absolute MOCHI_REPO_ROOT");
  const modules = await Promise.all(
    [
      "server",
      "auth",
      "task-store",
      "tasks",
      "pi",
      "executor",
      "app-tools",
    ].map((name) => import(pathToFileURL(join(mochiRoot, `src/${name}.ts`)))),
  );
  const [
    { createServer },
    { createAuthenticator },
    { TaskStore },
    { Tasks },
    { createPi },
    { piExecutor },
    { AppTools },
  ] = modules;
  const require = createRequire(join(mochiRoot, "package.json"));
  const { InMemoryCredentialStore, createAssistantMessageEventStream } =
    await import(
      pathToFileURL(
        join(mochiRoot, "node_modules/@earendil-works/pi-ai/dist/index.js"),
      )
    );
  const { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } =
    await import(pathToFileURL(require.resolve("jose")));
  const key = await generateKeyPair("RS256");
  const jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(key.publicKey)), kid: "creative-fixture" }],
  });
  const tenant = randomUUID(),
    audience = randomUUID(),
    client = randomUUID(),
    principal = randomUUID(),
    toolClient = randomUUID(),
    toolPrincipal = randomUUID();
  const otherClient = randomUUID(),
    otherPrincipal = randomUUID(),
    spa = randomUUID(),
    owner = randomUUID(),
    apiId = randomUUID();
  const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
  async function token(aud, claims) {
    return new SignJWT({ tid: tenant, ver: "2.0", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "creative-fixture" })
      .setIssuer(issuer)
      .setAudience(aud)
      .setIssuedAt()
      .setNotBefore("0s")
      .setExpirationTime("1h")
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
  const toolToken = await token(apiId, {
    azp: toolClient,
    oid: toolPrincipal,
    roles: ["Write.Tools.Invoke"],
    idtyp: "app",
  });
  const userToken = await token(apiId, {
    azp: spa,
    oid: owner,
    scp: "Write.Access",
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
  const root = await mkdtemp("/tmp/mochi-creative-http-");
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(
    "deepseek",
    async () =>
      options.credential ?? { type: "api_key", key: "isolated-test-key" },
  );
  const pi = await createPi(credentials);
  const restoreRuntime = await options.configureRuntime?.(
    pi,
    createAssistantMessageEventStream,
  );
  const config = loadConfig({
    ENTRA_TENANT_ID: tenant,
    ENTRA_OWNER_OID: owner,
    ENTRA_SPA_CLIENT_ID: spa,
    ENTRA_API_CLIENT_ID: apiId,
    APP_ORIGIN: "http://127.0.0.1",
    COSMOS_ENDPOINT: "https://unused.documents.azure.com",
    MOCHI_TOOLS_CLIENT_ID: toolClient,
    MOCHI_TOOLS_PRINCIPAL_ID: toolPrincipal,
  });
  const content = new MemoryStore(),
    records = new MemoryCreativeStore(content);
  let clientApi;
  const creative = new Creative(
    content,
    records,
    {
      request: (path, body) =>
        clientApi.request(
          path,
          body?.scope && options.transformRun
            ? options.transformRun(globalThis.structuredClone(body))
            : body,
        ),
    },
    { pollMs: 10 },
  );
  const app = await createApp({
    config,
    verify: createVerifier(config.auth, jwks),
    verifyTools: createToolVerifier(config.toolAuth, jwks),
    checkStorage: async () => {},
  });
  registerBusiness(app, content);
  registerCreative(app, creative);
  registerAgentTools(app, {
    assets: new AssetTools(content),
    library: new LibraryTools(content),
    resolveTask: (id) => creative.resolveTask(id),
    createChapter: (ctx, args, id) => creative.createChapter(ctx, args, id),
    initializeStory: (ctx, args, id) => creative.initializeStory(ctx, args, id),
    operation: (id) => creative.operation(id),
  });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  config.origin = origin;
  const callbacks = [];
  let loseCommitResponse = false;
  const appTools = new AppTools(
    {
      "mochi-write": {
        endpoint: origin + "/api/agent/tools",
        operations_endpoint: origin + "/api/agent/operations",
        audience: `api://${apiId}`,
        tools: LIFECYCLE_TOOLS.map(({ name, version, effect }) => ({
          name,
          version,
          effect,
        })),
      },
    },
    {
      allowLoopback: true,
      token: async () => toolToken,
      fetch: async (url, init) => {
        const callback = init?.body ? JSON.parse(init.body) : undefined;
        if (callback) callbacks.push(callback);
        const response = await globalThis.fetch(url, init);
        if (
          loseCommitResponse &&
          callback?.arguments?.mode === "commit" &&
          response.ok
        ) {
          const value = await response.clone().json();
          if (value.receipt) {
            loseCommitResponse = false;
            throw new Error("isolated lost callback response");
          }
        }
        return response;
      },
    },
  );
  let store = await TaskStore.open(root),
    tasks,
    service,
    serviceOrigin,
    closing = false,
    pumping;
  const queue = [];
  const autoExecute = options.autoExecute !== false;
  async function pump() {
    if (pumping) return pumping;
    pumping = (async () => {
      while (queue.length && !closing)
        await tasks.execute(queue.shift(), piExecutor(pi, appTools));
    })().finally(() => {
      pumping = undefined;
    });
    return pumping;
  }
  function makeTasks() {
    return new Tasks(
      store,
      {
        send: async (id) => {
          queue.push(id);
          if (autoExecute)
            setTimeout(() => {
              void pump();
            }, 0);
        },
      },
      () => pi.models(),
      appTools,
    );
  }
  async function startServer() {
    service = createServer({
      tasks,
      authenticate,
      isReady: () => true,
      log: () => {},
    });
    service.listen(0, "127.0.0.1");
    await once(service, "listening");
    serviceOrigin = `http://127.0.0.1:${service.address().port}`;
    clientApi = new MochiClient(serviceOrigin, async () => appToken);
  }
  tasks = makeTasks();
  await startServer();
  async function http(
    base,
    path,
    body,
    bearer,
    expected = 200,
    browser = false,
  ) {
    const response = await globalThis.fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        ...(browser ? { origin } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  }
  async function story(name = "潮汐灯塔测试") {
    const id = randomUUID();
    const contentOf = (name, markdown) => ({
      name,
      markdown,
      genres: [],
      ageBand: "",
      sourceMetadata: {},
    });
    await content.commit(
      { ...entity("story", contentOf(name, ""), id, id), status: "ready" },
      null,
    );
    const setting = await content.commit(
      entity(
        "setting",
        contentOf(
          "潮汐港灯塔",
          "潮汐港的灯塔每晚十一点敲响铜铃。暴风夜要先关闭朝海的百叶窗，再点燃蓝色信号灯。",
        ),
        id,
      ),
      null,
    );
    const character = await content.commit(
      entity(
        "snapshot",
        contentOf(
          "林舟",
          "林舟是潮汐港的灯塔守望者，左手戴着祖父留下的黄铜指环。他害怕雷声，却从未错过给渔船引航。",
        ),
        id,
      ),
      null,
    );
    return { id, setting, character };
  }
  return {
    origin,
    content,
    records,
    creative,
    pi,
    callbacks,
    queue,
    story,
    pump,
    get tasks() {
      return tasks;
    },
    get store() {
      return store;
    },
    request: (path, body, expected = 200) =>
      http(origin, path, body, userToken, expected, true),
    mochiRequest: (path, body, expected = 200, other = false) =>
      http(serviceOrigin, path, body, other ? otherToken : appToken, expected),
    callback: (body, personal = false, expected = 200) =>
      http(
        origin,
        "/api/agent/tools",
        body,
        personal ? userToken : toolToken,
        expected,
      ),
    loseNextCommitResponse() {
      loseCommitResponse = true;
    },
    async waitTask(
      storyId,
      id,
      predicate = (task) =>
        !["interpreting", "pending", "running"].includes(task.status),
      timeout = 20000,
    ) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const task = await creative.task(storyId, id);
        if (predicate(task)) return task;
        await delay(20);
      }
      const task = await creative.task(storyId, id);
      throw new Error(
        `Creative task timeout: ${task.status}/${task.error ?? "no error"}`,
      );
    },
    async restartMochi() {
      await tasks.close();
      if (pumping) await pumping;
      await new Promise((resolve) => service.close(resolve));
      await store.close();
      queue.length = 0;
      store = await TaskStore.open(root);
      tasks = makeTasks();
      await tasks.recover();
      await startServer();
    },
    async close() {
      closing = true;
      await creative.close();
      await tasks.close();
      if (pumping) await pumping;
      await new Promise((resolve) => service.close(resolve));
      await app.close();
      await store.close();
      await restoreRuntime?.();
      await rm(root, { recursive: true, force: true });
    },
  };
}
