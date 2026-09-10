import { z } from "zod";
import type { FreeSession } from "./free-session.js";
import {
  freeHash,
  freeId,
  type DraftClaim,
  type FreeTask,
  type Ledger,
  type ReceiptV2,
} from "../shared/free.js";
import type { Candidate } from "../shared/free-candidates.js";
import { AppError } from "../shared/model.js";
import { clean, entity } from "./entities.js";
import { freeDigest } from "./free-references.js";
import { Library } from "./library.js";
const commitSchema = z
  .object({
    mode: z.literal("commit"),
    draft_id: freeId,
    draft_revision: z.literal("1"),
    draft_hash: freeHash,
  })
  .strict();
export async function claimDraft(
  free: FreeSession,
  task: FreeTask,
  draft: Candidate,
  payloadHash: string,
) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const old = await free.records.get<DraftClaim>(
      "library",
      "claim",
      draft.id,
    );
    if (old) {
      if (
        old.conversationId !== task.conversationId ||
        old.draftId !== draft.id ||
        old.payloadHash !== payloadHash
      )
        throw new AppError(409, "draft_conflict");
      if (old.operationId !== task.operationId) {
        const prior = await free.operation(old.operationId);
        if (!["revoked", "conflict"].includes(prior.status) || prior.receipt)
          throw new AppError(409, "draft_conflict");
      }
    }
    const directory = await free.operations.directory(task.operationId);
    const op = directory ? await free.operations.ledger(directory) : undefined;
    const draftRef = free.candidates.ref(draft);
    if (!op || op.bindingDigest !== freeDigest(task.binding))
      throw new AppError(409, "operation_conflict");
    if (
      (op.draftRef && freeDigest(op.draftRef) !== freeDigest(draftRef)) ||
      (op.payloadHash && op.payloadHash !== payloadHash)
    )
      throw new AppError(409, "operation_conflict");
    if (op.draftRef && op.payloadHash) {
      if (old?.operationId === task.operationId) return op;
      // The OP read may observe a transaction newer than the claim read.
      continue;
    }
    if (op.status === "revoked")
      throw new AppError(409, "authorization_revoked");
    if (op.status === "conflict") throw new AppError(409, "revision_conflict");
    if (op.status !== "active") throw new AppError(409, "operation_conflict");
    const claim: DraftClaim = {
      id: draft.id,
      kind: "claim",
      revision: "",
      createdAt: old?.createdAt ?? new Date().toISOString(),
      conversationId: task.conversationId,
      draftId: draft.id,
      operationId: task.operationId,
      payloadHash,
    };
    try {
      const saved = await free.records.transaction("library", [
        { record: { ...op, draftRef, payloadHash }, revision: op.revision },
        { record: claim, revision: old?.revision ?? null },
      ]);
      return saved[0] as Ledger;
    } catch (e) {
      if (!(e instanceof AppError) || e.statusCode !== 409 || attempt === 3)
        throw e;
    }
  }
  throw new AppError(409, "draft_conflict");
}
export async function saveCharacter(
  free: FreeSession,
  inputTask: FreeTask,
  raw: unknown,
) {
  const args = commitSchema.parse(raw),
    task = await free.task(inputTask.id),
    b = task.binding;
  if (!b) throw new AppError(403, "authorization_required");
  const dir = await free.operations.directory(task.operationId);
  if (
    !dir ||
    dir.bindingDigest !== freeDigest(b) ||
    b.operationId !== task.operationId
  )
    throw new AppError(409, "operation_conflict");
  let op = await free.operations.ledger(dir);
  if (
    !op ||
    op.bindingDigest !== freeDigest(b) ||
    op.action !== b.action ||
    op.baseRevision !== b.baseRevision ||
    op.sourceMessageId !== task.sourceMessageId
  )
    throw new AppError(409, "operation_conflict");
  const recover = (current: Ledger) => {
    if (
      current.draftRef &&
      (current.draftRef.draft_id !== args.draft_id ||
        current.draftRef.draft_revision !== args.draft_revision ||
        current.draftRef.draft_hash !== args.draft_hash)
    )
      throw new AppError(409, "operation_conflict");
    if (current.status === "committed") {
      const receipt = free.operations.validateReceipt(dir, current);
      if (
        receipt.draft_id !== args.draft_id ||
        receipt.draft_revision !== args.draft_revision ||
        receipt.draft_hash !== args.draft_hash
      )
        throw new AppError(409, "operation_conflict");
      return { data: { status: "committed" }, receipt };
    }
    if (current.status === "revoked")
      throw new AppError(409, "authorization_revoked");
    if (current.status === "conflict")
      throw new AppError(409, "revision_conflict");
  };
  const previous = recover(op);
  if (previous) return previous;
  await free.guard(task);
  if (!["authorized", "running"].includes(task.state))
    throw new AppError(403, "authorization_required");
  if (
    b.target.kind !== "character" ||
    !["create_character", "update_character"].includes(b.action)
  )
    throw new AppError(403, "forbidden_scope");
  const d = await free.candidates.get(task.conversationId, args.draft_id);
  if (
    d.draftRevision !== args.draft_revision ||
    d.draftHash !== args.draft_hash
  )
    throw new AppError(409, "draft_conflict");
  const draftRef = free.candidates.ref(d),
    context = d.payload.draftContext;
  if (
    d.artifactKind !== "character" ||
    d.payload.action !== b.action ||
    (b.selectedDraft
      ? freeDigest(b.selectedDraft) !== freeDigest(draftRef)
      : d.createdByTaskId !== task.id) ||
    (context.target && freeDigest(context.target) !== freeDigest(b.target)) ||
    context.baseRevision !== b.baseRevision ||
    (b.action === "create_character"
      ? context.mode !== "new_character" || b.baseRevision !== null
      : context.mode !== "existing_character" ||
        !context.target ||
        !b.baseRevision)
  )
    throw new AppError(403, "forbidden_scope");
  const normalized = await new Library(free.content).validate(
    d.payload.content,
  );
  if (freeDigest(normalized) !== freeDigest(d.payload.content))
    throw new AppError(409, "draft_conflict");
  const payloadHash = freeDigest({ draftRef, content: d.payload.content });
  op = await claimDraft(free, task, d, payloadHash);
  const claimed = recover(op);
  if (claimed) return claimed;
  const closeConflict = async () => {
    try {
      await free.records.transaction("library", [
        {
          record: { ...op!, status: "conflict", draftRef, payloadHash },
          revision: op!.revision,
        },
      ]);
    } catch (e) {
      const current = await free.operations.ledger(dir);
      if (current?.status === "committed") return recover(current)!;
      if (current?.status === "revoked")
        throw new AppError(409, "authorization_revoked");
      if (current?.status !== "conflict") throw e;
    }
    throw new AppError(409, "revision_conflict");
  };
  const old = await free.content.get(b.target.asset_id, null);
  if (
    b.action === "create_character"
      ? !!old
      : !old ||
        old.deleted ||
        old.kind !== "character" ||
        old.revision !== b.baseRevision
  )
    return closeConflict();
  const value = old
    ? {
        ...clean(old),
        content: d.payload.content,
        updatedAt: new Date().toISOString(),
        currentVersion: old.currentVersion + 1,
      }
    : entity("character", d.payload.content, null, b.target.asset_id);
  const receipt: ReceiptV2 = {
    protocol_version: 2,
    operation_id: task.operationId,
    status: "committed",
    conversation_id: task.conversationId,
    task_id: task.id,
    kind:
      b.action === "create_character"
        ? "character_created"
        : "character_updated",
    target: b.target,
    draft_id: d.id,
    draft_revision: "1",
    draft_hash: d.draftHash,
    content_hash: freeDigest(d.payload.content),
    revision: String(value.currentVersion),
  };
  try {
    await free.records.transaction(
      "library",
      [
        {
          record: {
            ...op,
            status: "committed",
            draftRef,
            payloadHash,
            receipt,
          },
          revision: op.revision,
        },
      ],
      { entity: value, revision: b.baseRevision },
    );
  } catch (e) {
    const current = await free.operations.ledger(dir);
    if (current) {
      const result = recover(current);
      if (result) return result;
    }
    if (e instanceof AppError && e.statusCode === 409) {
      op = current ?? op;
      return closeConflict();
    }
    throw e;
  }
  // Projection is recoverable; only the target OP determines persistence.
  await free.operations.reconcile(task.id).catch(() => {});
  return { data: { status: "committed" }, receipt };
}
