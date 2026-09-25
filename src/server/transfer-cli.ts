import { CosmosClient, ConsistencyLevel } from "@azure/cosmos";
import { ManagedIdentityCredential } from "@azure/identity";
import { loadConfig } from "./config.js";
import { configuredPortraits } from "./portrait-store.js";
import { bundlePortraits } from "./portrait-bundle.js";
import { validateStoredPortrait } from "./portraits.js";
import { CosmosStore } from "./cosmos-store.js";
import { readBundle, writeBundle } from "./filesystem.js";
import { preflight, importFiles } from "./import.js";
import { exportFiles } from "./export.js";
import { AppError } from "../shared/model.js";
const [command, path, batch, ...extra] = process.argv.slice(2);
let client: CosmosClient | undefined;
try {
  if (
    extra.length ||
    !path ||
    !["preflight", "import", "export"].includes(command ?? "") ||
    (command === "export" ? batch !== undefined : !batch)
  )
    throw new AppError(
      400,
      "用法：transfer preflight|import <源目录> <批次标识>；transfer export <新目标目录>",
    );
  if (command === "preflight") {
    const files = await readBundle(path);
    const docs = preflight(files, batch!);
    for (const data of bundlePortraits(files, docs).values())
      await validateStoredPortrait(data);
    console.info(JSON.stringify({ ok: true, count: docs.length }));
  } else {
    const config = loadConfig();
    client = new CosmosClient({
      endpoint: config.cosmosEndpoint,
      aadCredentials: new ManagedIdentityCredential({
        clientId: config.managedIdentityClientId,
      }),
      consistencyLevel: ConsistencyLevel.Session,
    });
    const store = new CosmosStore(client.database(config.cosmosDatabase));
    if (command === "import")
      console.info(
        JSON.stringify({
          ok: true,
          ...(await importFiles(
            store,
            await readBundle(path),
            batch!,
            configuredPortraits(config),
          )),
        }),
      );
    else {
      const files = await exportFiles(store, configuredPortraits(config));
      await writeBundle(path, files);
      console.info(JSON.stringify({ ok: true, files: files.length }));
    }
  }
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      error:
        error instanceof AppError
          ? error.message
          : "操作失败，请检查配置、源文件、目标目录和数据库可用性",
    }),
  );
  process.exitCode = 1;
} finally {
  client?.dispose();
}
