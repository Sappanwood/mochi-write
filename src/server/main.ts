import { Creative } from "./creative.js";
import { CosmosCreativeStore } from "./creative-store.js";
import { registerCreative } from "./creative-routes.js";
import { registerAgentTools } from "./tool-routes.js";
import { LibraryTools } from "./library-tools.js";
import { AssetTools } from "./asset-tools.js";
import { AppError } from "../shared/model.js";
import { MochiClient } from "./mochi-client.js";
import { Writing } from "./writing.js";
import { CosmosWritingStore } from "./writing-store.js";
import { registerWriting } from "./writing-routes.js";
import { CosmosStore } from "./cosmos-store.js";
import { registerBusiness } from "./routes.js";
import { resolve } from "node:path";
import { CosmosClient, ConsistencyLevel } from "@azure/cosmos";
import { ManagedIdentityCredential } from "@azure/identity";
import fastifyStatic from "@fastify/static";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

try {
  const config = loadConfig();
  const cosmos = new CosmosClient({
    endpoint: config.cosmosEndpoint,
    aadCredentials: new ManagedIdentityCredential({
      clientId: config.managedIdentityClientId,
    }),
    consistencyLevel: ConsistencyLevel.Session,
  });
  const database = cosmos.database(config.cosmosDatabase);
  const app = await createApp({
    config,
    checkStorage: async () => {
      await Promise.all(
        ["library", "stories"].map((name) => database.container(name).read()),
      );
    },
  });
  const store = new CosmosStore(database);
  registerBusiness(app, store);
  const credential = new ManagedIdentityCredential({
    clientId: config.managedIdentityClientId,
  });
  const mochi =
    config.mochiOrigin && config.mochiAudience
      ? new MochiClient(config.mochiOrigin, async () => {
          const token = await credential.getToken(
            `api://${config.mochiAudience}/.default`,
          );
          return token.token;
        })
      : {
          async request(): Promise<never> {
            throw new AppError(503, "写作服务尚未配置；资产阅读仍可用");
          },
        };
  registerWriting(
    app,
    new Writing(store, new CosmosWritingStore(database), mochi),
  );
  const creative = new Creative(
    store,
    new CosmosCreativeStore(database),
    mochi,
  );
  registerCreative(app, creative);
  registerAgentTools(app, {
    assets: new AssetTools(store),
    library: new LibraryTools(store),
    resolveTask: (id) => creative.resolveTask(id),
    initializeStory: (context, args, invocationId) =>
      creative.initializeStory(context, args, invocationId),
    createChapter: (context, args, invocationId) =>
      creative.createChapter(context, args, invocationId),
    operation: (id) => creative.operation(id),
  });
  app.addHook("onReady", async () => {
    await creative.recover();
  });
  await app.register(fastifyStatic, {
    root: resolve("dist/web"),
    wildcard: false,
  });
  app.addHook("onClose", async () => {
    await creative.close();
    cosmos.dispose();
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      void app.close();
    });
  const address = await app.listen({ host: config.host, port: config.port });
  console.info(`Mochi Write listening at ${address}`);
} catch {
  console.error("Mochi Write 启动失败，请检查必需配置、构建产物与端口占用。");
  process.exitCode = 1;
}
