import { z } from "zod";
import type { FreeSession } from "./free-session.js";
import type { FreeTask } from "../shared/free.js";
import type { Candidate } from "../shared/free-candidates.js";
import { AppError, type Content } from "../shared/model.js";
import { stableId } from "./entities.js";
import { Library } from "./library.js";
import { freeDigest } from "./free-references.js";
import { groupFields } from "./free-candidates.js";
const schema = z
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
    age_band: z.string().max(40).optional(),
    era: z.string().max(128).optional(),
    tags: z.array(z.string().max(128)).max(16).optional(),
    ...groupFields,
  })
  .strict();
export async function worldTool(
  free: FreeSession,
  task: FreeTask,
  args: Record<string, unknown>,
  invocationId: string,
) {
  const c = await free.conversation(task.conversationId);
  if (c.toolsetVersion !== "world-v1")
    throw new AppError(403, "forbidden_scope");
  const a = schema.parse(args),
    context = task.draftContext;
  const digest = freeDigest(args);
  const prior = await free.records.get<Candidate>(
    "library",
    "candidate",
    stableId(`candidate:${task.conversationId}:${task.id}:${invocationId}`),
  );
  if (prior) {
    if (
      prior.artifactKind !== "world" ||
      prior.payload.business?.worldInputDigest !== digest
    )
      throw new AppError(409, "operation_conflict");
    return {
      data: free.candidates.summary(
        await free.candidates.get(task.conversationId, prior.id),
      ),
    };
  }
  if (!context?.mode.endsWith("world"))
    throw new AppError(403, "forbidden_scope");
  let base: Content | undefined;
  if (a.parent_ref)
    base = (await free.candidates.exact(task.conversationId, a.parent_ref))
      .payload.content;
  else if (context.mode === "existing_world") {
    if (context.target?.kind !== "world")
      throw new AppError(403, "forbidden_scope");
    const head = await free.content.get(context.target.asset_id, null);
    if (
      !head ||
      head.deleted ||
      head.kind !== "world" ||
      head.revision !== context.baseRevision
    )
      throw new AppError(409, "revision_conflict");
    base = head.content;
  }
  if (a.derived_from) {
    const ref = a.derived_from;
    const kind =
      ref.type === "asset"
        ? ref.kind
        : (await free.candidates.exact(task.conversationId, ref)).artifactKind;
    if (kind !== "world" || (ref.type === "candidate" && ref.member_id))
      throw new AppError(403, "forbidden_scope");
  }
  const content = await new Library(free.content).validate({
    name: a.name,
    markdown: a.markdown,
    genres: a.genres,
    ageBand: a.age_band ?? base?.ageBand ?? "",
    sourceMetadata: {
      ...base?.sourceMetadata,
      ...(a.era !== undefined ? { era: a.era } : {}),
      ...(a.tags !== undefined ? { tags: a.tags } : {}),
    },
  });
  const d = await free.candidates.freeze(
    task,
    {
      artifactKind: "world",
      content,
      ...(a.group_id ? { group_id: a.group_id } : {}),
      ...(a.parent_ref ? { parent_ref: a.parent_ref } : {}),
      ...(a.derived_from ? { derived_from: a.derived_from } : {}),
    },
    invocationId,
    { business: { worldInputDigest: digest } },
  );
  return { data: free.candidates.summary(d) };
}
