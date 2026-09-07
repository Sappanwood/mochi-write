import { clean } from "../src/server/entities.js";
import { readdir, readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { preflight, importFiles } from "../src/server/import.js";
import { exportFiles } from "../src/server/export.js";
import { MemoryStore } from "./support/memory-store.js";
import type { BundleFile } from "../src/shared/model.js";
export async function fixture(): Promise<BundleFile[]> {
  const root = resolve("tests/fixtures/novel");
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries
      .filter((e) => e.isFile())
      .map(async (e) => {
        const path = resolve(e.parentPath, e.name);
        return {
          path: relative(root, path),
          text: await readFile(path, "utf8"),
        };
      }),
  );
}
describe("Markdown import and export", () => {
  it("preflights legacy fields, copies every routed asset, and retains base plus delta", async () => {
    const docs = preflight(await fixture(), randomUUID());
    expect(docs.filter((d) => d.kind === "snapshot")).toHaveLength(2);
    const character = docs.find((d) => d.kind === "character")!;
    expect(character.content.sourceMetadata.custom_field).toEqual({
      color: "蓝",
    });
    const snapshot = docs.find(
      (d) => d.kind === "snapshot" && d.sourceAssetId === character.id,
    )!;
    expect(snapshot.content.markdown).toContain("守护灯塔");
    expect(snapshot.content.markdown).toContain("褪色的海图");
    expect(snapshot.source?.delta).toContain("extra_snapshot");
    expect(
      docs
        .filter((d) => d.kind === "chapter")
        .map((d) => d.order)
        .sort(),
    ).toEqual([1, 2]);
  });
  it("retries without duplication and rejects changed content for an existing batch", async () => {
    const store = new MemoryStore(),
      files = await fixture(),
      batch = randomUUID();
    expect((await importFiles(store, files, batch)).created).toBeGreaterThan(0);
    expect((await importFiles(store, files, batch)).created).toBe(0);
    files.find((f) => f.path.startsWith("library/characters"))!.text +=
      "changed";
    await expect(importFiles(store, files, batch)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
  it("round trips current content, unknown fields, IDs, versions and independent snapshots", async () => {
    const store = new MemoryStore();
    await importFiles(store, await fixture(), randomUUID());
    const exported = await exportFiles(store);
    const next = new MemoryStore();
    await importFiles(next, exported, randomUUID());
    const a = [...store.heads.values()]
      .filter((d) => d.kind !== "import")
      .map(clean)
      .sort((x, y) => x.id.localeCompare(y.id));
    const b = [...next.heads.values()]
      .filter((d) => d.kind !== "import")
      .map(clean)
      .sort((x, y) => x.id.localeCompare(y.id));
    expect(b).toEqual(a);
    expect((await importFiles(next, exported, randomUUID())).created).toBe(0);
  });
  it("fails all preflight before writes for missing references", async () => {
    const store = new MemoryStore();
    const files = (await fixture()).filter(
      (f) => !f.path.startsWith("library/characters"),
    );
    await expect(importFiles(store, files, randomUUID())).rejects.toMatchObject(
      { statusCode: 400 },
    );
    expect(store.heads.size).toBe(0);
  });
  it.each(["../escape.md", "/absolute.md", "library/../escape.md", "a\\b.md"])(
    "rejects unsafe paths %s",
    async (path) => {
      expect(() => preflight([{ path, text: "safe" }], randomUUID())).toThrow();
    },
  );
  it("rejects duplicate paths, malformed YAML, duplicate chapter order and oversize files", async () => {
    const files = await fixture();
    expect(() => preflight([...files, files[0]!], randomUUID())).toThrow();
    expect(() =>
      preflight(
        [
          {
            path: "library/characters/x.md",
            text: "---\nname: [bad\n---\ntext",
          },
        ],
        randomUUID(),
      ),
    ).toThrow();
    expect(() =>
      preflight(
        [...files, { path: "projects/灯塔/story/ch001.md", text: "collision" }],
        randomUUID(),
      ),
    ).toThrow();
    expect(() =>
      preflight(
        [{ path: "library/characters/x.md", text: "x".repeat(1048577) }],
        randomUUID(),
      ),
    ).toThrow();
  });
  it("rejects manifest tampering and preserves import progress after storage failure", async () => {
    const store = new MemoryStore();
    const files = await fixture();
    store.failNext = true;
    await expect(importFiles(store, files, "repeatable")).rejects.toThrow();
    await importFiles(store, files, "repeatable");
    const exported = await exportFiles(store);
    exported.find((f) => f.path.endsWith(".md"))!.text += "tampered";
    expect(() => preflight(exported, randomUUID())).toThrow();
  });
});

it("keeps a partially initialized story hidden and resumes its original IDs", async () => {
  const store = new MemoryStore(),
    files = await fixture(),
    batch = "partial";
  const commit = store.commit.bind(store);
  let writes = 0;
  store.commit = async (e, r) => {
    if (++writes === 3) throw new Error("storage unavailable");
    return commit(e, r);
  };
  await expect(importFiles(store, files, batch)).rejects.toThrow(
    "storage unavailable",
  );
  expect((await store.list({ kind: "story" })).items).toHaveLength(0);
  const staged = [...store.heads.values()].find((d) => d.kind === "story")!;
  expect(staged.status).toBe("building");
  store.commit = commit;
  await importFiles(store, files, batch);
  expect((await store.list({ kind: "story" })).items[0]?.id).toBe(staged.id);
});

it("keeps one vocabulary across batches and validates new assets against it", async () => {
  const store = new MemoryStore();
  const files = await fixture();
  files.push({
    path: "library/_vocabulary.md",
    text: "# 词表\n\n## genres\n| 取值 | 含义 |\n| --- | --- |\n| 奇幻 | 示例 |\n| 海洋奇幻 | 示例 |\n\n## age_band\n| 取值 | 判定 |\n| --- | --- |\n| 成年 | 示例 |\n",
  });
  await importFiles(store, files, "vocab-one");
  await importFiles(store, files, "vocab-two");
  expect(
    (await store.list({ projectId: null, kind: "vocabulary" })).items,
  ).toHaveLength(1);
  const extra = [
    {
      path: "library/characters/新角色.md",
      text: "---\nname: 新角色\ngenres: [海洋奇幻]\nage_band: 成年\n---\n正文",
    },
  ];
  await expect(importFiles(store, extra, "vocab-three")).resolves.toMatchObject(
    { created: 1 },
  );
});

it("exports edited names and controlled fields in Markdown frontmatter", async () => {
  const { Library } = await import("../src/server/library.js");
  const { parseMarkdown } = await import("../src/server/markdown.js");
  const store = new MemoryStore();
  await importFiles(store, await fixture(), "editable-export");
  const original = (await store.list({ kind: "character", projectId: null }))
    .items[0]!;
  await new Library(store).save(original.id, original.revision, {
    ...original.content,
    name: "岸灯",
    genres: ["悬疑"],
  });
  const file = (await exportFiles(store)).find(
    (f) => f.path === `library/character/${original.id}.md`,
  )!;
  const exported = parseMarkdown(file);
  expect(exported.sourceMetadata.name).toBe("岸灯");
  expect(exported.sourceMetadata.genres).toEqual(["悬疑"]);
  expect(exported.sourceMetadata.custom_field).toEqual({ color: "蓝" });
});
