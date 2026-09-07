import { expect, test } from "vitest";
import { checkFiles, limits } from "../src/server/markdown.js";
import { exportFiles } from "../src/server/export.js";
import { importFiles, preflight } from "../src/server/import.js";
import { entity, hash } from "../src/server/entities.js";
import { MemoryStore } from "./support/memory-store.js";
test("the root export manifest may exceed the ordinary Markdown limit", () => {
  expect(() =>
    checkFiles([
      { path: "manifest.json", text: " ".repeat(limits.documentBytes + 1) },
    ]),
  ).not.toThrow();
});
test("ordinary Markdown and nested manifest names retain the 1 MiB limit", () => {
  for (const path of ["library/large.md", "projects/manifest.json"])
    expect(() =>
      checkFiles([{ path, text: " ".repeat(limits.documentBytes + 1) }]),
    ).toThrow();
});
test("the manifest remains bounded by the aggregate 16 MiB budget", () => {
  expect(() =>
    checkFiles([
      { path: "manifest.json", text: " ".repeat(limits.batchBytes + 1) },
    ]),
  ).toThrow();
  expect(() =>
    checkFiles([
      { path: "manifest.json", text: " ".repeat(limits.batchBytes) },
      { path: "library/a.md", text: "x" },
    ]),
  ).toThrow();
});
test("large provenance manifests export and reimport without dropping source metadata", async () => {
  const original = new MemoryStore();
  const raw = "synthetic source ".repeat(3000);
  for (let i = 0; i < 30; i++)
    await original.commit(
      {
        ...entity("character", {
          name: `synthetic-${i}`,
          markdown: "Synthetic text.",
          genres: [],
          ageBand: "",
          sourceMetadata: {},
        }),
        source: {
          path: `library/characters/synthetic-${i}.md`,
          raw,
          hash: hash(raw),
        },
      },
      null,
    );
  const exported = await exportFiles(original);
  expect(
    Buffer.byteLength(exported.find((f) => f.path === "manifest.json")!.text),
  ).toBeGreaterThan(limits.documentBytes);
  expect(preflight(exported, "restore")).toHaveLength(30);
  const restored = new MemoryStore();
  expect(await importFiles(restored, exported, "restore")).toEqual({
    created: 30,
    skipped: 0,
  });
  for (const doc of original.heads.values())
    expect((await restored.get(doc.id, null))?.source).toEqual(doc.source);
});
