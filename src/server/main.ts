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
  registerBusiness(app, new CosmosStore(database));
  await app.register(fastifyStatic, {
    root: resolve("dist/web"),
    wildcard: false,
  });
  app.addHook("onClose", async () => {
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
