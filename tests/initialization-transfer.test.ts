import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { entity } from "../src/server/entities.js";
import { exportFiles } from "../src/server/export.js";
import { importFiles } from "../src/server/import.js";
import { MemoryStore } from "./support/memory-store.js";
it("exports empty ready stories without server markers and rejects client-supplied lifecycle flags", async () => {
  const store = new MemoryStore(),
    id = randomUUID();
  await store.commit(
    {
      ...entity(
        "story",
        {
          name: "无章作品",
          markdown: "",
          genres: [],
          ageBand: "",
          sourceMetadata: {},
        },
        id,
        id,
      ),
      status: "ready",
      initializationPending: true,
    },
    null,
  );
  const files = await exportFiles(store),
    manifest = JSON.parse(files.find((f) => f.path === "manifest.json")!.text);
  expect(manifest.entries).toHaveLength(1);
  expect(manifest.entries[0].attributes).not.toHaveProperty(
    "initializationPending",
  );
  expect(await importFiles(store, files, randomUUID())).toMatchObject({
    created: 0,
    skipped: 1,
  });
  manifest.entries[0].attributes.initializationPending = true;
  files.find((f) => f.path === "manifest.json")!.text =
    JSON.stringify(manifest);
  await expect(
    importFiles(new MemoryStore(), files, randomUUID()),
  ).rejects.toMatchObject({ statusCode: 400 });
});
it("rejects chapter import into an existing pending story without changing its head", async () => {
  const source = new MemoryStore(),
    target = new MemoryStore(),
    id = randomUUID();
  const story = {
    ...entity(
      "story",
      {
        name: "无章作品",
        markdown: "",
        genres: [],
        ageBand: "",
        sourceMetadata: {},
      },
      id,
      id,
    ),
    status: "ready" as const,
  };
  await source.commit(story, null);
  await source.commit(
    {
      ...entity(
        "chapter",
        {
          name: "首章",
          markdown: "正文",
          genres: [],
          ageBand: "",
          sourceMetadata: {},
        },
        id,
      ),
      order: 1,
    },
    null,
  );
  const original = await target.commit(
    { ...story, initializationPending: true },
    null,
  );
  await expect(
    importFiles(target, await exportFiles(source), randomUUID()),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect((await target.get(id, id))?.revision).toBe(original.revision);
  expect(
    (await target.list({ projectId: id, kind: "chapter" })).items,
  ).toHaveLength(0);
});
it("round-trips a generated snapshot without mother references and still rejects partial provenance", async () => {
  const store = new MemoryStore(),
    id = randomUUID();
  await store.commit(
    {
      ...entity(
        "story",
        {
          name: "故事",
          markdown: "",
          genres: [],
          ageBand: "",
          sourceMetadata: {},
        },
        id,
        id,
      ),
      status: "ready",
    },
    null,
  );
  await store.commit(
    entity(
      "snapshot",
      {
        name: "原创角色",
        markdown: "完整原创角色",
        genres: [],
        ageBand: "",
        sourceMetadata: {},
      },
      id,
    ),
    null,
  );
  const files = await exportFiles(store),
    restored = new MemoryStore();
  expect(await importFiles(restored, files, randomUUID())).toMatchObject({
    created: 2,
  });
  expect(
    (await restored.list({ projectId: id, kind: "snapshot" })).items[0]?.content
      .markdown,
  ).toBe("完整原创角色");
  const manifest = JSON.parse(
    files.find((f) => f.path === "manifest.json")!.text,
  );
  manifest.entries.find(
    (e: { kind: string }) => e.kind === "snapshot",
  ).attributes.sourceAssetId = randomUUID();
  files.find((f) => f.path === "manifest.json")!.text =
    JSON.stringify(manifest);
  await expect(
    importFiles(new MemoryStore(), files, randomUUID()),
  ).rejects.toMatchObject({ statusCode: 400 });
});
