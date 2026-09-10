import { z } from "zod";
import type { FreeSession } from "./free-session.js";
import {
  assetRefSchema,
  candidateRefSchema,
  exactRefSchema,
  freeId,
} from "../shared/free.js";
import { AppError } from "../shared/model.js";
import { discoverCandidates } from "./free-candidate-tools.js";
import { freeDigest } from "./free-references.js";
export async function discoverReferences(
  free: FreeSession,
  id: string | null,
  raw: unknown,
) {
  if (id) await free.conversation(id);
  const { cursor, limit, ...q } = z
    .object({
      kind: z.enum([
        "character",
        "world",
        "story",
        "setting",
        "outline",
        "snapshot",
        "chapter",
        "candidate",
      ]),
      query: z.string().max(128).default(""),
      story_id: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(20).default(20),
      cursor: z.string().max(4096).optional(),
    })
    .strict()
    .parse(raw);
  if (q.kind === "candidate") {
    if (!id || q.story_id) throw new AppError(400, "invalid_arguments");
    return discoverCandidates(free, id, {
      query: q.query,
      limit,
      ...(cursor ? { cursor } : {}),
    });
  }
  const library = ["character", "world"].includes(q.kind);
  if (
    (library && q.story_id) ||
    (!library && q.kind !== "story" && !q.story_id)
  )
    throw new AppError(400, "invalid_arguments");
  if (q.story_id) {
    const story = await free.content.get(q.story_id, q.story_id);
    if (
      !story ||
      story.deleted ||
      story.kind !== "story" ||
      story.status !== "ready"
    )
      throw new AppError(404, "reference_unavailable");
  }
  const binding = freeDigest({ id, ...q });
  let continuation: string | undefined;
  if (cursor) {
    try {
      const v = JSON.parse(Buffer.from(cursor, "base64url").toString());
      if (v.binding !== binding || typeof v.cursor !== "string") throw Error();
      continuation = v.cursor;
    } catch {
      throw new AppError(400, "invalid_cursor");
    }
  }
  const p = await free.content.discoverAssets({
    kind: q.kind,
    name: q.query,
    projectId: library ? null : q.story_id,
    limit,
    cursor: continuation,
  });
  const result = {
    items: p.items.map((r) => ({ type: "asset", ...r })),
    next_cursor: p.cursor
      ? Buffer.from(JSON.stringify({ binding, cursor: p.cursor })).toString(
          "base64url",
        )
      : null,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 60 * 1024)
    throw new AppError(400, "result_too_large");
  return result;
}
export async function resolveReference(
  free: FreeSession,
  id: string | null,
  raw: unknown,
) {
  if (id) await free.conversation(id);
  if ((raw as { type?: string })?.type === "candidate") {
    if (!id) throw new AppError(400, "invalid_arguments");
    const ref = candidateRefSchema.parse(raw);
    await free.candidates.exact(id, ref);
    return { ref };
  }
  const selection = z
    .object({
      type: z.literal("asset"),
      kind: assetRefSchema.shape.kind,
      asset_id: z.uuid(),
      story_id: z.uuid().optional(),
      revision: freeId,
      version: z.number().int().positive(),
    })
    .strict()
    .parse(raw);
  const doc = await free.content.get(
    selection.asset_id,
    selection.story_id ?? null,
  );
  if (!doc || doc.deleted) throw new AppError(404, "reference_unavailable");
  if (
    doc.kind !== selection.kind ||
    doc.projectId !== (selection.story_id ?? null)
  )
    throw new AppError(403, "forbidden_scope");
  if (
    doc.revision !== selection.revision ||
    doc.currentVersion !== selection.version
  )
    throw new AppError(409, "reference_changed");
  const ref = exactRefSchema.parse({
    ...selection,
    content_hash: freeDigest(doc.content),
  });
  if (id) await free.references.read(id, ref);
  else if (Buffer.byteLength(JSON.stringify(doc.content)) > 60 * 1024)
    throw new AppError(400, "result_too_large");
  return { ref };
}
