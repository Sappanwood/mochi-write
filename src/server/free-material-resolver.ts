import { z } from "zod";
import type { Store } from "./store.js";
import type { FreeReferences } from "./free-references.js";
import { freeDigest } from "./free-references.js";
import { stableId } from "./entities.js";
import { exactRefSchema, freeId, type FreeTask } from "../shared/free.js";
import type { MaterialSpec } from "../shared/story-materials.js";
import { AppError } from "../shared/model.js";
export const materialRequestSchema = z
  .object({
    key: freeId,
    kind: z.enum(["snapshot", "setting", "outline"]),
    mode: z.enum(["create", "update"]),
    name: z.string().min(1).max(200).optional(),
    source_ref: exactRefSchema.optional(),
    evidence: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().positive(),
        text: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export async function resolveMaterials(
  content: Store,
  references: FreeReferences,
  task: FreeTask,
  storyId: string,
  raw: unknown,
  verifyIntent = true,
): Promise<MaterialSpec[]> {
  const requests = z
    .array(
      verifyIntent
        ? materialRequestSchema
        : materialRequestSchema.extend({
            evidence: materialRequestSchema.shape.evidence.optional(),
          }),
    )
    .min(1)
    .max(8)
    .parse(raw);
  const keys = new Set<string>(),
    ids = new Set<string>(),
    singletons = new Set<string>();
  const specs: MaterialSpec[] = [];
  for (const r of requests) {
    if (
      keys.has(r.key) ||
      (r.kind !== "snapshot" && singletons.has(r.kind)) ||
      (verifyIntent &&
        (!r.evidence ||
          task.input.message.slice(r.evidence.start, r.evidence.end) !==
            r.evidence.text ||
          r.evidence.end > task.input.message.length ||
          (r.name && !r.evidence.text.includes(r.name)) ||
          !/(?:快照|角色|人物|设定|大纲|snapshot|setting|outline)/iu.test(
            r.evidence.text,
          )))
    )
      throw new AppError(400, "invalid_material_evidence");
    keys.add(r.key);
    singletons.add(r.kind);
    let spec: MaterialSpec;
    if (r.mode === "create") {
      if (r.kind !== "snapshot")
        throw new AppError(400, "material_target_unavailable");
      spec = {
        key: r.key,
        kind: r.kind,
        mode: r.mode,
        asset_id: stableId(`material:${task.id}:${r.key}`),
        base_revision: null,
        base_version: 0,
      };
    } else {
      if ((r.kind === "snapshot" && !r.name) || r.source_ref)
        throw new AppError(400, "material_target_unavailable");
      const result = await content.list({
        projectId: storyId,
        kind: r.kind,
        limit: 20,
      });
      const found = result.items.filter(
        (d) => !d.deleted && (!r.name || d.content.name === r.name),
      );
      if (result.cursor || found.length !== 1)
        throw new AppError(400, "ambiguous_or_missing_material");
      const d = found[0]!;
      spec = {
        key: r.key,
        kind: r.kind,
        mode: r.mode,
        asset_id: d.id,
        base_revision: d.revision,
        base_version: d.currentVersion,
      };
    }
    if (r.source_ref) {
      const ref = r.source_ref;
      const sources = await references.sources(task.conversationId);
      if (!sources.some((s) => freeDigest(s.ref) === freeDigest(ref)))
        throw new AppError(403, "reference_unavailable");
      if (
        ref.type === "asset"
          ? !["character", "world"].includes(ref.kind) || !!ref.story_id
          : !!ref.member_id
      )
        throw new AppError(403, "forbidden_scope");
      const source = await references.read(task.conversationId, ref);
      if (
        ref.type === "candidate" &&
        (!references.candidates ||
          !(
            await references.candidates.read(task.conversationId, ref)
          ).draftContext.mode.endsWith("character"))
      )
        throw new AppError(403, "forbidden_scope");
      if (
        verifyIntent &&
        (!r.evidence ||
          (!r.evidence.text.includes(source.content.name) &&
            !/(?:引用|这个|该|候选)/u.test(r.evidence.text)))
      )
        throw new AppError(400, "invalid_material_evidence");
      spec.source_ref = ref;
    }
    if (ids.has(spec.asset_id)) throw new AppError(400, "duplicate_material");
    ids.add(spec.asset_id);
    specs.push(spec);
  }
  return specs;
}
