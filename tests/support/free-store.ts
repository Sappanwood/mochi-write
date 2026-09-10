import { randomUUID } from "node:crypto";
import type { FreeRecord } from "../../src/shared/free.js";
import { AppError } from "../../src/shared/model.js";
import {
  freeOperations,
  type FreeStore,
  type FreeWrite,
} from "../../src/server/free-store.js";
import type { CharacterWrite } from "../../src/server/free-character-operations.js";
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
    character?: CharacterWrite,
  ) {
    freeOperations(p, writes, character);
    if (this.failPartition === p)
      throw new AppError(503, "injected storage failure");
    for (const w of writes)
      if (
        (this.rows.get(`${p}:${w.record.kind}:${w.record.id}`)?.revision ??
          null) !== w.revision
      )
        throw new AppError(409, "free_revision_conflict");
    if (character) {
      if (!this.content) throw Error("Missing content store");
      const e = character.entity,
        old = this.content.heads.get(`null:${e.id}`);
      if (
        (old?.revision ?? null) !== character.revision ||
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
