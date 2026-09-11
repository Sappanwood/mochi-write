import { z } from "zod";
import {
  freeId,
  freeHash,
  type FreeTask,
  type Ledger,
  type ReceiptV2,
} from "../shared/free.js";
import type { MaterialPackage } from "../shared/story-materials.js";
import type { FreeSession } from "./free-session.js";
import { AppError } from "../shared/model.js";
import { freeDigest } from "./free-references.js";
import { claimStory } from "./free-story-claim.js";
export async function saveMaterials(
  free: FreeSession,
  input: FreeTask,
  raw: unknown,
) {
  const args = z
    .object({
      mode: z.literal("commit"),
      draft_id: freeId,
      draft_revision: z.literal("1"),
      draft_hash: freeHash,
    })
    .strict()
    .parse(raw);
  const task = await free.task(input.id),
    b = task.binding;
  if (
    !b ||
    b.action !== "revise_story_materials" ||
    b.target.kind !== "story" ||
    !b.materials?.length
  )
    throw new AppError(403, "authorization_required");
  if (
    (await free.conversation(task.conversationId)).toolsetVersion !==
    "materials-v1"
  )
    throw new AppError(403, "forbidden_scope");
  const dir = await free.operations.directory(task.operationId);
  if (!dir || dir.bindingDigest !== freeDigest(b))
    throw new AppError(409, "operation_conflict");
  let op = await free.operations.ledger(dir);
  if (
    !op ||
    op.action !== b.action ||
    op.baseRevision !== b.baseRevision ||
    op.sourceMessageId !== task.sourceMessageId ||
    freeDigest(op.materials) !== freeDigest(b.materials)
  )
    throw new AppError(409, "operation_conflict");
  const recover = (current: Ledger) => {
    for (const ref of [dir.draftRef, current.draftRef])
      if (
        ref &&
        (ref.draft_id !== args.draft_id ||
          ref.draft_revision !== args.draft_revision ||
          ref.draft_hash !== args.draft_hash)
      )
        throw new AppError(409, "operation_conflict");
    if (current.status === "committed")
      return {
        data: { status: "committed" },
        receipt: free.operations.validateReceipt(dir, current),
      };
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
  const d = await free.candidates.get(task.conversationId, args.draft_id),
    ref = free.candidates.ref(d),
    context = d.payload.draftContext;
  if (d.draftHash !== args.draft_hash)
    throw new AppError(409, "draft_conflict");
  if (
    d.artifactKind !== "story_materials" ||
    d.payload.action !== b.action ||
    freeDigest(context.target) !== freeDigest(b.target) ||
    context.baseRevision !== b.baseRevision ||
    freeDigest(context.materials) !== freeDigest(b.materials) ||
    (b.selectedDraft
      ? freeDigest(b.selectedDraft) !== freeDigest(ref)
      : d.createdByTaskId !== task.id)
  )
    throw new AppError(403, "forbidden_scope");
  const pack = d.payload.business?.materials as MaterialPackage | undefined;
  if (
    !pack ||
    pack.story.id !== b.target.story_id ||
    freeDigest(pack.members.map((m) => m.spec)) !== freeDigest(b.materials)
  )
    throw new AppError(409, "draft_conflict");
  op = await claimStory(
    free,
    task,
    d,
    freeDigest({ draftRef: ref, materials: pack }),
  );
  const claimed = recover(op);
  if (claimed) return claimed;
  const conflict = async () => {
    try {
      await free.records.transaction(dir.partition, [
        { record: { ...op!, status: "conflict" }, revision: op!.revision },
      ]);
    } catch (error) {
      const latest = await free.operations.ledger(dir);
      if (latest) {
        const r = recover(latest);
        if (r) return r;
      }
      throw error;
    }
    throw new AppError(409, "revision_conflict");
  };
  const story = await free.content.get(pack.story.id, pack.story.id);
  if (
    !story ||
    story.revision !== b.baseRevision ||
    story.deleted ||
    story.status !== "ready" ||
    story.initializationPending ||
    !(
      await free.content.list({
        projectId: story.id,
        kind: "chapter",
        limit: 1,
      })
    ).items.length
  )
    return conflict();
  for (const m of pack.members) {
    const current = await free.content.get(m.entity.id, story.id);
    if (
      (current?.revision ?? null) !== m.baseRevision ||
      current?.deleted ||
      (current &&
        (current.kind !== m.spec.kind ||
          current.currentVersion !== m.spec.base_version))
    )
      return conflict();
  }
  const receipt: ReceiptV2 = {
    protocol_version: 2,
    operation_id: task.operationId,
    status: "committed",
    conversation_id: task.conversationId,
    task_id: task.id,
    kind: "story_materials_saved",
    target: b.target,
    draft_id: d.id,
    draft_revision: "1",
    draft_hash: d.draftHash,
    content_hash: d.draftHash,
    revision: String(story.currentVersion),
    assets: pack.members.map((m) => ({
      asset_id: m.entity.id,
      kind: m.spec.kind,
      mode: m.spec.mode,
      revision: String(m.entity.currentVersion),
      content_hash: freeDigest(m.entity.content),
    })),
  };
  try {
    await free.records.transaction(
      dir.partition,
      [
        {
          record: { ...op, status: "committed", receipt },
          revision: op.revision,
        },
      ],
      undefined,
      { materials: pack },
    );
  } catch (error) {
    const latest = await free.operations.ledger(dir);
    if (latest) {
      const r = recover(latest);
      if (r) return r;
    }
    if (error instanceof AppError && error.statusCode === 409)
      return conflict();
    throw error;
  }
  try {
    await free.operations.reconcile(task.id);
  } catch {
    /* The story OP is authoritative. */
  }
  return { data: { status: "committed" }, receipt };
}
