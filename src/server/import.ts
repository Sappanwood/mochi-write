import { Library } from "./library.js";
import { posix } from "node:path";
import { z } from "zod";
import {
  AppError,
  entitySchema,
  genres,
  ageBands,
  type BundleFile,
  type Entity,
  type Document,
} from "../shared/model.js";
import type { Store } from "./store.js";
import { clean, entity, hash, stableId } from "./entities.js";
import {
  checkFiles,
  parseMarkdown,
  references,
  resolveReference,
} from "./markdown.js";

const manifestSchema = z
  .object({
    schema: z.literal("mochi-write/export@1"),
    exportedAt: z.iso.datetime(),
    entries: z
      .array(
        z
          .object({
            path: z.string(),
            kind: z.string(),
            entityId: z.uuid(),
            projectId: z.uuid().nullable(),
            version: z.number().int().positive(),
            sha256: z.string(),
            attributes: z.record(z.string(), z.unknown()),
            fields: z.object({
              name: z.string(),
              genres: z.array(z.string()),
              ageBand: z.string(),
            }),
          })
          .strict(),
      )
      .max(999),
  })
  .strict();
function exported(files: BundleFile[]): Entity[] {
  const manifest = manifestSchema.parse(
    JSON.parse(files.find((f) => f.path === "manifest.json")!.text),
  );
  const byPath = new Map(files.map((f) => [f.path, f]));
  const used = new Set<string>();
  const docs = manifest.entries.map((e) => {
    const f = byPath.get(e.path);
    if (!f || used.has(e.path) || hash(f.text) !== e.sha256)
      throw new AppError(400, "导出清单与文件校验不一致");
    used.add(e.path);
    if (Object.hasOwn(e.attributes, "initializationPending"))
      throw new AppError(400, "初始化状态仅由服务器维护");
    const parsed = parseMarkdown(f);
    const doc = entitySchema.parse({
      ...e.attributes,
      content: { ...parsed, ...e.fields },
    });
    if (
      doc.kind !== e.kind ||
      doc.id !== e.entityId ||
      doc.projectId !== e.projectId ||
      doc.currentVersion !== e.version ||
      doc.kind === "import" ||
      doc.deleted
    )
      throw new AppError(400, "导出条目身份不一致");
    return doc;
  });
  if (used.size !== files.length - 1)
    throw new AppError(400, "存在清单未登记的文件");
  return docs;
}
function vocabulary(text: string) {
  const section = (name: string) =>
    text.split(new RegExp(`^## ${name}[^\\n]*$`, "m"))[1]?.split(/^## /m)[0] ??
    "";
  const terms = (part: string) =>
    [...part.matchAll(/^\|\s*([^|]+?)\s*\|/gm)]
      .map((m) => m[1]!.trim())
      .filter((v) => v !== "取值" && !/^-+$/.test(v));
  const g = terms(section("genres")),
    a = terms(section("age_band"));
  if (!g.length || !a.length)
    throw new AppError(400, "受控词表缺少 genres 或 age_band 表格");
  return { genres: g, ageBands: a };
}
function legacy(files: BundleFile[], batch: string): Entity[] {
  const docs: Entity[] = [];
  const byPath = new Map<string, Entity>();
  const byFile = new Map(files.map((f) => [f.path, f]));
  const groups = new Map<string, BundleFile[]>();
  for (const f of files) {
    if (f.path === "library/index.md") continue;
    const match = /^projects\/([^/]+)\/(.+)$/.exec(f.path);
    if (match) {
      const list = groups.get(match[1]!) ?? [];
      list.push(f);
      groups.set(match[1]!, list);
      continue;
    }
    const kind =
      f.path === "library/_vocabulary.md"
        ? "vocabulary"
        : /^library\/characters\/[^/]+\.md$/.test(f.path)
          ? "character"
          : /^library\/worlds\/[^/]+\.md$/.test(f.path)
            ? "world"
            : null;
    if (!kind) throw new AppError(400, "无法识别的素材路径", [f.path]);
    const content = parseMarkdown(f);
    if (kind === "vocabulary")
      content.sourceMetadata = {
        ...content.sourceMetadata,
        ...vocabulary(content.markdown),
      };
    const doc = {
      ...entity(
        kind,
        content,
        null,
        stableId(
          kind === "vocabulary" ? "library:vocabulary" : `${batch}:${f.path}`,
        ),
      ),
      source: { path: f.path, hash: hash(f.text), raw: f.text },
    };
    docs.push(doc);
    byPath.set(f.path, doc);
  }
  for (const [slug, group] of groups) {
    const root = `projects/${slug}`;
    const setting = byFile.get(`${root}/setting.md`);
    const outline = byFile.get(`${root}/outline.md`);
    if (!setting || !outline)
      throw new AppError(400, "故事缺少 setting.md 或 outline.md", [root]);
    const sid = stableId(`${batch}:${root}`);
    const sc = parseMarkdown(setting);
    sc.name =
      typeof sc.sourceMetadata.title === "string"
        ? sc.sourceMetadata.title
        : slug;
    const story = {
      ...entity("story", { ...sc, markdown: "" }, sid, sid),
      status: "ready" as const,
      source: {
        path: root,
        hash: hash(
          group
            .map((f) => f.path + hash(f.text))
            .sort()
            .join("\n"),
        ),
        raw: "",
      },
    };
    docs.push(story);
    const routed = new Set<string>();
    const snapshots = new Map<string, BundleFile>();
    for (const f of group) {
      for (const ref of references(f)) {
        if (!byFile.has(ref))
          throw new AppError(400, "引用目标缺失", [f.path, ref]);
        if (byPath.has(ref)) routed.add(ref);
      }
      if (f.path.startsWith(`${root}/snapshots/`)) {
        const delta = parseMarkdown(f);
        const source = delta.sourceMetadata.source;
        if (typeof source !== "string")
          throw new AppError(400, "快照缺少 source", [f.path]);
        const ref = resolveReference(f.path, source);
        const master = byPath.get(ref);
        if (!master || !["character", "world"].includes(master.kind))
          throw new AppError(400, "快照母版引用缺失或无效", [f.path, ref]);
        if (snapshots.has(ref))
          throw new AppError(400, "同一母版存在多个增量快照", [f.path]);
        routed.add(ref);
        snapshots.set(ref, f);
        continue;
      }
      const kind =
        f.path === setting.path
          ? "setting"
          : f.path === outline.path
            ? "outline"
            : f.path.startsWith(`${root}/story/`)
              ? "chapter"
              : null;
      if (!kind) throw new AppError(400, "无法识别的故事素材", [f.path]);
      const content = parseMarkdown(f);
      const order =
        kind === "chapter"
          ? Number(
              content.sourceMetadata.order ??
                /^ch(\d+)(?:[-_].*)?\.md$/i.exec(posix.basename(f.path))?.[1],
            )
          : undefined;
      if (
        kind === "chapter" &&
        (!Number.isInteger(order) || !order || order < 1)
      )
        throw new AppError(400, "无法确定章节顺序", [f.path]);
      const d = {
        ...entity(kind, content, sid, stableId(`${batch}:${f.path}`)),
        ...(order ? { order } : {}),
        source: { path: f.path, hash: hash(f.text), raw: f.text },
      };
      docs.push(d);
    }
    for (const ref of routed) {
      const master = byPath.get(ref)!;
      if (!["character", "world"].includes(master.kind)) continue;
      const delta = snapshots.get(ref);
      const dc = delta ? parseMarkdown(delta) : undefined;
      const content = structuredClone(master.content);
      if (dc) {
        content.markdown = `# 母版（导入时）\n\n${master.content.markdown}\n\n# 本故事增量（优先于母版）\n\n${dc.markdown}`;
        content.sourceMetadata = {
          ...content.sourceMetadata,
          ...dc.sourceMetadata,
        };
      }
      const path = delta?.path ?? `${root}/snapshots/${master.id}.md`;
      docs.push({
        ...entity(
          "snapshot",
          content,
          sid,
          stableId(`${batch}:${root}:snapshot:${ref}`),
        ),
        sourceAssetId: master.id,
        sourceVersion: master.currentVersion,
        source: {
          path,
          hash: hash(master.source!.raw + (delta?.text ?? "")),
          raw: delta?.text ?? master.source!.raw,
          base: master.source!.raw,
          ...(delta ? { delta: delta.text } : {}),
        },
      });
    }
  }
  return docs;
}
export function preflight(
  files: BundleFile[],
  batchId: string,
  activeTerms = { genres, ageBands },
): Entity[] {
  checkFiles(files);
  if (!batchId || batchId.length > 200)
    throw new AppError(400, "导入批次 ID 无效");
  const hasManifest = files.some((f) => f.path === "manifest.json");
  let docs: Entity[];
  try {
    docs = files.some((f) => f.path === "manifest.json")
      ? exported(files)
      : legacy(files, batchId);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, "导入结构、字段或清单无效");
  }
  const ids = new Set<string>();
  const stories = new Set(
    docs.filter((d) => d.kind === "story").map((d) => d.id),
  );
  const orders = new Set<string>();
  const vocab = docs.filter((d) => d.kind === "vocabulary");
  if (vocab.length > 1) throw new AppError(400, "重复受控词表");
  const terms = vocab[0]?.content.sourceMetadata ?? activeTerms;
  if (
    !Array.isArray(terms.genres) ||
    !terms.genres.every((t) => typeof t === "string") ||
    !Array.isArray(terms.ageBands) ||
    !terms.ageBands.every((t) => typeof t === "string")
  )
    throw new AppError(400, "受控词表格式无效");
  const allowedGenres = terms.genres as string[],
    allowedAges = terms.ageBands as string[];
  for (const doc of docs) {
    clean(doc);
    if (ids.has(doc.id)) throw new AppError(400, "重复对象 ID");
    ids.add(doc.id);
    const global = ["character", "world", "vocabulary"].includes(doc.kind);
    if (
      global
        ? doc.projectId !== null || doc.scopeId !== "library"
        : doc.projectId === null ||
          !stories.has(doc.projectId) ||
          doc.scopeId !== undefined
    )
      throw new AppError(400, "对象分区或故事归属无效");
    if (
      doc.kind === "story" &&
      (doc.id !== doc.projectId || doc.status !== "ready")
    )
      throw new AppError(400, "故事状态或身份无效");
    if (
      doc.kind === "snapshot" &&
      Boolean(doc.sourceAssetId) !== Boolean(doc.sourceVersion)
    )
      throw new AppError(400, "快照缺少溯源信息");
    if (doc.kind === "chapter") {
      const key = `${doc.projectId}:${doc.order}`;
      if (!doc.order || (!hasManifest && orders.has(key)))
        throw new AppError(400, "章节顺序缺失或重复");
      orders.add(key);
    }
    if (
      ["character", "world"].includes(doc.kind) &&
      (doc.content.genres.some((g) => !allowedGenres.includes(g)) ||
        (doc.content.ageBand && !allowedAges.includes(doc.content.ageBand)))
    )
      throw new AppError(400, "未知的受控字段取值", [
        doc.source?.path ?? doc.id,
      ]);
  }
  return docs;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function equivalent(a: Entity, b: Entity) {
  const normalize = (e: Entity) => {
    const result = { ...clean(e) } as Record<string, unknown>;
    delete result.createdAt;
    delete result.updatedAt;
    delete result.initializationPending;
    if (e.kind === "story") result.status = "ready";
    return result;
  };
  return canonical(normalize(a)) === canonical(normalize(b));
}
export async function importFiles(
  store: Store,
  files: BundleFile[],
  batchId: string,
): Promise<{ created: number; skipped: number }> {
  const docs = preflight(files, batchId, await new Library(store).vocabulary());
  const previous = new Map<string, Document>();
  for (const doc of docs) {
    const old = await store.get(doc.id, doc.projectId);
    if (
      doc.kind === "chapter" &&
      !old &&
      doc.projectId &&
      (await store.get(doc.projectId, doc.projectId))?.initializationPending
    )
      throw new AppError(409, "请通过初始化流程保存首章");
    if (old) {
      if (!equivalent(old, doc))
        throw new AppError(409, "已有对象内容不同，导入不会覆盖", [
          doc.source?.path ?? doc.id,
        ]);
      previous.set(doc.id, old);
    }
  }
  if (!files.some((f) => f.path === "manifest.json")) {
    const marker = entity(
      "import",
      {
        name: "导入批次",
        markdown: "",
        genres: [],
        ageBand: "",
        sourceMetadata: {
          hash: hash(
            files
              .map((f) => f.path + hash(f.text))
              .sort()
              .join("\n"),
          ),
        },
      },
      null,
      stableId(`import:${batchId}`),
    );
    const old = await store.get(marker.id, null);
    if (old && !equivalent(old, marker))
      throw new AppError(409, "同一批次的输入已变化，请使用新的批次 ID");
    if (!old) {
      try {
        await store.commit(marker, null);
      } catch (error) {
        const concurrent = await store.get(marker.id, null);
        if (!concurrent || !equivalent(concurrent, marker)) throw error;
      }
    }
  }
  let created = 0,
    skipped = 0;
  for (const doc of [
    ...docs.filter((d) => d.kind === "story"),
    ...docs.filter((d) => d.kind !== "story"),
  ]) {
    if (previous.has(doc.id)) {
      skipped++;
      continue;
    }
    const staged =
      doc.kind === "story" ? { ...doc, status: "building" as const } : doc;
    try {
      previous.set(doc.id, await store.commit(staged, null));
      created++;
    } catch (error) {
      const concurrent = await store.get(doc.id, doc.projectId);
      if (!concurrent || !equivalent(concurrent, doc)) throw error;
      previous.set(doc.id, concurrent);
      skipped++;
    }
  }
  for (const doc of docs.filter((d) => d.kind === "story")) {
    const head = previous.get(doc.id)!;
    if (head.status === "building") {
      try {
        await store.publishStory(head);
      } catch (error) {
        const current = await store.get(head.id, head.id);
        if (current?.status !== "ready" || !equivalent(current, doc))
          throw error;
      }
    }
  }
  return { created, skipped };
}
