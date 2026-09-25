import { z } from "zod";
import type { FreeSession } from "./free-session.js";
import {
  candidateRefSchema,
  type FreeTask,
  type ExactRef,
} from "../shared/free.js";
import type { Candidate } from "../shared/free-candidates.js";
import type { InitializationPackage } from "../shared/creative.js";
import { AppError } from "../shared/model.js";
import { groupFields } from "./free-candidates.js";
import { freeDigest } from "./free-references.js";
import { entity, stableId } from "./entities.js";
import { initializationArgs } from "./initialization-package.js";
import { buildInitialization, plainContent } from "./initialization-builder.js";
import { saveStory } from "./free-story-save.js";
import { draftInput } from "./creative-chapters.js";
export async function storyTool(
  free: FreeSession,
  task: FreeTask,
  name: string,
  args: Record<string, unknown>,
  invocationId: string,
) {
  if (args.mode === "commit") return saveStory(free, task, name, args);
  if (Buffer.byteLength(JSON.stringify(args)) > 120 * 1024)
    throw new AppError(400, "result_too_large");
  const { group_id, parent_ref, derived_from, ...raw } = args;
  const groups = z
    .object(groupFields)
    .strict()
    .parse(
      Object.fromEntries(
        Object.entries({ group_id, parent_ref, derived_from }).filter(
          ([, v]) => v !== undefined,
        ),
      ),
    );
  const id = stableId(
    `candidate:${task.conversationId}:${task.id}:${invocationId}`,
  );
  const prior = await free.records.get<Candidate>("library", "candidate", id);
  if (prior) {
    if (prior.payload.business?.storyInputDigest !== freeDigest({ name, args }))
      throw new AppError(409, "operation_conflict");
    return {
      data: free.candidates.summary(
        await free.candidates.get(task.conversationId, id),
      ),
    };
  }
  const context = task.draftContext;
  if (
    !context ||
    context.target?.kind !== "story" ||
    !context.mode.endsWith("story")
  )
    throw new AppError(403, "forbidden_scope");
  const storyId = context.target.story_id;
  const story = await free.content.get(storyId, storyId);
  if (
    (story?.revision ?? null) !== context.baseRevision ||
    story?.deleted ||
    (story && (story.kind !== "story" || story.status !== "ready")) ||
    (context.mode === "existing_story" && !story)
  )
    throw new AppError(409, "revision_conflict");
  let pack: InitializationPackage | undefined;
  if (name === "initialize_story") {
    const candidates = new Map<number, ExactRef>();
    if (Array.isArray(raw.assets))
      raw.assets = raw.assets.map((value, index) => {
        if (!value || typeof value !== "object" || !("candidate_ref" in value))
          return value;
        const a = z
          .object({
            kind: z.literal("snapshot"),
            candidate_ref: candidateRefSchema,
          })
          .strict()
          .parse(value);
        candidates.set(index, a.candidate_ref);
        return { kind: "snapshot", title: "candidate", body: "" };
      });
    const parsed = initializationArgs.parse(raw);
    if (parsed.mode !== "draft") throw new AppError(400, "invalid_arguments");
    if (
      (
        await free.content.list({
          projectId: storyId,
          kind: "chapter",
          limit: 1,
        })
      ).items.length ||
      (story && !parsed.chapter)
    )
      throw new AppError(403, "forbidden_scope");
    const sources = await free.references.sources(task.conversationId);
    const used = new Set<string>();
    pack = await buildInitialization(
      free.content,
      storyId,
      story,
      parsed,
      id,
      async (a) => {
        const source = sources
          .map((s) => s.ref)
          .find(
            (r) =>
              r.type === "asset" &&
              r.asset_id === a.source_id &&
              r.version === a.source_version &&
              r.content_hash === a.source_hash &&
              ["character", "world"].includes(r.kind),
          );
        if (!source || source.type !== "asset")
          throw new AppError(403, "forbidden_scope");
        const full = await free.references.read(task.conversationId, source);
        const sourceEntity = await free.content.getVersion(
          source.asset_id,
          null,
          source.version,
        );
        if (!sourceEntity) throw new AppError(409, "reference_unavailable");
        return {
          source: {
            title: full.content.name,
            scope: "library",
            asset_id: source.asset_id,
            kind: source.kind as "character" | "world",
            revision: source.revision,
            version: source.version,
            content_hash: source.content_hash,
          },
          master: {
            ...entity(
              source.kind as "character" | "world",
              structuredClone(full.content),
              null,
              source.asset_id,
            ),
            currentVersion: source.version,
            ...(sourceEntity.portrait
              ? { portrait: structuredClone(sourceEntity.portrait) }
              : {}),
          },
        };
      },
      async (index, assetId) => {
        const source = candidates.get(index);
        if (!source || source.type !== "candidate") return;
        const d = await free.candidates.exact(task.conversationId, source);
        if (source.member_id || d.artifactKind !== "character")
          throw new AppError(403, "forbidden_scope");
        if (used.has(freeDigest(source)))
          throw new AppError(400, "invalid_arguments");
        used.add(freeDigest(source));
        return {
          entity: entity(
            "snapshot",
            structuredClone(d.payload.content),
            storyId,
            assetId,
          ),
          baseRevision: null,
        };
      },
    );
    const members = pack.assets.map((a, i) => ({
      member_id: a.entity.id,
      kind: a.entity.kind,
      content: structuredClone(a.entity.content),
      ...(candidates.has(i)
        ? { sourceRef: candidates.get(i)! }
        : a.source
          ? {
              sourceRef: sources
                .map((s) => s.ref)
                .find(
                  (r) =>
                    r.type === "asset" &&
                    r.asset_id === a.source!.asset_id &&
                    r.version === a.source!.version,
                )!,
            }
          : {}),
    }));
    const d = await free.candidates.freeze(
      task,
      {
        artifactKind: "story_initialization",
        content: pack.story.entity.content,
        ...groups,
      },
      invocationId,
      {
        action: pack.chapter ? "save_first_chapter" : "initialize_story",
        members,
        business: {
          storyInputDigest: freeDigest({ name, args }),
          initialization: pack,
        },
      },
    );
    return { data: free.candidates.summary(d) };
  }
  const a = draftInput.parse(raw);
  if (!story || story.initializationPending || !context.chapterId)
    throw new AppError(403, "forbidden_scope");
  const d = await free.candidates.freeze(
    task,
    {
      artifactKind: "chapter",
      content: plainContent(a.title, a.body),
      ...groups,
    },
    invocationId,
    {
      business: {
        storyInputDigest: freeDigest({ name, args }),
        chapterId: context.chapterId,
      },
    },
  );
  return { data: free.candidates.summary(d) };
}
