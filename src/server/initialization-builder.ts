import type { AssetSource } from "../shared/creative-tools.js";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { Content, Document, Entity } from "../shared/model.js";
import type {
  InitializationPackage,
  InitializationWrite,
} from "../shared/creative.js";
import { ToolError } from "../shared/creative-tools.js";
import type { Store } from "./store.js";
import { clean, entity, stableId } from "./entities.js";
import {
  initializationArgs,
  checkPackageSize,
} from "./initialization-package.js";
export const plainContent = (name: string, markdown: string): Content => ({
  name,
  markdown,
  genres: [],
  ageBand: "",
  sourceMetadata: {},
});
type Args = Extract<z.infer<typeof initializationArgs>, { mode: "draft" }>;
export async function buildInitialization(
  store: Store,
  storyId: string,
  story: Document | undefined,
  args: Args,
  draftId: string,
  readSource: (
    a: Args["assets"][number],
  ) => Promise<{ source: AssetSource; master: Entity }>,
  resolveAsset?: (
    index: number,
    id: string,
  ) => Promise<InitializationWrite | undefined>,
) {
  const now = new Date().toISOString();
  const storyEntity: Entity = story
    ? {
        ...clean(story),
        content: {
          ...story.content,
          name: args.title,
          ...(args.body !== undefined ? { markdown: args.body } : {}),
        },
        currentVersion: story.currentVersion + 1,
        updatedAt: now,
      }
    : {
        ...entity(
          "story",
          plainContent(args.title, args.body ?? ""),
          storyId,
          storyId,
        ),
        status: "ready",
      };
  if (args.chapter) delete storyEntity.initializationPending;
  else storyEntity.initializationPending = true;
  const assets: InitializationWrite[] = [],
    targets = new Set<string>();
  for (const kind of ["setting", "outline"] as const)
    if (args.assets.filter((a) => a.kind === kind).length > 1)
      throw new ToolError("invalid_arguments");
  for (const [index, a] of args.assets.entries()) {
    let value: InitializationWrite;
    const supplied = await resolveAsset?.(
      index,
      stableId(`${draftId}:asset:${index}`),
    );
    if (supplied) value = supplied;
    else if (a.source_id) {
      const { source, master } = await readSource(a);
      const key = `source:${source.asset_id}:${source.version}`;
      if (targets.has(key)) throw new ToolError("invalid_arguments");
      targets.add(key);
      value = {
        entity: {
          ...entity(
            "snapshot",
            structuredClone(master.content),
            storyId,
            stableId(`${draftId}:asset:${index}`),
          ),
          sourceAssetId: master.id,
          sourceVersion: master.currentVersion,
          ...(master.portrait
            ? { portrait: structuredClone(master.portrait) }
            : {}),
        },
        baseRevision: null,
        source,
      };
    } else if (a.asset_id) {
      const current = await store.get(a.asset_id, storyId);
      if (
        !story ||
        !current ||
        current.projectId !== storyId ||
        current.deleted ||
        current.kind !== a.kind
      )
        throw new ToolError("forbidden_scope");
      if (current.revision !== a.base_revision)
        throw new ToolError("revision_conflict");
      if (targets.has(current.id)) throw new ToolError("invalid_arguments");
      targets.add(current.id);
      value = {
        entity: {
          ...clean(current),
          content: {
            ...structuredClone(current.content),
            name: a.title!,
            markdown: a.body!,
          },
          currentVersion: current.currentVersion + 1,
          updatedAt: now,
        },
        baseRevision: current.revision,
      };
    } else
      value = {
        entity: entity(
          a.kind,
          plainContent(a.title!, a.body!),
          storyId,
          stableId(`${draftId}:asset:${index}`),
        ),
        baseRevision: null,
      };
    if (a.kind === "setting" || a.kind === "outline") {
      const existing = (
        await store.list({
          projectId: storyId,
          kind: a.kind,
          limit: 2,
        })
      ).items;
      if (existing.some((e) => e.id !== value.entity.id))
        throw new ToolError("revision_conflict");
    }
    assets.push(value);
  }
  const initialization: InitializationPackage = {
    story: { entity: storyEntity, baseRevision: story?.revision ?? null },
    assets,
    ...(args.chapter
      ? {
          chapter: {
            entity: {
              ...entity(
                "chapter",
                plainContent(args.chapter.title, args.chapter.body),
                storyId,
                randomUUID(),
              ),
              order: 1,
            },
            baseRevision: null,
          },
        }
      : {}),
  };
  checkPackageSize(initialization);
  return initialization;
}
