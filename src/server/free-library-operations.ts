import { BulkOperationType, type OperationInput } from "@azure/cosmos";
import type { Entity } from "../shared/model.js";
import { AppError } from "../shared/model.js";
import type { FreeWrite } from "./free-store.js";
import { clean } from "./entities.js";
import { freeDigest } from "./free-references.js";
export interface LibraryAssetWrite {
  entity: Entity;
  revision: string | null;
}
export function appendLibraryAsset(
  ops: OperationInput[],
  partition: string,
  writes: FreeWrite[],
  input: LibraryAssetWrite,
) {
  const e = clean(input.entity);
  const w = writes.find((w) => w.record.kind === "op"),
    op = w?.record.kind === "op" ? w.record : undefined;
  const r = op?.receipt;
  if (
    partition !== "library" ||
    !["character", "world"].includes(e.kind) ||
    e.projectId !== null ||
    e.scopeId !== "library" ||
    e.deleted ||
    writes.length !== 1 ||
    !w?.revision ||
    !op ||
    op.status !== "committed" ||
    !r ||
    !op.draftRef ||
    op.target.kind === "story" ||
    op.target.kind !== e.kind ||
    op.target.asset_id !== e.id ||
    op.baseRevision !== input.revision ||
    op.payloadHash !==
      freeDigest({ draftRef: op.draftRef, content: e.content }) ||
    (input.revision === null
      ? op.action !== `create_${e.kind}` || e.currentVersion !== 1
      : op.action !== `update_${e.kind}` || e.currentVersion < 2) ||
    r.protocol_version !== 2 ||
    r.status !== "committed" ||
    r.operation_id !== op.id ||
    r.task_id !== op.taskId ||
    r.conversation_id !== op.conversationId ||
    r.kind !==
      (input.revision === null ? `${e.kind}_created` : `${e.kind}_updated`) ||
    freeDigest(r.target) !== freeDigest(op.target) ||
    r.draft_id !== op.draftRef.draft_id ||
    r.draft_revision !== op.draftRef.draft_revision ||
    r.draft_hash !== op.draftRef.draft_hash ||
    r.content_hash !== freeDigest(e.content) ||
    r.revision !== String(e.currentVersion) ||
    r.assets ||
    r.chapter
  )
    throw new AppError(400, `invalid_${e.kind}_transaction`);
  ops.push(
    {
      operationType: BulkOperationType.Create,
      resourceBody: {
        id: `version:${e.id}:${e.currentVersion}`,
        kind: "version",
        entityId: e.id,
        version: e.currentVersion,
        scopeId: "library",
        content: e,
      },
    },
    input.revision === null
      ? {
          operationType: BulkOperationType.Create,
          resourceBody: { ...e, recordType: "head" },
        }
      : {
          operationType: BulkOperationType.Replace,
          id: e.id,
          ifMatch: input.revision,
          resourceBody: { ...e, recordType: "head" },
        },
  );
}
