import { bundleFileByteLimit } from "../shared/bundle-limits.js";
import { portraitFilePattern } from "../shared/portrait.js";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { dirname, join, parse, relative, resolve } from "node:path";
import { AppError, type BundleFile } from "../shared/model.js";
import { checkFiles, limits, safePath } from "./markdown.js";
async function directory(path: string) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split("/").filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new AppError(400, "目录不得包含 symlink");
  }
}
export async function readBundle(input: string): Promise<BundleFile[]> {
  const root = resolve(input);
  await directory(root);
  const files: BundleFile[] = [];
  let total = 0;
  const names = await readdir(root);
  const hasManifest = names.includes("manifest.json");
  async function walk(path: string) {
    const info = await lstat(path);
    if (info.isSymbolicLink())
      throw new AppError(400, "源目录不得包含 symlink");
    if (info.isDirectory()) {
      for (const name of await readdir(path)) await walk(join(path, name));
      return;
    }
    if (!info.isFile()) throw new AppError(400, "源文件必须是普通文件");
    const rel = safePath(relative(root, path));
    if (
      !rel.endsWith(".md") &&
      rel !== "manifest.json" &&
      !portraitFilePattern.test(rel)
    )
      throw new AppError(400, "源目录包含不支持的文件");
    const fileLimit = bundleFileByteLimit(rel);
    if (files.length >= limits.files || info.size > fileLimit)
      throw new AppError(400, "文件数量或大小超限");
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let text: string;
    try {
      if (!(await handle.stat()).isFile())
        throw new AppError(400, "源文件类型已变化");
      const buffer = Buffer.alloc(fileLimit + 1);
      let size = 0;
      while (size < buffer.length) {
        const chunk = await handle.read(
          buffer,
          size,
          buffer.length - size,
          null,
        );
        if (!chunk.bytesRead) break;
        size += chunk.bytesRead;
      }
      total += size;
      if (size > fileLimit || total > limits.batchBytes)
        throw new AppError(400, "文件或批次大小超限");
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, size),
      );
    } finally {
      await handle.close();
    }
    files.push({ path: rel, text });
  }
  for (const name of names) {
    if (hasManifest || ["library", "projects"].includes(name))
      await walk(join(root, name));
  }
  checkFiles(files);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
export async function writeBundle(
  target: string,
  files: BundleFile[],
): Promise<void> {
  checkFiles(files);
  const root = resolve(target);
  await directory(dirname(root));
  await mkdir(root);
  for (const file of [
    ...files.filter((f) => f.path !== "manifest.json"),
    ...files.filter((f) => f.path === "manifest.json"),
  ]) {
    const parts = file.path.split("/");
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      try {
        await mkdir(parent);
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "EEXIST"
        ))
          throw error;
      }
      await directory(parent);
    }
    await directory(parent);
    await writeFile(join(root, file.path), file.text, {
      flag: "wx",
      encoding: "utf8",
      mode: 0o600,
    });
  }
}
