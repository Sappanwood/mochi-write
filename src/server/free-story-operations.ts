import { BulkOperationType, type OperationInput } from "@azure/cosmos";
import { AppError, type Document, type Entity } from "../shared/model.js";
import type {
  InitializationPackage,
  InitializationReceipt,
} from "../shared/creative.js";
import type { FreeWrite } from "./free-store.js";
import { appendInitializationBusiness } from "./initialization-operations.js";
import { clean, hash } from "./entities.js";
import { freeDigest } from "./free-references.js";
export type StoryWrite =
  | { initialization: InitializationPackage }
  | { chapter: Entity; story: Document };
export function appendStory(
  ops: OperationInput[],
  partition: string,
  writes: FreeWrite[],
  business: StoryWrite,
) {
  const w = writes[0],
    op = w?.record.kind === "op" ? w.record : undefined,
    r = op?.receipt;
  if (
    partition === "library" ||
    writes.length !== 1 ||
    !w?.revision ||
    !op ||
    op.target.kind !== "story" ||
    op.target.story_id !== partition ||
    op.status !== "committed" ||
    !op.draftRef ||
    !r ||
    r.protocol_version !== 2 ||
    r.status !== "committed" ||
    r.operation_id !== op.id ||
    r.task_id !== op.taskId ||
    r.conversation_id !== op.conversationId ||
    freeDigest(r.target) !== freeDigest(op.target) ||
    r.draft_id !== op.draftRef.draft_id ||
    r.draft_revision !== op.draftRef.draft_revision ||
    r.draft_hash !== op.draftRef.draft_hash
  )
    throw new AppError(400, "invalid_story_transaction");
  if ("initialization" in business) {
    const pack = business.initialization;
    if (
      op.baseRevision !== pack.story.baseRevision ||
      op.payloadHash !==
        freeDigest({ draftRef: op.draftRef, initialization: pack }) ||
      op.action !==
        (pack.chapter ? "save_first_chapter" : "initialize_story") ||
      r.content_hash !== op.draftRef.draft_hash ||
      r.revision !== String(pack.story.entity.currentVersion)
    )
      throw new AppError(400, "invalid_story_transaction");
    appendInitializationBusiness(ops, partition, pack, {
      ...r,
      story_id: partition,
    } as InitializationReceipt);
  } else {
    const e = clean(business.chapter),
      story = business.story;
    if (
      op.action !== "create_chapter" ||
      r.kind !== "chapter_created" ||
      r.assets ||
      r.chapter?.chapter_id !== e.id ||
      r.chapter?.revision !== "1" ||
      r.revision !== "1" ||
      r.content_hash !== "sha256:" + hash(e.content.markdown) ||
      r.chapter?.content_hash !== r.content_hash ||
      op.payloadHash !==
        freeDigest({
          draftRef: op.draftRef,
          content: e.content,
          chapterId: e.id,
        }) ||
      op.baseRevision !== story.revision ||
      story.id !== partition ||
      story.projectId !== partition ||
      story.deleted ||
      story.initializationPending ||
      story.kind !== "story" ||
      e.projectId !== partition ||
      e.kind !== "chapter" ||
      e.currentVersion !== 1 ||
      e.deleted ||
      !e.order
    )
      throw new AppError(400, "invalid_story_transaction");
    ops.push(
      {
        operationType: BulkOperationType.Replace,
        id: story.id,
        ifMatch: story.revision,
        resourceBody: { ...clean(story), recordType: "head" },
      },
      {
        operationType: BulkOperationType.Create,
        resourceBody: {
          id: `version:${e.id}:1`,
          kind: "version",
          entityId: e.id,
          version: 1,
          projectId: partition,
          content: e,
        },
      },
      {
        operationType: BulkOperationType.Create,
        resourceBody: { ...e, recordType: "head" },
      },
    );
  }
}
