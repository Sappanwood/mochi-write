import { once } from "node:events";
import { createServer as callbackServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import process from "node:process";
const [root, mode] = process.argv.slice(2);
const source = (name) =>
  import(pathToFileURL(join(process.env.MOCHI_REPO_ROOT, `src/${name}.ts`)));
const [
  { TaskStore },
  { Tasks },
  { createPi },
  { piExecutor },
  { AppTools },
  { createServer },
] = await Promise.all(
  ["task-store", "tasks", "pi", "executor", "app-tools", "server"].map(source),
);
const { InMemoryCredentialStore, createAssistantMessageEventStream } =
  await import(
    pathToFileURL(
      join(
        process.env.MOCHI_REPO_ROOT,
        "node_modules/@earendil-works/pi-ai/dist/index.js",
      ),
    )
  );
const credentials = new InMemoryCredentialStore();
await credentials.modify("deepseek", async () => ({
  type: "api_key",
  key: "isolated-process-test",
}));
const pi = await createPi(credentials);
let modelCalls = 0,
  callbacks = 0,
  dispatches = 0;
pi.runtime.streamSimple = (model) => {
  modelCalls++;
  const stream = createAssistantMessageEventStream();
  stream.push({
    type: "done",
    reason: "toolUse",
    message: {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: randomUUID(),
          name: "create_chapter",
          arguments: { mode: "commit" },
        },
      ],
      usage: {
        input: 10,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 20,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  });
  return stream;
};
const callback = callbackServer(async (req) => {
  for await (const chunk of req) void chunk;
  callbacks++;
  // The parent kills this process while the real callback response is pending.
  process.send({ type: "callback", callbacks, modelCalls });
});
callback.listen(0, "127.0.0.1");
await once(callback, "listening");
const tools = new AppTools(
  {
    "mochi-write": {
      endpoint: `http://127.0.0.1:${callback.address().port}/tools`,
      operations_endpoint: `http://127.0.0.1:${callback.address().port}/operations`,
      audience: "api://isolated-crash",
      tools: [{ name: "create_chapter", version: "1", effect: "write" }],
    },
  },
  { allowLoopback: true, token: async () => "isolated-callback-token" },
);
const store = await TaskStore.open(root);
let tasks;
tasks = new Tasks(
  store,
  {
    send: async (id) => {
      dispatches++;
      void tasks.execute(id, piExecutor(pi, tools));
    },
  },
  () => pi.models(),
  tools,
);
if (mode === "recover") await tasks.recover();
const server = createServer({
  tasks,
  authenticate: async () => ({ appId: "mochi-write" }),
  isReady: () => true,
  log: () => {},
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
process.send({
  type: "ready",
  origin: `http://127.0.0.1:${server.address().port}`,
  dispatches,
  modelCalls,
  callbacks,
});
process.on("message", async (message) => {
  if (message === "counts")
    process.send({ type: "counts", dispatches, modelCalls, callbacks });
  if (message === "close") {
    await tasks.close();
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => callback.close(resolve));
    await store.close();
    process.disconnect();
  }
});
