import type { Store } from "./store.js";
import {
  AppError,
  contentSchema,
  genres,
  ageBands,
  type Content,
  type Document,
} from "../shared/model.js";
import { clean, entity, stableId } from "./entities.js";
export class Library {
  constructor(readonly store: Store) {}
  async vocabulary() {
    const vocabulary: Document[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.store.list({
        kind: "vocabulary",
        projectId: null,
        limit: 2,
        cursor,
      });
      vocabulary.push(...page.items);
      cursor = page.cursor;
      if (vocabulary.length > 1) throw new AppError(409, "存在多份受控词表");
    } while (cursor);
    const metadata = vocabulary[0]?.content.sourceMetadata;
    return {
      genres: Array.isArray(metadata?.genres)
        ? (metadata.genres as string[])
        : genres,
      ageBands: Array.isArray(metadata?.ageBands)
        ? (metadata.ageBands as string[])
        : ageBands,
    };
  }
  async validate(input: Content) {
    const content = contentSchema.parse(input);
    const terms = await this.vocabulary();
    if (
      content.genres.some((v) => !terms.genres.includes(v)) ||
      (content.ageBand && !terms.ageBands.includes(content.ageBand))
    )
      throw new AppError(400, "题材或年龄层不在受控词表中");
    return {
      ...content,
      sourceMetadata: {
        ...content.sourceMetadata,
        name: content.name,
        genres: content.genres,
        age_band: content.ageBand,
        ...(Object.hasOwn(content.sourceMetadata, "world")
          ? { world: content.name }
          : {}),
      },
    };
  }
  async create(kind: "character" | "world", input: Content): Promise<Document> {
    return this.store.commit(entity(kind, await this.validate(input)), null);
  }
  async save(id: string, revision: string, input: Content): Promise<Document> {
    const old = await this.requireAsset(id);
    const content = await this.validate(input);
    if (old.revision !== revision)
      throw new AppError(409, "版本已变化，请保留草稿并重新读取");
    return this.store.commit(
      {
        ...clean(old),
        content: {
          ...content,
          sourceMetadata: {
            ...old.content.sourceMetadata,
            ...content.sourceMetadata,
          },
        },
        updatedAt: new Date().toISOString(),
        currentVersion: old.currentVersion + 1,
      },
      revision,
    );
  }
  async remove(id: string, revision: string): Promise<void> {
    const old = await this.requireAsset(id);
    await this.store.commit(
      {
        ...clean(old),
        deleted: true,
        updatedAt: new Date().toISOString(),
        currentVersion: old.currentVersion + 1,
      },
      revision,
    );
  }
  async requireAsset(id: string) {
    const doc = await this.store.get(id, null);
    if (!doc || doc.deleted || !["character", "world"].includes(doc.kind))
      throw new AppError(404, "资产不存在");
    return doc;
  }
  async addSnapshot(
    story: string,
    asset: string,
    requestId: string,
  ): Promise<Document> {
    const s = await this.store.get(story, story);
    if (!s || s.kind !== "story" || s.status !== "ready")
      throw new AppError(404, "故事不存在");
    const id = stableId(`${story}:${requestId}`);
    const previous = await this.store.get(id, story);
    if (previous) {
      if (previous.kind !== "snapshot" || previous.sourceAssetId !== asset)
        throw new AppError(409, "同一请求对应不同资产");
      return previous;
    }
    const master = await this.requireAsset(asset);
    const doc = {
      ...entity("snapshot", structuredClone(master.content), story, id),
      sourceAssetId: master.id,
      sourceVersion: master.currentVersion,
    };
    try {
      return await this.store.commit(doc, null);
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 409) {
        const existing = await this.store.get(id, story);
        if (existing?.sourceAssetId === asset) return existing;
      }
      throw error;
    }
  }
}
