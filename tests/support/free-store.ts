import type { StoryWrite } from "../../src/server/free-story-operations.js";
import { randomUUID } from "node:crypto";
import type { FreeRecord } from "../../src/shared/free.js";
import { AppError } from "../../src/shared/model.js";
import {
  freeOperations,
  type FreeStore,
  type FreeWrite,
} from "../../src/server/free-store.js";
import type { LibraryAssetWrite } from "../../src/server/free-library-operations.js";
import type { MemoryStore } from "./memory-store.js";
export class MemoryFreeStore implements FreeStore {
  constructor(readonly content?: MemoryStore) {}
  rows = new Map<string, FreeRecord>();
  failPartition?: string;
  async get<T extends FreeRecord>(
    p: string,
    k: T["kind"],
    id: string,
  ): Promise<T | undefined> {
    return structuredClone(this.rows.get(`${p}:${k}:${id}`)) as T | undefined;
  }
  async list<T extends FreeRecord>(
    kind: T["kind"],
    conversationId?: string,
  ): Promise<T[]> {
    return structuredClone(
      [...this.rows.entries()]
        .filter(
          ([key, r]) =>
            key.startsWith("library:") &&
            r.kind === kind &&
            (!conversationId || r.conversationId === conversationId),
        )
        .map(([, r]) => r),
    ) as T[];
  }
  async transaction(
    p: string,
    writes: FreeWrite[],
    asset?: LibraryAssetWrite,
    story?: StoryWrite,
  ) {
    freeOperations(p, writes, asset, story);
    if (this.failPartition === p)
      throw new AppError(503, "injected storage failure");
    for (const w of writes)
      if (
        (this.rows.get(`${p}:${w.record.kind}:${w.record.id}`)?.revision ??
          null) !== w.revision
      )
        throw new AppError(409, "free_revision_conflict");
    if (story) {
      if (!this.content) throw Error("Missing content store");
      const business =
        "initialization" in story
          ? [
              story.initialization.story,
              ...story.initialization.assets,
              ...(story.initialization.chapter
                ? [story.initialization.chapter]
                : []),
            ]
          : [{ entity: story.chapter, baseRevision: null }];
      if (
        "chapter" in story &&
        this.content.heads.get(`${p}:${p}`)?.revision !== story.story.revision
      )
        throw new AppError(409, "revision_conflict");
      for (const a of business)
        if (
          (this.content.heads.get(`${p}:${a.entity.id}`)?.revision ?? null) !==
            a.baseRevision ||
          this.content.history.has(`${a.entity.id}:${a.entity.currentVersion}`)
        )
          throw new AppError(409, "revision_conflict");
      for (const a of business) {
        this.content.heads.set(`${p}:${a.entity.id}`, {
          ...structuredClone(a.entity),
          revision: randomUUID(),
        });
        this.content.history.set(
          `${a.entity.id}:${a.entity.currentVersion}`,
          structuredClone(a.entity),
        );
      }
      if ("chapter" in story)
        this.content.heads.set(`${p}:${p}`, {
          ...structuredClone(story.story),
          revision: randomUUID(),
        });
    }
    if (asset) {
      if (!this.content) throw Error("Missing content store");
      const e = asset.entity,
        old = this.content.heads.get(`null:${e.id}`);
      if (
        (old?.revision ?? null) !== asset.revision ||
        this.content.history.has(`${e.id}:${e.currentVersion}`) ||
        (old && e.currentVersion !== old.currentVersion + 1)
      )
        throw new AppError(409, "revision_conflict");
      this.content.heads.set(`null:${e.id}`, {
        ...structuredClone(e),
        revision: randomUUID(),
      });
      this.content.history.set(
        `${e.id}:${e.currentVersion}`,
        structuredClone(e),
      );
    }
    const saved = writes.map((w) => ({
      ...structuredClone(w.record),
      revision: randomUUID(),
    }));
    for (const r of saved) this.rows.set(`${p}:${r.kind}:${r.id}`, r);
    return structuredClone(saved);
  }
}
