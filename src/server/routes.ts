import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Store } from "./store.js";
import { registerPortraits, type PortraitStore } from "./portraits.js";
import { bundlePortraits } from "./portrait-bundle.js";
import { validateStoredPortrait } from "./portraits.js";
import { AppError, contentSchema } from "../shared/model.js";
import { Library } from "./library.js";
import { importFiles, preflight } from "./import.js";
import { exportFiles } from "./export.js";
import { clean } from "./entities.js";
import { GUIDANCE_MAX_LENGTH } from "../shared/guidance.js";
const idParams = z.object({ id: z.uuid() });
const paging = {
  cursor: z.string().max(16384).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
};
const importSchema = z
  .object({
    batchId: z.string().min(1).max(200),
    files: z
      .array(z.object({ path: z.string(), text: z.string() }).strict())
      .max(1000),
  })
  .strict();
export function registerBusiness(
  app: FastifyInstance,
  store: Store,
  images?: PortraitStore,
) {
  registerPortraits(app, store, images);
  const library = new Library(store);
  async function story(id: string) {
    const doc = await store.get(id, id);
    if (!doc || doc.kind !== "story" || doc.status !== "ready" || doc.deleted)
      throw new AppError(404, "故事不存在");
    return doc;
  }
  app.get("/api/vocabulary", async () => library.vocabulary());
  app.get("/api/library", async (request) => {
    const query = z
      .object({
        ...paging,
        kind: z.enum(["character", "world"]).optional(),
        name: z.string().max(200).optional(),
        genre: z.string().max(40).optional(),
        ageBand: z.string().max(40).optional(),
      })
      .strict()
      .parse(request.query);
    if (!query.kind) throw new AppError(400, "请选择角色或世界观");
    return store.list({ ...query, projectId: null });
  });
  app.post("/api/library", async (request, reply) => {
    const body = z
      .object({ kind: z.enum(["character", "world"]), content: contentSchema })
      .strict()
      .parse(request.body);
    return reply.code(201).send(await library.create(body.kind, body.content));
  });
  app.get("/api/library/:id", async (request) =>
    library.requireAsset(idParams.parse(request.params).id),
  );
  app.put("/api/library/:id", async (request) => {
    const body = z
      .object({ revision: z.string().min(1), content: contentSchema })
      .strict()
      .parse(request.body);
    return library.save(
      idParams.parse(request.params).id,
      body.revision,
      body.content,
    );
  });
  app.delete("/api/library/:id", async (request, reply) => {
    const body = z
      .object({ revision: z.string().min(1) })
      .strict()
      .parse(request.body);
    await library.remove(idParams.parse(request.params).id, body.revision);
    return reply.code(204).send();
  });
  app.get("/api/stories", async (request) =>
    store.list({
      ...z.object(paging).strict().parse(request.query),
      kind: "story",
    }),
  );
  app.get("/api/stories/:id", async (request) =>
    story(idParams.parse(request.params).id),
  );
  app.put("/api/stories/:id/guidance", async (request) => {
    const body = z
      .object({
        revision: z.string().min(1),
        text: z.string().max(GUIDANCE_MAX_LENGTH),
      })
      .strict()
      .parse(request.body);
    const current = await story(idParams.parse(request.params).id);
    if (current.revision !== body.revision)
      throw new AppError(409, "故事版本已变化，请保留指引并读取最新版本");
    return store.commit(
      {
        ...clean(current),
        guidance: body.text.trim(),
        currentVersion: current.currentVersion + 1,
        updatedAt: new Date().toISOString(),
      },
      body.revision,
    );
  });
  app.get("/api/stories/:id/documents", async (request) => {
    const id = idParams.parse(request.params).id;
    await story(id);
    const query = z
      .object({
        ...paging,
        kind: z.enum(["setting", "outline", "snapshot", "chapter"]),
      })
      .strict()
      .parse(request.query);
    return store.list({ ...query, projectId: id });
  });
  app.get("/api/stories/:id/documents/:documentId", async (request) => {
    const { id, documentId } = z
      .object({ id: z.uuid(), documentId: z.uuid() })
      .parse(request.params);
    await story(id);
    const doc = await store.get(documentId, id);
    if (!doc || doc.deleted || doc.kind === "story")
      throw new AppError(404, "文档不存在");
    return doc;
  });
  app.post("/api/stories/:id/snapshots", async (request) => {
    const body = z
      .object({ assetId: z.uuid(), requestId: z.uuid() })
      .strict()
      .parse(request.body);
    return library.addSnapshot(
      idParams.parse(request.params).id,
      body.assetId,
      body.requestId,
    );
  });
  app.post(
    "/api/import/preview",
    { bodyLimit: 32 * 1024 * 1024 },
    async (request) => {
      const body = importSchema.parse(request.body);
      const docs = preflight(
        body.files,
        body.batchId,
        await library.vocabulary(),
      );
      const counts: Record<string, number> = {};
      for (const data of bundlePortraits(body.files, docs).values())
        await validateStoredPortrait(data);
      for (const d of docs) counts[d.kind] = (counts[d.kind] ?? 0) + 1;
      return { count: docs.length, counts };
    },
  );
  app.post("/api/import", { bodyLimit: 32 * 1024 * 1024 }, async (request) => {
    const body = importSchema.parse(request.body);
    return importFiles(store, body.files, body.batchId, images);
  });
  app.post("/api/export", async (request) => {
    z.object({}).strict().parse(request.body);
    return { files: await exportFiles(store, images) };
  });
}
