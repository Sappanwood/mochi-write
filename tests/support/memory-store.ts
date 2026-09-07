import { randomUUID } from "node:crypto";
import type { Store } from "../../src/server/store.js";
import {
  AppError,
  type Entity,
  type Document,
  type Filter,
  type Page,
} from "../../src/shared/model.js";
import { clean } from "../../src/server/entities.js";
export class MemoryStore implements Store {
  readonly heads = new Map<string, Document>();
  readonly history = new Map<string, Entity>();
  failNext = false;
  async get(
    id: string,
    projectId: string | null,
  ): Promise<Document | undefined> {
    const d = this.heads.get(`${projectId}:${id}`);
    return d ? structuredClone(d) : undefined;
  }
  async list(f: Filter): Promise<Page> {
    const all = [...this.heads.values()]
      .filter(
        (d) =>
          !d.deleted &&
          (d.kind !== "story" || d.status === "ready") &&
          (f.projectId === undefined || d.projectId === f.projectId) &&
          (!f.kind || d.kind === f.kind) &&
          (!f.name ||
            d.content.name.toLowerCase().includes(f.name.toLowerCase())) &&
          (!f.genre || d.content.genres.includes(f.genre)) &&
          (!f.ageBand || d.content.ageBand === f.ageBand),
      )
      .sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id),
      );
    const offset = Number(f.cursor ?? 0);
    const limit = f.limit ?? 40;
    return {
      items: structuredClone(all.slice(offset, offset + limit)),
      ...(offset + limit < all.length
        ? { cursor: String(offset + limit) }
        : {}),
    };
  }
  async publishStory(story: Document): Promise<Document> {
    const old = this.heads.get(`${story.projectId}:${story.id}`);
    if (old?.revision !== story.revision) throw new AppError(409, "版本冲突");
    const doc = {
      ...structuredClone(old),
      status: "ready" as const,
      revision: randomUUID(),
    };
    this.heads.set(`${story.projectId}:${story.id}`, doc);
    return structuredClone(doc);
  }
  async commit(input: Entity, revision: string | null): Promise<Document> {
    if (this.failNext) {
      this.failNext = false;
      throw new AppError(503, "保存失败");
    }
    const e = clean(input);
    const key = `${e.projectId}:${e.id}`;
    const old = this.heads.get(key);
    if (
      (old?.revision ?? null) !== revision ||
      (old && e.currentVersion !== old.currentVersion + 1) ||
      this.history.has(`${e.id}:${e.currentVersion}`)
    )
      throw new AppError(409, "版本冲突");
    const doc = { ...structuredClone(e), revision: randomUUID() };
    this.history.set(`${e.id}:${e.currentVersion}`, structuredClone(e));
    this.heads.set(key, doc);
    return structuredClone(doc);
  }
}
