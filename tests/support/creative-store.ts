import { randomUUID } from "node:crypto";
import { AppError, type Entity } from "../../src/shared/model.js";
import type {
  CreativeConversation,
  CreativeDraft,
  CreativeRecord,
  CreativeTask,
} from "../../src/shared/creative.js";
import {
  creativeOperations,
  creativeRecordId,
  type CreativeStore,
  type CreativeWrite,
} from "../../src/server/creative-store.js";
import { clean } from "../../src/server/entities.js";
import type { MemoryStore } from "./memory-store.js";

export class MemoryCreativeStore implements CreativeStore {
  readonly values = new Map<string, CreativeRecord>();
  readonly requests = new Map<string, string>();
  constructor(readonly content: MemoryStore) {}
  async reserve(id: string, digest: string, storyId: string) {
    const binding = JSON.stringify([digest, storyId]);
    if (this.requests.has(id) && this.requests.get(id) !== binding)
      throw new AppError(409, "请求 ID 冲突");
    this.requests.set(id, binding);
  }
  private key(storyId: string, kind: CreativeRecord["kind"], id: string) {
    return `${storyId}:${creativeRecordId(kind, id)}`;
  }
  private get<T extends CreativeRecord>(
    storyId: string,
    kind: T["kind"],
    id: string,
  ): T | undefined {
    return structuredClone(this.values.get(this.key(storyId, kind, id))) as
      T | undefined;
  }
  private query<T extends CreativeRecord>(
    kind: T["kind"],
    storyId?: string,
    conversationId?: string,
  ): T[] {
    return structuredClone(
      [...this.values.values()]
        .filter(
          (record) =>
            record.kind === kind &&
            (storyId === undefined || record.storyId === storyId) &&
            (conversationId === undefined ||
              ("conversationId" in record &&
                record.conversationId === conversationId)),
        )
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
    ) as T[];
  }
  async conversation(storyId: string, id: string) {
    return this.get<CreativeConversation>(storyId, "conversation", id);
  }
  async conversations(storyId: string) {
    return this.query<CreativeConversation>("conversation", storyId);
  }
  async task(storyId: string, id: string) {
    return this.get<CreativeTask>(storyId, "task", id);
  }
  async tasks(storyId: string, conversationId: string) {
    return this.query<CreativeTask>("task", storyId, conversationId);
  }
  async activeTasks() {
    return this.query<CreativeTask>("task").filter((task) =>
      ["interpreting", "pending", "running"].includes(task.status),
    );
  }
  async draft(storyId: string, id: string) {
    return this.get<CreativeDraft>(storyId, "draft", id);
  }
  async drafts(storyId: string, conversationId: string) {
    return this.query<CreativeDraft>("draft", storyId, conversationId);
  }
  async transaction(
    storyId: string,
    writes: CreativeWrite[],
    chapter?: Entity,
  ): Promise<CreativeRecord[]> {
    creativeOperations(storyId, writes, chapter);
    const keys = writes.map(({ record }) =>
      this.key(storyId, record.kind, record.id),
    );
    writes.forEach(({ revision }, index) => {
      if ((this.values.get(keys[index]!)?.revision ?? null) !== revision)
        throw new AppError(409, "版本冲突");
    });
    const nextChapter = chapter
      ? { ...clean(chapter), revision: randomUUID() }
      : undefined;
    const chapterKey = chapter ? `${storyId}:${chapter.id}` : undefined;
    const versionKey = chapter ? `${chapter.id}:1` : undefined;
    if (
      chapter &&
      (this.content.heads.has(chapterKey!) ||
        this.content.history.has(versionKey!))
    )
      throw new AppError(409, "章节已存在");
    if (this.content.failNext) {
      this.content.failNext = false;
      throw new AppError(503, "保存失败");
    }
    const saved = writes.map(({ record }) => ({
      ...structuredClone(record),
      revision: randomUUID(),
    }));
    // No awaits between validation and publication: test storage mirrors one Cosmos batch.
    if (nextChapter) {
      this.content.heads.set(chapterKey!, nextChapter);
      this.content.history.set(versionKey!, clean(nextChapter));
    }
    saved.forEach((record, index) => this.values.set(keys[index]!, record));
    return structuredClone(saved);
  }
}
