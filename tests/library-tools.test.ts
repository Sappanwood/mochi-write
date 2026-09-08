import { expect, it, vi } from "vitest";
import { LibraryTools } from "../src/server/library-tools.js";
import { Library } from "../src/server/library.js";
import { MemoryStore } from "./support/memory-store.js";
import type { AssetSource } from "../src/shared/creative-tools.js";
it("filters library metadata before exact reads and retains only sources actually read in the same conversation", async () => {
  const store = new MemoryStore(),
    library = new Library(store),
    tools = new LibraryTools(store);
  const input = {
    name: "林舟",
    markdown: "秘密正文",
    genres: ["悬疑"],
    ageBand: "青年",
    sourceMetadata: {
      gender: "女",
      occupation: "侦探",
      traits: ["冷静"],
      tags: ["主角"],
    },
  };
  const a = await library.create("character", input);
  await library.create("character", {
    ...input,
    name: "林舟",
    sourceMetadata: { occupation: "教师" },
  });
  const sources: AssetSource[] = [];
  const context = {
    storyId: "reserved",
    recordSource: async (s: AssetSource) => {
      sources.push(s);
    },
    librarySources: async () => sources,
  };
  const get = vi.spyOn(store, "get");
  const found = await tools.search({
    kind: "character",
    occupation: "侦",
    trait: "冷",
    gender: "女",
    genre: "悬疑",
    limit: 1,
  });
  expect(found.items).toHaveLength(1);
  expect(found.items[0]!.asset_id).toBe(a.id);
  expect(JSON.stringify(found)).not.toContain("秘密正文");
  expect(get).not.toHaveBeenCalled();
  const read = await tools.read(context, {
    asset_id: a.id,
    revision: a.revision,
  });
  expect(read.content.markdown).toBe(input.markdown);
  expect(sources).toHaveLength(1);
  const updated = await library.save(a.id, a.revision, {
    ...input,
    markdown: "新正文",
  });
  await library.remove(a.id, updated.revision);
  expect(
    (await tools.read(context, { asset_id: a.id, revision: a.revision }))
      .content.markdown,
  ).toBe(input.markdown);
  await expect(
    tools.read(
      { ...context, librarySources: async () => [] },
      { asset_id: a.id, revision: a.revision },
    ),
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    tools.search({ kind: "world", genre: "invalid" }),
  ).rejects.toMatchObject({ code: "invalid_arguments" });
});
it("paginates duplicate names, binds filters, browses incomplete legacy metadata and refuses oversized exact reads", async () => {
  const store = new MemoryStore(),
    library = new Library(store),
    tools = new LibraryTools(store);
  const input = {
    name: "同名",
    markdown: "正文",
    genres: ["奇幻"],
    ageBand: "青年",
    sourceMetadata: {},
  };
  const a = await library.create("world", input);
  await library.create("world", input);
  const first = await tools.search({ kind: "world", name: "同名", limit: 1 });
  expect(first.items).toHaveLength(1);
  expect(first.next_cursor).toBeTruthy();
  const second = await tools.search({
    kind: "world",
    name: "同名",
    limit: 1,
    cursor: first.next_cursor,
  });
  expect(second.items[0]!.asset_id).not.toBe(first.items[0]!.asset_id);
  expect(second.next_cursor).toBeNull();
  await expect(
    tools.search({
      kind: "character",
      name: "同名",
      limit: 1,
      cursor: first.next_cursor,
    }),
  ).rejects.toMatchObject({ code: "invalid_cursor" });
  expect(
    (await tools.search({ kind: "world", occupation: "侦探" })).items,
  ).toEqual([]);
  for (const input of [
    { kind: "world", limit: 21 },
    { kind: "world", name: "x".repeat(129) },
    { kind: "world", projectId: "other" },
  ])
    await expect(tools.search(input)).rejects.toMatchObject({
      code: "invalid_arguments",
    });
  const changed = await library.save(a.id, a.revision, {
    ...input,
    markdown: "长".repeat(22000),
  });
  const recordSource = vi.fn(async () => {}),
    context = { storyId: "reserved", recordSource };
  await expect(
    tools.read(context, { asset_id: a.id, revision: a.revision }),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  await expect(
    tools.read(context, { asset_id: a.id, revision: changed.revision }),
  ).rejects.toMatchObject({ code: "result_too_large" });
  expect(recordSource).not.toHaveBeenCalled();
});
