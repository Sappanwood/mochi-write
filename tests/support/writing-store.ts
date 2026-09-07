import type { WritingStore } from "../../src/server/writing-store.js";
import { AppError, type Entity } from "../../src/shared/model.js";
import type { Conversation, DraftRecord } from "../../src/shared/writing.js";
import { randomUUID } from "node:crypto";
import { MemoryStore } from "./memory-store.js";
export class MemoryWritingStore implements WritingStore {
  readonly sessions = new Map<string, Conversation>();
  readonly values = new Map<string, DraftRecord>();
  readonly requests = new Map<string, string>();
  constructor(readonly content: MemoryStore) {}
  async reserve(id: string, digest: string, p: string | null) {
    const binding = JSON.stringify([digest, p]);
    if (this.requests.has(id) && this.requests.get(id) !== binding)
      throw new AppError(409, "请求 ID 冲突");
    this.requests.set(id, binding);
  }
  async conversations(p: string | null) {
    return structuredClone(
      [...this.sessions.values()].filter((c) => c.projectId === p),
    );
  }
  async createConversation(c: Conversation) {
    this.sessions.set(c.id, structuredClone(c));
  }
  async get(id: string, p: string | null) {
    const d = this.values.get(`${p}:${id}`);
    return d ? structuredClone(d) : undefined;
  }
  async drafts(p: string | null, c: string) {
    return structuredClone(
      [...this.values.values()].filter(
        (d) => d.projectId === p && d.conversationId === c,
      ),
    );
  }
  async save(d: DraftRecord, revision: string | null) {
    const key = `${d.projectId}:${d.id}`;
    if ((this.values.get(key)?.revision ?? null) !== revision)
      throw new AppError(409, "版本冲突");
    const next = { ...structuredClone(d), revision: randomUUID() };
    this.values.set(key, next);
    return structuredClone(next);
  }
  async accept(d: DraftRecord, chapter: Entity, base: string | null) {
    const key = `${d.projectId}:${d.id}`;
    if (this.values.get(key)?.revision !== d.revision)
      throw new AppError(409, "版本冲突");
    await this.content.commit(chapter, base);
    this.values.set(key, {
      ...d,
      status: "accepted",
      resultVersion: chapter.currentVersion,
      revision: randomUUID(),
    });
  }
}
