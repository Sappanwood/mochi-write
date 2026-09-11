import { saveMaterials } from "./free-material-save.js";
import { z } from "zod";
import type { FreeSession } from "./free-session.js";
import type { FreeTask } from "../shared/free.js";
import type { Candidate } from "../shared/free-candidates.js";
import type { MaterialPackage } from "../shared/story-materials.js";
import { freeId, candidateRefSchema } from "../shared/free.js";
import { AppError, contentSchema } from "../shared/model.js";
import { clean, entity, stableId } from "./entities.js";
import { freeDigest } from "./free-references.js";
const argsSchema = z
  .object({
    mode: z.literal("draft"),
    members: z
      .array(
        z
          .object({
            key: freeId,
            name: z.string().min(1).max(200).optional(),
            markdown: z.string().min(1).optional(),
            copy_source: z.literal(true).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    group_id: freeId.optional(),
    parent_ref: candidateRefSchema.optional(),
  })
  .strict();
export async function materialTool(
  free: FreeSession,
  task: FreeTask,
  args: Record<string, unknown>,
  invocationId: string,
) {
  if (args.mode === "commit") return saveMaterials(free, task, args);
  const a = argsSchema.parse(args);
  if (Buffer.byteLength(JSON.stringify(a)) > 120 * 1024)
    throw new AppError(400, "result_too_large");
  const id = stableId(
      `candidate:${task.conversationId}:${task.id}:${invocationId}`,
    ),
    digest = freeDigest(args);
  const old = await free.records.get<Candidate>("library", "candidate", id);
  if (old) {
    if (old.payload.business?.materialInputDigest !== digest)
      throw new AppError(409, "operation_conflict");
    return {
      data: free.candidates.summary(
        await free.candidates.get(task.conversationId, id),
      ),
    };
  }
  task = await free.task(task.id);
  const c = await free.guard(task),
    context = task.draftContext;
  if (
    c.toolsetVersion !== "materials-v1" ||
    !context?.materials?.length ||
    context.target?.kind !== "story"
  )
    throw new AppError(403, "forbidden_scope");
  if (
    Boolean(context.reference) !== Boolean(a.parent_ref) ||
    (context.reference &&
      freeDigest(context.reference) !== freeDigest(a.parent_ref))
  )
    throw new AppError(409, "draft_conflict");
  const parent = a.parent_ref
    ? await free.candidates.exact(task.conversationId, a.parent_ref)
    : undefined;
  const prior = parent?.payload.business?.materials as
    MaterialPackage | undefined;
  const story =
    prior?.story ??
    (await free.content.get(context.target.story_id, context.target.story_id));
  if (
    !story ||
    story.deleted ||
    story.status !== "ready" ||
    story.initializationPending ||
    story.revision !== context.baseRevision ||
    !(
      await free.content.list({
        projectId: story.id,
        kind: "chapter",
        limit: 1,
      })
    ).items.length
  )
    throw new AppError(409, "revision_conflict");
  if (
    a.members.length !== context.materials.length ||
    new Set(a.members.map((m) => m.key)).size !== a.members.length ||
    a.members.some((m) => !context.materials!.some((s) => s.key === m.key))
  )
    throw new AppError(400, "incomplete_materials");
  const pack: MaterialPackage = { story, members: [] };
  for (const spec of context.materials) {
    const input = a.members.find((m) => m.key === spec.key)!;
    const original = prior?.members.find(
      (m) => m.spec.asset_id === spec.asset_id,
    )?.entity;
    const head =
      spec.mode === "update" && !original
        ? await free.content.get(spec.asset_id, story.id)
        : undefined;
    if (
      spec.mode === "update" &&
      !original &&
      (!head ||
        head.deleted ||
        head.kind !== spec.kind ||
        head.revision !== spec.base_revision ||
        head.currentVersion !== spec.base_version)
    )
      throw new AppError(409, "revision_conflict");
    let e = original
      ? structuredClone(original)
      : head
        ? { ...clean(head), currentVersion: head.currentVersion + 1 }
        : entity(
            spec.kind,
            {
              name: "",
              markdown: "",
              genres: [],
              ageBand: "",
              sourceMetadata: {},
            },
            story.id,
            spec.asset_id,
          );
    if (spec.source_ref && !parent) {
      if (!input.copy_source || input.name || input.markdown)
        throw new AppError(400, "incomplete_materials");
      e.content = structuredClone(
        (await free.references.read(task.conversationId, spec.source_ref))
          .content,
      );
      if (spec.source_ref.type === "asset") {
        e.sourceAssetId = spec.source_ref.asset_id;
        e.sourceVersion = spec.source_ref.version;
      } else {
        const ref = spec.source_ref;
        e.sourceCandidate = {
          conversationId: task.conversationId,
          groupId: ref.group_id,
          draftId: ref.draft_id,
          draftRevision: ref.draft_revision,
          draftHash: ref.draft_hash,
        };
      }
    } else {
      if (input.copy_source || !input.name || !input.markdown)
        throw new AppError(400, "invalid_arguments");
      e.content = { ...e.content, name: input.name, markdown: input.markdown };
    }
    e.content = contentSchema.parse(e.content);
    if (
      Buffer.byteLength(JSON.stringify(e.content)) > 60 * 1024 ||
      Buffer.byteLength(e.content.markdown) > 48 * 1024 ||
      Buffer.byteLength(e.content.name) > 512
    )
      throw new AppError(400, "result_too_large");
    e.updatedAt = new Date().toISOString();
    e = clean(e);
    pack.members.push({ spec, entity: e, baseRevision: spec.base_revision });
  }
  const content = {
    name: `${story.content.name} · 资料修订`,
    markdown: pack.members
      .map(
        (m) =>
          `- ${m.spec.mode === "create" ? "新增" : "更新"} ${m.entity.content.name}`,
      )
      .join("\n"),
    genres: [],
    ageBand: "",
    sourceMetadata: {},
  };
  const d = await free.candidates.freeze(
    task,
    {
      artifactKind: "story_materials",
      content,
      ...(a.group_id ? { group_id: a.group_id, parent_ref: a.parent_ref } : {}),
    },
    invocationId,
    {
      action: "revise_story_materials",
      members: pack.members.map((m) => ({
        member_id: m.entity.id,
        kind: m.entity.kind,
        content: m.entity.content,
        mode: m.spec.mode,
        baseRevision: m.spec.base_revision,
        baseVersion: m.spec.base_version,
        ...(m.spec.source_ref ? { sourceRef: m.spec.source_ref } : {}),
      })),
      business: { materials: pack, materialInputDigest: digest },
    },
  );
  return { data: free.candidates.summary(d) };
}
