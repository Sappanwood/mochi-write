import { z } from "zod";
import type { FreeSession } from "./free-session.js";
import {
  freeHash,
  freeId,
  type FreeTask,
  type Ledger,
  type ReceiptV2,
} from "../shared/free.js";
import type { InitializationPackage } from "../shared/creative.js";
import { AppError } from "../shared/model.js";
import { entity, hash } from "./entities.js";
import { freeDigest } from "./free-references.js";
import { claimStory } from "./free-story-claim.js";
import type { StoryWrite } from "./free-story-operations.js";
export async function saveStory(
  free: FreeSession,
  input: FreeTask,
  name: string,
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
  if (
    b.target.kind !== "story" ||
    name !==
      (b.action === "create_chapter" ? "create_chapter" : "initialize_story") ||
    !["initialize_story", "save_first_chapter", "create_chapter"].includes(
      b.action,
    )
  )
    throw new AppError(403, "forbidden_scope");
  const d = await free.candidates.get(task.conversationId, args.draft_id),
    ref = free.candidates.ref(d),
    context = d.payload.draftContext;
  if (d.draftHash !== args.draft_hash)
    throw new AppError(409, "draft_conflict");
  if (
    d.artifactKind !==
      (name === "create_chapter" ? "chapter" : "story_initialization") ||
    d.payload.action !== b.action ||
    freeDigest(context.target) !== freeDigest(b.target) ||
    context.baseRevision !== b.baseRevision ||
    (b.selectedDraft
      ? freeDigest(b.selectedDraft) !== freeDigest(ref)
      : d.createdByTaskId !== task.id)
  )
    throw new AppError(403, "forbidden_scope");
  const pack = d.payload.business?.initialization as
    InitializationPackage | undefined;
  const chapterId = d.payload.business?.chapterId as string | undefined;
  if (
    name === "initialize_story"
      ? !pack
      : !chapterId || chapterId !== context.chapterId
  )
    throw new AppError(409, "draft_conflict");
  const payloadHash = pack
    ? freeDigest({ draftRef: ref, initialization: pack })
    : freeDigest({ draftRef: ref, content: d.payload.content, chapterId });
  op = await claimStory(free, task, d, payloadHash);
  const claimed = recover(op);
  if (claimed) return claimed;
  const conflict = async () => {
    try {
      await free.records.transaction(dir.partition, [
        { record: { ...op!, status: "conflict" }, revision: op!.revision },
      ]);
    } catch (e) {
      const latest = await free.operations.ledger(dir);
      if (latest) {
        const r = recover(latest);
        if (r) return r;
      }
      throw e;
    }
    throw new AppError(409, "revision_conflict");
  };
  const storyId = b.target.story_id,
    story = await free.content.get(storyId, storyId);
  if (
    (story?.revision ?? null) !== b.baseRevision ||
    story?.deleted ||
    (story && (story.kind !== "story" || story.status !== "ready"))
  )
    return conflict();
  let business: StoryWrite;
  const receipt: ReceiptV2 = {
    protocol_version: 2,
    operation_id: task.operationId,
    status: "committed",
    conversation_id: task.conversationId,
    task_id: task.id,
    kind: pack
      ? pack.chapter
        ? "first_chapter_saved"
        : "story_initialized"
      : "chapter_created",
    target: b.target,
    draft_id: d.id,
    draft_revision: "1",
    draft_hash: d.draftHash,
    content_hash: pack
      ? d.draftHash
      : "sha256:" + hash(d.payload.content.markdown),
    revision: pack ? String(pack.story.entity.currentVersion) : "1",
  };
  if (pack) {
    if (
      pack.story.entity.id !== storyId ||
      pack.story.baseRevision !== b.baseRevision ||
      Boolean(pack.chapter) !== (b.action === "save_first_chapter")
    )
      throw new AppError(403, "forbidden_scope");
    if (
      (
        await free.content.list({
          projectId: storyId,
          kind: "chapter",
          limit: 1,
        })
      ).items.length
    )
      return conflict();
    for (const a of pack.assets)
      if (
        ((await free.content.get(a.entity.id, storyId))?.revision ?? null) !==
        a.baseRevision
      )
        return conflict();
    receipt.assets = pack.assets.map((a) => ({
      asset_id: a.entity.id,
      kind: a.entity.kind as "setting" | "outline" | "snapshot",
      revision: String(a.entity.currentVersion),
      content_hash: freeDigest(a.entity.content),
    }));
    if (pack.chapter)
      receipt.chapter = {
        chapter_id: pack.chapter.entity.id,
        revision: "1",
        content_hash: "sha256:" + hash(pack.chapter.entity.content.markdown),
      };
    business = { initialization: pack };
  } else {
    if (!story || story.initializationPending) return conflict();
    let order = 0,
      cursor: string | undefined,
      pages = 0;
    do {
      if (++pages > 50) throw new AppError(400, "result_too_large");
      const page = await free.content.list({
        projectId: storyId,
        kind: "chapter",
        limit: 40,
        cursor,
      });
      for (const c of page.items) order = Math.max(order, c.order ?? 0);
      cursor = page.cursor;
    } while (cursor);
    const chapter = {
      ...entity("chapter", d.payload.content, storyId, chapterId!),
      order: order + 1,
    };
    business = { chapter, story };
    receipt.chapter = {
      chapter_id: chapter.id,
      revision: "1",
      content_hash: receipt.content_hash,
    };
  }
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
      business,
    );
  } catch (e) {
    const latest = await free.operations.ledger(dir);
    if (latest) {
      const r = recover(latest);
      if (r) return r;
    }
    if (e instanceof AppError && e.statusCode === 409) return conflict();
    throw e;
  }
  try {
    await free.operations.reconcile(task.id);
  } catch {
    /* The target OP remains authoritative. */
  }
  return { data: { status: "committed" }, receipt };
}
