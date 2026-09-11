import { BulkOperationType, type OperationInput } from "@azure/cosmos";
import { AppError } from "../shared/model.js";
import type { Ledger, ReceiptV2 } from "../shared/free.js";
import {
  materialSpecSchema,
  materialMembers,
  type MaterialPackage,
} from "../shared/story-materials.js";
import { freeDigest } from "./free-references.js";
import { clean } from "./entities.js";
export function materialReceiptValid(op: Ledger, r: ReceiptV2): boolean {
  const specs = op.materials;
  if (
    !specs?.length ||
    specs.length > 8 ||
    !r.assets ||
    r.assets.length !== specs.length ||
    r.chapter ||
    r.content_hash !== r.draft_hash
  )
    return false;
  const ids = new Set<string>();
  return r.assets.every((a) => {
    const m = specs.find((s) => s.asset_id === a.asset_id);
    if (
      !m ||
      ids.has(a.asset_id) ||
      a.kind !== m.kind ||
      a.mode !== m.mode ||
      a.revision !== String(m.base_version + 1) ||
      !/^sha256:[a-f0-9]{64}$/.test(a.content_hash)
    )
      return false;
    ids.add(a.asset_id);
    return true;
  });
}
export function appendMaterials(
  ops: OperationInput[],
  partition: string,
  pack: MaterialPackage,
  op: Ledger,
) {
  const r = op.receipt!,
    story = pack.story;
  const invalid = () => {
    throw new AppError(400, "invalid_material_transaction");
  };
  if (
    op.action !== "revise_story_materials" ||
    r.kind !== "story_materials_saved" ||
    !materialReceiptValid(op, r) ||
    !pack.members.length ||
    pack.members.length > 8 ||
    new Set(pack.members.map((m) => m.entity.id)).size !==
      pack.members.length ||
    op.payloadHash !== freeDigest({ draftRef: op.draftRef, materials: pack }) ||
    freeDigest(materialMembers(pack.members.map((m) => m.spec))) !==
      freeDigest(materialMembers(op.materials!)) ||
    story.id !== partition ||
    story.projectId !== partition ||
    story.kind !== "story" ||
    story.status !== "ready" ||
    story.deleted ||
    story.initializationPending ||
    op.baseRevision !== story.revision ||
    r.revision !== String(story.currentVersion)
  )
    invalid();
  ops.push({
    operationType: BulkOperationType.Replace,
    id: story.id,
    ifMatch: story.revision,
    resourceBody: { ...clean(story), recordType: "head" },
  });
  for (const m of pack.members) {
    const spec = materialSpecSchema.parse(m.spec),
      e = clean(m.entity),
      receipt = r.assets!.find((a) => a.asset_id === e.id);
    if (
      e.id !== spec.asset_id ||
      e.id === partition ||
      e.kind !== spec.kind ||
      e.projectId !== partition ||
      e.deleted ||
      m.baseRevision !== spec.base_revision ||
      e.currentVersion !== spec.base_version + 1 ||
      (spec.mode === "create"
        ? spec.kind !== "snapshot" ||
          spec.base_revision !== null ||
          spec.base_version !== 0
        : !spec.base_revision || spec.base_version < 1) ||
      receipt?.content_hash !== freeDigest(e.content)
    )
      invalid();
    ops.push(
      {
        operationType: BulkOperationType.Create,
        resourceBody: {
          id: `version:${e.id}:${e.currentVersion}`,
          kind: "version",
          entityId: e.id,
          version: e.currentVersion,
          projectId: partition,
          content: e,
        },
      },
      spec.mode === "create"
        ? {
            operationType: BulkOperationType.Create,
            resourceBody: { ...e, recordType: "head" },
          }
        : {
            operationType: BulkOperationType.Replace,
            id: e.id,
            ifMatch: spec.base_revision!,
            resourceBody: { ...e, recordType: "head" },
          },
    );
  }
}
