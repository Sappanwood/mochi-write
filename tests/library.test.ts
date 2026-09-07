import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "./support/memory-store.js";
import { Library } from "../src/server/library.js";
import type { Content, Entity } from "../src/shared/model.js";
const content: Content = {
  name: "林舟",
  markdown: "灯塔管理员。",
  genres: ["奇幻"],
  ageBand: "成年",
  sourceMetadata: { custom: { preserved: true } },
};
export function story(): Entity {
  const id = randomUUID();
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id,
    kind: "story",
    projectId: id,
    createdAt: now,
    updatedAt: now,
    currentVersion: 1,
    status: "ready",
    content: { ...content, name: "灯塔" },
  };
}
describe("versioned library and independent snapshots", () => {
  it("persists edits, immutable history and unknown fields", async () => {
    const store = new MemoryStore();
    const lib = new Library(store);
    const created = await lib.create("character", content);
    const saved = await lib.save(created.id, created.revision, {
      ...content,
      name: "林舟 · 新版",
    });
    expect(saved.currentVersion).toBe(2);
    expect(saved.content.sourceMetadata).toMatchObject(content.sourceMetadata);
    expect((await store.get(created.id, null))?.content.name).toBe(
      "林舟 · 新版",
    );
    expect(store.history.get(`${created.id}:1`)?.content.name).toBe("林舟");
  });
  it("allows only one competing save and never overwrites a version", async () => {
    const store = new MemoryStore();
    const lib = new Library(store);
    const created = await lib.create("world", content);
    const outcomes = await Promise.allSettled(
      ["A", "B"].map((name) =>
        lib.save(created.id, created.revision, { ...content, name }),
      ),
    );
    expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((x) => x.status === "rejected")).toHaveLength(1);
    expect((await store.get(created.id, null))?.currentVersion).toBe(2);
  });
  it("rejects invalid controlled values without writing", async () => {
    const store = new MemoryStore();
    const lib = new Library(store);
    await expect(
      lib.create("character", { ...content, genres: ["不存在"] }),
    ).rejects.toThrow();
    expect((await store.list({ projectId: null })).items).toHaveLength(0);
  });
  it("snapshots survive template edit and deletion; later additions are idempotent", async () => {
    const store = new MemoryStore();
    const lib = new Library(store);
    const s = story();
    await store.commit(s, null);
    const master = await lib.create("character", content);
    const requestId = randomUUID();
    const snapshot = await lib.addSnapshot(s.id, master.id, requestId);
    const updated = await lib.save(master.id, master.revision, {
      ...content,
      markdown: "新的母版",
    });
    await lib.remove(master.id, updated.revision);
    expect((await store.get(snapshot.id, s.id))?.content.markdown).toBe(
      content.markdown,
    );
    expect((await lib.addSnapshot(s.id, master.id, requestId)).id).toBe(
      snapshot.id,
    );
    const edited = await store.commit(
      {
        ...snapshot,
        content: { ...content, markdown: "故事自己的修改" },
        currentVersion: 2,
      },
      snapshot.revision,
    );
    expect(edited.content.markdown).toBe("故事自己的修改");
    expect((await store.get(master.id, null))?.content.markdown).toBe(
      "新的母版",
    );
    expect((await store.get(master.id, null))?.deleted).toBe(true);
  });
});

it("rejects an object whose immutable version transaction would exceed the storage limit", async () => {
  const lib = new Library(new MemoryStore());
  await expect(
    lib.create("character", {
      ...content,
      sourceMetadata: { large: "x".repeat(800 * 1024) },
    }),
  ).rejects.toMatchObject({ statusCode: 400 });
});
