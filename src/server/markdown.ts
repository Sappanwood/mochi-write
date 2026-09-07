import {
  bundleLimits as limits,
  bundleFileByteLimit,
} from "../shared/bundle-limits.js";
import { posix } from "node:path";
import { parseDocument } from "yaml";
import {
  AppError,
  contentSchema,
  type BundleFile,
  type Content,
} from "../shared/model.js";
export { limits };
export function safePath(path: string) {
  if (
    !path ||
    path.length > 1024 ||
    path.includes("\\") ||
    [...path].some((c) => c.charCodeAt(0) < 32) ||
    path.startsWith("/") ||
    path.includes(":") ||
    path.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new AppError(400, "包内路径无效");
  return path;
}
export function checkFiles(files: BundleFile[]) {
  if (!files.length || files.length > limits.files)
    throw new AppError(400, "文件数量超限或为空");
  const paths = new Set<string>();
  let total = 0;
  for (const f of files) {
    safePath(f.path);
    if (paths.has(f.path)) throw new AppError(400, "重复路径");
    paths.add(f.path);
    const size = Buffer.byteLength(f.text);
    total += size;
    if (size > bundleFileByteLimit(f.path) || total > limits.batchBytes)
      throw new AppError(400, "文件或批次大小超限");
    if (f.text.includes("\uFFFD") || f.text.includes("\0"))
      throw new AppError(400, "文档必须是有效 UTF-8 文本");
  }
}
export function parseMarkdown(file: BundleFile): Content {
  let markdown = file.text;
  let metadata: Record<string, unknown> = {};
  if (/^---\r?\n/.test(markdown)) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
    if (!match) throw new AppError(400, "frontmatter 未闭合", [file.path]);
    const doc = parseDocument(match[1]!, { uniqueKeys: true });
    if (doc.errors.length)
      throw new AppError(400, "frontmatter 无效", [file.path]);
    try {
      const parsed: unknown = doc.toJS({ maxAliasCount: 20 });
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error();
      metadata = parsed as Record<string, unknown>;
    } catch {
      throw new AppError(400, "frontmatter 必须是有限映射", [file.path]);
    }
    markdown = markdown.slice(match[0].length);
  }
  const name =
    metadata.name ??
    metadata.title ??
    metadata.world ??
    posix.basename(file.path, ".md");
  const g = metadata.genres ?? [];
  const genres = typeof g === "string" ? [g] : g;
  const result = contentSchema.safeParse({
    name,
    markdown,
    genres,
    ageBand: metadata.age_band ?? "",
    sourceMetadata: metadata,
  });
  if (!result.success)
    throw new AppError(400, "字段类型或大小无效", [file.path]);
  return result.data;
}
export function resolveReference(from: string, ref: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(ref);
  } catch {
    throw new AppError(400, "引用编码无效", [from]);
  }
  if (
    decoded.includes("\\") ||
    decoded.startsWith("/") ||
    decoded.includes(":")
  )
    throw new AppError(400, "引用路径无效", [from]);
  const resolved = decoded.startsWith("library/")
    ? decoded
    : posix.join(posix.dirname(from), decoded);
  return safePath(resolved);
}
export function references(file: BundleFile) {
  return [
    ...file.text.matchAll(/(?:\.\.\/|library\/|snapshots\/)[^\s`|)<>"']+\.md/g),
  ].map((m) => resolveReference(file.path, m[0]));
}
