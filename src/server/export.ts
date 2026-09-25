import { stringify } from "yaml";
import {
  AppError,
  type BundleFile,
  type Entity,
  type Filter,
} from "../shared/model.js";
import type { Store } from "./store.js";
import { clean, hash } from "./entities.js";
import { checkFiles } from "./markdown.js";
import { exportPortraits } from "./portrait-bundle.js";
import type { PortraitStore } from "./portraits.js";
export async function collect(store: Store, filter: Filter): Promise<Entity[]> {
  const result: Entity[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({ ...filter, cursor, limit: 100 });
    result.push(...page.items.map(clean));
    cursor = page.cursor;
    if (result.length > 1000)
      throw new AppError(400, "导出范围超过 1000 个对象");
  } while (cursor);
  return result;
}
export async function exportFiles(
  store: Store,
  images?: PortraitStore,
): Promise<BundleFile[]> {
  const library = (await collect(store, { projectId: null })).filter(
    (e) => e.kind !== "import",
  );
  const stories = await collect(store, { kind: "story" });
  const docs = [...library, ...stories];
  for (const s of stories)
    docs.push(
      ...(await collect(store, { projectId: s.id })).filter(
        (e) => e.kind !== "story",
      ),
    );
  const files: BundleFile[] = [];
  const entries = [];
  for (const e of docs) {
    const path =
      e.projectId === null
        ? `library/${e.kind}/${e.id}.md`
        : `projects/${e.projectId}/${e.kind}/${e.id}.md`;
    const text = `---\n${stringify(e.content.sourceMetadata)}---\n${e.content.markdown}`;
    files.push({ path, text });
    const { content, ...attributes } = e;
    delete attributes.initializationPending;
    entries.push({
      path,
      kind: e.kind,
      entityId: e.id,
      projectId: e.projectId,
      version: e.currentVersion,
      sha256: hash(text),
      attributes,
      fields: {
        name: content.name,
        genres: content.genres,
        ageBand: content.ageBand,
      },
    });
  }
  files.push({
    path: "manifest.json",
    text: JSON.stringify(
      {
        schema: "mochi-write/export@1",
        exportedAt: new Date().toISOString(),
        entries,
      },
      null,
      2,
    ),
  });
  files.push(...(await exportPortraits(docs, images)));
  checkFiles(files);
  return files;
}
