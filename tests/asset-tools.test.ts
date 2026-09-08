import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AssetTools } from "../src/server/asset-tools.js";
import { entity } from "../src/server/entities.js";
import { MemoryStore } from "./support/memory-store.js";

async function fixture() {
  const store = new MemoryStore();
  const story = randomUUID();
  const add = (
    kind: "setting" | "outline" | "snapshot" | "chapter",
    name: string,
    markdown: string,
    projectId = story,
  ) =>
    store.commit(
      entity(
        kind,
        { name, markdown, genres: [], ageBand: "", sourceMetadata: {} },
        projectId,
      ),
      null,
    );
  const source = vi.fn(async () => {});
  const tools = new AssetTools(store);
  const context = { storyId: story, recordSource: source };
  return { store, story, add, source, tools, context };
}

describe("story asset tools", () => {
  it("finds body keywords, returns snippets and never includes other stories or masters", async () => {
    const f = await fixture();
    const own = await f.add(
      "snapshot",
      "人物",
      "前言\n" + "背景".repeat(300) + "LIGHTHOUSE 密码",
    );
    await f.add("chapter", "foreign lighthouse", "secret", randomUUID());
    await f.store.commit(
      entity("character", {
        name: "master lighthouse",
        markdown: "secret",
        genres: [],
        ageBand: "",
        sourceMetadata: {},
      }),
      null,
    );
    const result = await f.tools.search(f.context, { query: "lighthouse" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      asset_id: own.id,
      revision: own.revision,
      kind: "snapshot",
    });
    expect(result.items[0]!.summary).toContain("LIGHTHOUSE");
    expect(result.items[0]!.summary.length).toBeLessThanOrEqual(512);
    expect(f.source).not.toHaveBeenCalled();
    expect(await f.tools.search(f.context, { query: "不存在" })).toEqual({
      items: [],
      next_cursor: null,
    });
  });
  it("paginates all kinds deterministically and rejects changed conditions, tampering and changed data", async () => {
    const f = await fixture();
    for (const kind of ["setting", "outline", "snapshot", "chapter"] as const)
      await f.add(kind, kind, "body");
    const first = await f.tools.search(f.context, { query: "", limit: 2 });
    const second = await f.tools.search(f.context, {
      query: "",
      limit: 2,
      cursor: first.next_cursor,
    });
    expect([...first.items, ...second.items].map((x) => x.kind)).toEqual([
      "chapter",
      "outline",
      "setting",
      "snapshot",
    ]);
    expect(second.next_cursor).toBeNull();
    for (const input of [
      { query: "changed" },
      { limit: 1 },
      { kind: "chapter" },
      { cursor: "forged" },
    ]) {
      await expect(
        f.tools.search(f.context, {
          query: "",
          limit: 2,
          cursor: first.next_cursor,
          ...input,
        }),
      ).rejects.toMatchObject({ code: "invalid_cursor" });
    }
    await expect(
      f.tools.search(
        { ...f.context, storyId: randomUUID() },
        { query: "", limit: 2, cursor: first.next_cursor },
      ),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
    await f.add("chapter", "new", "body");
    await expect(
      f.tools.search(f.context, {
        query: "",
        limit: 2,
        cursor: first.next_cursor,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });
  it("reads exact current text and records only successful full reads", async () => {
    const f = await fixture();
    const doc = await f.add("chapter", "章", "\r\n精确正文\n ");
    expect(
      await f.tools.read(f.context, {
        asset_id: doc.id,
        revision: doc.revision,
      }),
    ).toEqual({
      asset_id: doc.id,
      kind: "chapter",
      title: "章",
      revision: doc.revision,
      content: doc.content.markdown,
    });
    expect(f.source).toHaveBeenCalledWith({
      asset_id: doc.id,
      kind: "chapter",
      title: "章",
      revision: doc.revision,
    });
    await f.store.commit({ ...doc, currentVersion: 2 }, doc.revision);
    await expect(
      f.tools.read(f.context, { asset_id: doc.id, revision: doc.revision }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    const latest = (await f.store.get(doc.id, f.story))!;
    await f.store.commit(
      { ...latest, currentVersion: 3, deleted: true },
      latest.revision,
    );
    await expect(
      f.tools.read(f.context, { asset_id: doc.id, revision: latest.revision }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      f.tools.read(f.context, { asset_id: randomUUID(), revision: "1" }),
    ).rejects.toMatchObject({ code: "not_found" });
    const foreign = await f.add("chapter", "other", "secret", randomUUID());
    await expect(
      f.tools.read(f.context, {
        asset_id: foreign.id,
        revision: foreign.revision,
      }),
    ).rejects.toMatchObject({ code: "forbidden_scope" });
    expect(f.source).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid arguments and oversized reads/scans without truncation", async () => {
    const f = await fixture();
    for (const input of [
      { query: "x", limit: 21 },
      { query: "x", limit: 0 },
      { query: "x", story_id: f.story },
      { query: "x".repeat(257) },
    ])
      await expect(f.tools.search(f.context, input)).rejects.toMatchObject({
        code: "invalid_arguments",
      });
    const doc = await f.add("chapter", "large", "中".repeat(23000));
    await expect(
      f.tools.read(f.context, { asset_id: doc.id, revision: doc.revision }),
    ).rejects.toMatchObject({ code: "result_too_large" });
    await expect(
      f.tools.read(f.context, { asset_id: doc.id }),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    const page = {
      items: Array.from({ length: 1001 }, (_, i) => ({
        ...doc,
        id: String(i),
      })),
    };
    vi.spyOn(f.store, "list").mockResolvedValue(page);
    await expect(
      f.tools.search(f.context, { query: "" }),
    ).rejects.toMatchObject({ code: "result_too_large" });
  });
  it("rejects changed or deleted records between pages even outside the matching kind", async () => {
    const f = await fixture();
    await f.add("chapter", "one", "body");
    await f.add("chapter", "two", "body");
    const setting = await f.add("setting", "setting", "body");
    const first = await f.tools.search(f.context, {
      query: "",
      kind: "chapter",
      limit: 1,
    });
    await f.store.commit(
      { ...setting, currentVersion: 2, deleted: true },
      setting.revision,
    );
    await expect(
      f.tools.search(f.context, {
        query: "",
        kind: "chapter",
        limit: 1,
        cursor: first.next_cursor,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });
  it("limits a repeated storage continuation and refuses to record an unreadable result", async () => {
    const f = await fixture();
    vi.spyOn(f.store, "list").mockResolvedValue({ items: [], cursor: "again" });
    await expect(
      f.tools.search(f.context, { query: "" }),
    ).rejects.toMatchObject({ code: "result_too_large" });
    expect(f.store.list).toHaveBeenCalledTimes(50);
    const doc = await f.add("outline", "outline", "正文");
    f.source.mockRejectedValueOnce(new Error("persistence failed"));
    await expect(
      f.tools.read(f.context, { asset_id: doc.id, revision: doc.revision }),
    ).rejects.toThrow("persistence failed");
  });
});
