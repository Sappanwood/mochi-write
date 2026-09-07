import {
  mkdtemp,
  mkdir,
  readFile,
  symlink,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBundle, writeBundle } from "../src/server/filesystem.js";
const roots: string[] = [];
async function temp() {
  const p = await mkdtemp(join(tmpdir(), "mwt-files-"));
  roots.push(p);
  return p;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
describe("trusted Linux filesystem boundary", () => {
  it("exports Markdown without clobbering; two publishers cannot both win", async () => {
    const root = await temp(),
      target = join(root, "export");
    const files = [
      { path: "manifest.json", text: "{}" },
      { path: "library/character/a.md", text: "original" },
    ];
    const results = await Promise.allSettled([
      writeBundle(target, files),
      writeBundle(target, files),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await readFile(join(target, "library/character/a.md"), "utf8")).toBe(
      "original",
    );
    await expect(
      writeBundle(target, [{ path: "manifest.json", text: "changed" }]),
    ).rejects.toThrow();
  });
  it("reads only selected source data and never alters source", async () => {
    const root = await temp();
    await mkdir(join(root, "library"));
    await writeFile(join(root, "library/a.md"), "original");
    await mkdir(join(root, ".pi"));
    await writeFile(join(root, ".pi/private"), "credential fixture");
    expect(await readBundle(root)).toEqual([
      { path: "library/a.md", text: "original" },
    ]);
    expect(await readFile(join(root, "library/a.md"), "utf8")).toBe("original");
  });
  it("rejects symlink files, roots, and ancestors", async () => {
    const root = await temp();
    await mkdir(join(root, "real"));
    await mkdir(join(root, "real/library"));
    await writeFile(join(root, "real/library/a.md"), "data");
    await symlink(join(root, "real"), join(root, "alias"));
    await expect(readBundle(join(root, "alias"))).rejects.toThrow();
    await expect(
      writeBundle(join(root, "alias/output"), [{ path: "x.md", text: "x" }]),
    ).rejects.toThrow();
    await symlink(
      join(root, "real/library/a.md"),
      join(root, "real/library/link.md"),
    );
    await expect(readBundle(join(root, "real"))).rejects.toThrow();
  });
  it("rejects invalid UTF-8 and escaping output before creating output", async () => {
    const root = await temp();
    await mkdir(join(root, "library"));
    await writeFile(join(root, "library/a.md"), Buffer.from([0xff]));
    await expect(readBundle(root)).rejects.toThrow();
    await expect(
      writeBundle(join(root, "export"), [{ path: "../escape", text: "x" }]),
    ).rejects.toThrow();
  });
});

describe("manifest file limit", () => {
  it("reads and writes manifests above 1 MiB without normalizing the bytes", async () => {
    const root = await temp(),
      target = join(root, "large-manifest");
    const text = " ".repeat(1024 * 1024 + 32);
    const files = [
      { path: "manifest.json", text },
      { path: "library/a.md", text: "small" },
    ];
    await writeBundle(target, files);
    expect(await readBundle(target)).toEqual(
      [...files].sort((a, b) => a.path.localeCompare(b.path)),
    );
    expect((await readFile(join(target, "manifest.json"))).length).toBe(
      Buffer.byteLength(text),
    );
  });
  it("rejects oversized manifests and ordinary Markdown before loading them", async () => {
    const root = await temp();
    await writeFile(
      join(root, "manifest.json"),
      " ".repeat(16 * 1024 * 1024 + 1),
    );
    await expect(readBundle(root)).rejects.toThrow();
    await writeFile(join(root, "manifest.json"), "{}");
    await writeFile(join(root, "large.md"), " ".repeat(1024 * 1024 + 1));
    await expect(readBundle(root)).rejects.toThrow();
  });
});
