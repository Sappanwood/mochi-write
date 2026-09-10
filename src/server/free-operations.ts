import type {
  Binding,
  Directory,
  FreeConversation,
  FreeTask,
  Ledger,
  ReceiptV2,
  Target,
} from "../shared/free.js";
import { AppError } from "../shared/model.js";
import type { FreeStore } from "./free-store.js";
import { freeDigest } from "./free-references.js";
export const targetPartition = (t: Target) =>
  t.kind === "character" ? "library" : t.story_id;
export class FreeOperations {
  constructor(readonly records: FreeStore) {}
  async directory(id: string) {
    return this.records.get<Directory>("library", "directory", id);
  }
  async ledger(directory: Directory) {
    const op = await this.records.get<Ledger>(
      directory.partition,
      "op",
      directory.operationId,
    );
    if (
      op &&
      (op.bindingDigest !== directory.bindingDigest ||
        op.authorizationId !== directory.authorizationId ||
        op.taskId !== directory.taskId ||
        op.conversationId !== directory.conversationId ||
        freeDigest(op.target) !== freeDigest(directory.target))
    )
      throw new AppError(409, "operation_conflict");
    return op;
  }
  makeDirectory(task: FreeTask, binding: Binding): Directory {
    return {
      id: task.operationId,
      kind: "directory",
      revision: "",
      createdAt: new Date().toISOString(),
      operationId: task.operationId,
      taskId: task.id,
      conversationId: task.conversationId,
      target: binding.target,
      partition: targetPartition(binding.target),
      authorizationId: binding.authorizationId,
      bindingDigest: freeDigest(binding),
      stateProjection: "binding",
    };
  }
  makeLedger(task: FreeTask, status: Ledger["status"]): Ledger {
    const b = task.binding;
    if (!b) throw new AppError(409, "authorization_required");
    return {
      id: task.operationId,
      kind: "op",
      revision: "",
      createdAt: new Date().toISOString(),
      conversationId: task.conversationId,
      bindingDigest: freeDigest(b),
      authorizationId: b.authorizationId,
      taskId: task.id,
      sourceMessageId: task.sourceMessageId,
      action: b.action,
      target: b.target,
      baseRevision: b.baseRevision,
      status,
    };
  }
  async activate(task: FreeTask) {
    const d = await this.directory(task.operationId);
    if (!d) throw new AppError(409, "operation_directory_missing");
    let op = await this.ledger(d);
    if (!op) {
      const current = await this.records.get<FreeTask>(
          "library",
          "task",
          task.id,
        ),
        c = await this.records.get<FreeConversation>(
          "library",
          "conversation",
          task.conversationId,
        );
      if (
        !current ||
        current.cancelRequestedAt ||
        c?.activeTaskId !== task.id ||
        c.epoch !== task.epoch
      )
        throw new AppError(409, "authorization_revoked");
      try {
        await this.records.transaction(d.partition, [
          { record: this.makeLedger(task, "active"), revision: null },
        ]);
      } catch (e) {
        op = await this.ledger(d);
        if (!op) throw e;
      }
      op = await this.ledger(d);
    }
    if (op?.status !== "active" && op?.status !== "committed")
      throw new AppError(409, "authorization_revoked");
    return op;
  }
  async revoke(task: FreeTask) {
    const d = await this.directory(task.operationId);
    if (!d) return undefined;
    for (let tries = 0; tries < 4; tries++) {
      const old = await this.ledger(d);
      if (old && old.status !== "active") return old;
      try {
        await this.records.transaction(d.partition, [
          {
            record: old
              ? { ...old, status: "revoked" }
              : this.makeLedger(task, "revoked"),
            revision: old?.revision ?? null,
          },
        ]);
        return await this.ledger(d);
      } catch (e) {
        if (!(e instanceof AppError) || e.statusCode !== 409) throw e;
      }
    }
    throw new AppError(409, "previous_operation_pending");
  }
  validateReceipt(d: Directory, op: Ledger): ReceiptV2 {
    const r = op.receipt;
    const kinds = {
      create_character: "character_created",
      update_character: "character_updated",
      initialize_story: "story_initialized",
      save_first_chapter: "first_chapter_saved",
      create_chapter: "chapter_created",
    };
    if (
      !r ||
      r.protocol_version !== 2 ||
      r.status !== "committed" ||
      r.operation_id !== d.operationId ||
      r.task_id !== d.taskId ||
      r.conversation_id !== d.conversationId ||
      r.kind !== kinds[op.action] ||
      freeDigest(r.target) !== freeDigest(d.target) ||
      !op.draftRef ||
      r.draft_id !== op.draftRef.draft_id ||
      r.draft_revision !== op.draftRef.draft_revision ||
      r.draft_hash !== op.draftRef.draft_hash ||
      !/^sha256:[a-f0-9]{64}$/.test(r.content_hash) ||
      !r.revision
    )
      throw new AppError(409, "invalid_operation_receipt");
    if (d.target.kind === "character" && (r.assets || r.chapter))
      throw new AppError(409, "invalid_operation_receipt");
    if (op.action === "initialize_story" && (!r.assets || r.chapter))
      throw new AppError(409, "invalid_operation_receipt");
    if (op.action === "save_first_chapter" && (!r.assets || !r.chapter))
      throw new AppError(409, "invalid_operation_receipt");
    if (
      op.action === "create_chapter" &&
      (r.assets ||
        !r.chapter ||
        r.content_hash !== r.chapter.content_hash ||
        r.revision !== r.chapter.revision)
    )
      throw new AppError(409, "invalid_operation_receipt");
    return r;
  }
  async query(id: string) {
    const d = await this.directory(id);
    const op = d ? await this.ledger(d) : undefined;
    return {
      protocol_version: 2 as const,
      operation_id: id,
      status: !op || op.status === "active" ? ("unknown" as const) : op.status,
      ...(op?.status === "committed"
        ? { receipt: this.validateReceipt(d!, op) }
        : {}),
    };
  }
  async reconcile(taskId: string) {
    const task = await this.records.get<FreeTask>("library", "task", taskId);
    if (!task) throw new AppError(404, "task_not_found");
    const result = await this.query(task.operationId);
    if (result.status === "unknown") return task;
    const conversation = await this.records.get<FreeConversation>(
      "library",
      "conversation",
      task.conversationId,
    );
    if (!conversation) throw new AppError(404, "conversation_not_found");
    task.state = result.status;
    task.receipt = result.receipt;
    if (result.receipt) {
      const t = result.receipt.target;
      if (
        !conversation.associatedAssets.some(
          (x) => freeDigest(x) === freeDigest(t),
        )
      )
        conversation.associatedAssets.push(t);
    }
    await this.records.transaction("library", [
      { record: task, revision: task.revision },
      { record: conversation, revision: conversation.revision },
    ]);
    return this.records.get<FreeTask>("library", "task", taskId);
  }
}
