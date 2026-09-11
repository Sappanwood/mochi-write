import { worldTool } from "./free-world-tool.js";
import { storyTool } from "./free-story-tools.js";
import { z } from "zod";
import { saveCharacter } from "./free-character-save.js";
import { stableId } from "./entities.js";
import type { Candidate } from "../shared/free-candidates.js";
import type { FreeSession } from "./free-session.js";
import type { FreeTask } from "../shared/free.js";
import { exactRefSchema, freeHash, freeId } from "../shared/free.js";
import { AppError } from "../shared/model.js";
import { groupFields } from "./free-candidates.js";
import { Library } from "./library.js";
import { freeDigest } from "./free-references.js";
const lists = z.array(z.string().max(256)).max(16);
const draftSchema = z
  .object({
    mode: z.literal("draft"),
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((s) => Buffer.byteLength(s) <= 512),
    markdown: z
      .string()
      .min(1)
      .refine((s) => Buffer.byteLength(s) <= 48 * 1024),
    genres: z.array(z.string().max(40)).max(30),
    age_band: z.string().max(40),
    gender: z.string().max(128).optional(),
    occupation: z.string().max(128).optional(),
    era: z.string().max(128).optional(),
    traits: z.array(z.string().max(128)).max(16).optional(),
    tags: z.array(z.string().max(128)).max(16).optional(),
    ...groupFields,
    derivation: z
      .object({
        source_ref: exactRefSchema,
        retained: lists,
        rewritten: lists,
        excluded: lists,
      })
      .strict()
      .optional(),
  })
  .strict();
export async function candidateTool(
  free: FreeSession,
  task: FreeTask,
  name: string,
  args: Record<string, unknown>,
  invocationId: string,
) {
  if (name === "save_world") return worldTool(free, task, args, invocationId);
  if (name === "initialize_story" || name === "create_chapter")
    return storyTool(free, task, name, args, invocationId);
  if (name === "discover_artifacts")
    return { data: await discoverCandidates(free, task.conversationId, args) };
  if (name === "read_artifact") {
    const a = z
      .object({
        draft_id: freeId,
        draft_revision: z.literal("1"),
        draft_hash: freeHash,
        member_id: freeId.optional(),
      })
      .strict()
      .parse(args);
    const d = await free.candidates.get(task.conversationId, a.draft_id),
      ref = { ...free.candidates.ref(d), ...a };
    await free.candidates.exact(task.conversationId, ref);
    if (d.artifactKind === "story_initialization" && !a.member_id)
      return { data: free.candidates.summary(d) };
    const result = await free.candidates.read(task.conversationId, ref);
    await free.references.recordRead(task, ref, invocationId);
    return { data: { ...ref, ...result } };
  }
  if (name === "save_character" && args.mode === "commit")
    return saveCharacter(free, task, args);
  if (name !== "save_character" || args.mode !== "draft")
    throw new AppError(400, "tool_not_available");
  const a = draftSchema.parse(args),
    context = task.draftContext;
  const toolInputDigest = freeDigest(args);
  const prior = await free.records.get<Candidate>(
    "library",
    "candidate",
    stableId(`candidate:${task.conversationId}:${task.id}:${invocationId}`),
  );
  if (prior) {
    if (prior.payload.business?.characterInputDigest !== toolInputDigest)
      throw new AppError(409, "operation_conflict");
    return {
      data: free.candidates.summary(
        await free.candidates.get(task.conversationId, prior.id),
      ),
    };
  }
  if (!context || !context.mode.endsWith("character"))
    throw new AppError(403, "forbidden_scope");
  let metadata = {};
  if (context.mode === "existing_character") {
    if (context.target?.kind !== "character")
      throw new AppError(403, "forbidden_scope");
    const doc = await free.content.get(context.target.asset_id, null);
    if (
      !doc ||
      doc.deleted ||
      doc.kind !== "character" ||
      doc.revision !== context.baseRevision
    )
      throw new AppError(409, "revision_conflict");
    metadata = doc.content.sourceMetadata;
  }
  const source = a.derivation?.source_ref ?? a.derived_from;
  const storySource =
    source &&
    (source.type === "asset"
      ? Boolean(source.story_id)
      : (await free.candidates.exact(task.conversationId, source))
          .artifactKind !== "character");
  if (storySource && (!a.derivation || context.mode !== "new_character"))
    throw new AppError(403, "derivation_required");
  if (
    a.derivation &&
    a.derived_from &&
    freeDigest(a.derivation.source_ref) !== freeDigest(a.derived_from)
  )
    throw new AppError(400, "invalid_arguments");
  if (a.derivation) {
    if (Buffer.byteLength(JSON.stringify(a.derivation)) > 8192)
      throw new AppError(400, "result_too_large");
    const ref = a.derivation.source_ref;
    if (
      ref.type === "asset" &&
      ref.story_id &&
      !task.storyAllowlist.includes(ref.story_id)
    )
      throw new AppError(403, "forbidden_scope");
    await free.references.read(task.conversationId, ref);
  }
  const content = await new Library(free.content).validate({
    name: a.name,
    markdown: a.markdown,
    genres: a.genres,
    ageBand: a.age_band,
    sourceMetadata: {
      ...metadata,
      ...Object.fromEntries(
        ["gender", "occupation", "era", "traits", "tags"]
          .filter((k) => k in a)
          .map((k) => [k, a[k as keyof typeof a]]),
      ),
    },
  });
  const d = await free.candidates.freeze(
    task,
    {
      artifactKind: "character",
      content,
      ...(a.group_id ? { group_id: a.group_id } : {}),
      ...(a.parent_ref ? { parent_ref: a.parent_ref } : {}),
      ...(a.derived_from ? { derived_from: a.derived_from } : {}),
    },
    invocationId,
    {
      business: {
        characterInputDigest: toolInputDigest,
        ...(a.derivation ? { derivation: a.derivation } : {}),
      },
    },
  );
  return { data: free.candidates.summary(d) };
}
export async function discoverCandidates(
  free: FreeSession,
  id: string,
  raw: unknown,
) {
  const { cursor, limit, ...q } = z
    .object({
      query: z.string().max(128),
      kind: z
        .enum(["world", "character", "story_initialization", "chapter"])
        .optional(),
      limit: z.coerce.number().int().min(1).max(20).default(20),
      cursor: z.string().max(4096).optional(),
    })
    .strict()
    .parse(raw);
  const binding = freeDigest({ id, ...q });
  let after: string | undefined;
  if (cursor) {
    try {
      const v = JSON.parse(Buffer.from(cursor, "base64url").toString());
      if (v.binding !== binding || typeof v.after !== "string") throw Error();
      after = v.after;
    } catch {
      throw new AppError(400, "invalid_cursor");
    }
  }
  const all = (await free.candidates.drafts(id)).filter(
    (d) =>
      (!q.kind || d.artifactKind === q.kind) &&
      d.title.toLowerCase().includes(q.query.toLowerCase()),
  );
  const start = after ? all.findIndex((d) => d.id === after) + 1 : 0;
  if (after && !start) throw new AppError(400, "invalid_cursor");
  const items = all.slice(start, start + limit);
  const result = {
    items: items.map((d) => free.candidates.summary(d)),
    next_cursor:
      start + limit < all.length
        ? Buffer.from(
            JSON.stringify({ binding, after: items.at(-1)!.id }),
          ).toString("base64url")
        : null,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 60 * 1024)
    throw new AppError(400, "result_too_large");
  return result;
}
