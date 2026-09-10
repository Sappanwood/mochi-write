import { BulkOperationType, type OperationInput } from "@azure/cosmos";
import { AppError } from "../shared/model.js";
import type { InitializationPackage } from "../shared/creative.js";
import type { CreativeWrite } from "./creative-store.js";
import { clean, hash } from "./entities.js";
import { canonicalJson, packageHash } from "./initialization-package.js";
import { libraryContentHash } from "./library-tools.js";
export function appendInitialization(
  ops: OperationInput[],
  storyId: string,
  writes: CreativeWrite[],
  pack: InitializationPackage,
) {
  const task = writes.find((w) => w.record.kind === "task")?.record;
  const draft = writes.find((w) => w.record.kind === "draft")?.record;
  const conversation = writes.find(
    (w) => w.record.kind === "conversation",
  )?.record;
  const receipt = task?.kind === "task" ? task.receipt : undefined;
  if (
    writes.length !== 3 ||
    writes.some((w) => !w.revision) ||
    task?.kind !== "task" ||
    draft?.kind !== "draft" ||
    conversation?.kind !== "conversation" ||
    !conversation.lifecycle ||
    conversation.id !== task.conversationId ||
    conversation.activeTaskId !== task.id ||
    draft.conversationId !== conversation.id ||
    draft.artifactKind !== "story_initialization" ||
    !draft.initialization ||
    canonicalJson(draft.initialization) !== canonicalJson(pack) ||
    draft.hash !== packageHash(pack) ||
    !receipt ||
    !("kind" in receipt) ||
    canonicalJson(receipt) !== canonicalJson(draft.receipt) ||
    receipt.operation_id !== task.operationId ||
    receipt.story_id !== storyId ||
    receipt.draft_id !== draft.id ||
    receipt.draft_revision !== draft.draftRevision ||
    receipt.draft_hash !== draft.hash ||
    receipt.content_hash !== draft.hash ||
    receipt.revision !== String(pack.story.entity.currentVersion) ||
    task.authorization?.status !== "consumed" ||
    task.authorization.action !== "initialize_story" ||
    task.authorization.maxCreates !== 1 ||
    task.authorization.includesChapter !== Boolean(pack.chapter)
  )
    throw new AppError(400, "初始化事务与精确草稿、授权或收据不一致");
  appendInitializationBusiness(ops, storyId, pack, receipt);
}
export function appendInitializationBusiness(
  ops: OperationInput[],
  storyId: string,
  pack: InitializationPackage,
  receipt: import("../shared/creative.js").InitializationReceipt,
) {
  const business = [
    pack.story,
    ...pack.assets,
    ...(pack.chapter ? [pack.chapter] : []),
  ];
  if (
    pack.assets.length > 8 ||
    business.length > 10 ||
    new Set(business.map((a) => a.entity.id)).size !== business.length ||
    business.some(
      (a) =>
        a.entity.projectId !== storyId ||
        a.entity.deleted ||
        (a.baseRevision !== null && !a.baseRevision) ||
        (a.baseRevision === null && a.entity.currentVersion !== 1),
    ) ||
    pack.story.entity.id !== storyId ||
    pack.story.entity.kind !== "story" ||
    pack.story.entity.status !== "ready" ||
    pack.assets.some(
      (a) => !["setting", "outline", "snapshot"].includes(a.entity.kind),
    )
  )
    throw new AppError(400, "初始化事务与精确草稿、授权或收据不一致");
  if (
    pack.chapter
      ? receipt.kind !== "first_chapter_saved" ||
        receipt.chapter.chapter_id !== pack.chapter.entity.id ||
        receipt.chapter.revision !== "1" ||
        receipt.chapter.content_hash !==
          "sha256:" + hash(pack.chapter.entity.content.markdown) ||
        pack.chapter.entity.kind !== "chapter" ||
        pack.chapter.baseRevision !== null ||
        pack.chapter.entity.order !== 1 ||
        pack.story.entity.initializationPending !== undefined
      : receipt.kind !== "story_initialized" ||
        pack.story.baseRevision !== null ||
        pack.story.entity.initializationPending !== true
  )
    throw new AppError(400, "初始化首章范围不一致");
  if (
    canonicalJson(receipt.assets) !==
    canonicalJson(
      pack.assets.map((a) => ({
        asset_id: a.entity.id,
        kind: a.entity.kind,
        revision: String(a.entity.currentVersion),
        content_hash: libraryContentHash(a.entity.content),
      })),
    )
  )
    throw new AppError(400, "资料收据与精确包不一致");
  for (const a of business) {
    const value = clean(a.entity);
    ops.push(
      {
        operationType: BulkOperationType.Create,
        resourceBody: {
          id: `version:${value.id}:${value.currentVersion}`,
          kind: "version",
          entityId: value.id,
          version: value.currentVersion,
          projectId: storyId,
          content: value,
        },
      },
      a.baseRevision === null
        ? {
            operationType: BulkOperationType.Create,
            resourceBody: { ...value, recordType: "head" },
          }
        : {
            operationType: BulkOperationType.Replace,
            id: value.id,
            ifMatch: a.baseRevision,
            resourceBody: { ...value, recordType: "head" },
          },
    );
  }
  if (ops.length > 23 || Buffer.byteLength(JSON.stringify(ops)) > 1024 * 1024)
    throw new AppError(413, "完整初始化事务超过预算");
}
