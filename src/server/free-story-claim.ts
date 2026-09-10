import type { FreeSession } from "./free-session.js";
import type { Candidate } from "../shared/free-candidates.js";
import type { FreeTask, DraftClaim } from "../shared/free.js";
import { AppError } from "../shared/model.js";
import { freeDigest } from "./free-references.js";
export async function claimStory(
  free: FreeSession,
  task: FreeTask,
  draft: Candidate,
  payloadHash: string,
) {
  const draftRef = free.candidates.ref(draft);
  for (let attempt = 0; attempt < 4; attempt++) {
    const dir = await free.operations.directory(task.operationId);
    if (!dir || dir.bindingDigest !== freeDigest(task.binding))
      throw new AppError(409, "operation_conflict");
    if (
      (dir.draftRef && freeDigest(dir.draftRef) !== freeDigest(draftRef)) ||
      (dir.payloadHash && dir.payloadHash !== payloadHash)
    )
      throw new AppError(409, "operation_conflict");
    const claim = await free.records.get<DraftClaim>(
      "library",
      "claim",
      draft.id,
    );
    if (
      claim &&
      (claim.draftId !== draft.id ||
        claim.conversationId !== task.conversationId ||
        claim.payloadHash !== payloadHash)
    )
      throw new AppError(409, "draft_conflict");
    if (claim && claim.operationId !== task.operationId) {
      const old = await free.operation(claim.operationId);
      if (!["revoked", "conflict"].includes(old.status) || old.receipt)
        throw new AppError(409, "draft_conflict");
    }
    if (!dir.draftRef) {
      try {
        await free.records.transaction("library", [
          { record: { ...dir, draftRef, payloadHash }, revision: dir.revision },
          {
            record: {
              id: draft.id,
              kind: "claim",
              revision: "",
              createdAt: claim?.createdAt ?? new Date().toISOString(),
              conversationId: task.conversationId,
              draftId: draft.id,
              operationId: task.operationId,
              payloadHash,
            },
            revision: claim?.revision ?? null,
          },
        ]);
      } catch (e) {
        if (!(e instanceof AppError) || e.statusCode !== 409 || attempt === 3)
          throw e;
        continue;
      }
    } else if (claim?.operationId !== task.operationId)
      throw new AppError(409, "draft_conflict");
    const op = await free.operations.ledger(dir);
    if (!op) throw new AppError(409, "operation_conflict");
    if (
      (op.draftRef && freeDigest(op.draftRef) !== freeDigest(draftRef)) ||
      (op.payloadHash && op.payloadHash !== payloadHash)
    )
      throw new AppError(409, "operation_conflict");
    if (op.draftRef || op.status !== "active") return op;
    try {
      await free.records.transaction(dir.partition, [
        { record: { ...op, draftRef, payloadHash }, revision: op.revision },
      ]);
      return (await free.operations.ledger(dir))!;
    } catch (e) {
      if (!(e instanceof AppError) || e.statusCode !== 409 || attempt === 3)
        throw e;
    }
  }
  throw new AppError(409, "operation_conflict");
}
