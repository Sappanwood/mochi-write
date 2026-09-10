import { randomUUID } from "node:crypto";
import type {
  AssetRef,
  CandidateAccess,
  ExactRef,
  FreeConversation,
  FreeTask,
  SourceRecord,
} from "../shared/free.js";
import { exactRefSchema } from "../shared/free.js";
import { AppError } from "../shared/model.js";
import type { Store } from "./store.js";
import type { FreeStore } from "./free-store.js";
import { libraryContentHash } from "./library-tools.js";
export const freeDigest = (value: unknown) =>
  libraryContentHash(value as Parameters<typeof libraryContentHash>[0]);
export class FreeReferences {
  constructor(
    private content: Store,
    private records: FreeStore,
    readonly candidates?: CandidateAccess,
  ) {}
  async sources(conversationId: string) {
    return this.records.list<SourceRecord>("source", conversationId);
  }
  async read(conversationId: string, raw: ExactRef) {
    const ref = exactRefSchema.parse(raw);
    if (ref.type === "candidate") {
      if (!this.candidates) throw new AppError(404, "reference_unavailable");
      return this.candidates.read(conversationId, ref);
    }
    const prior = (await this.sources(conversationId)).some(
      (s) => freeDigest(s.ref) === freeDigest(ref),
    );
    const doc = prior
      ? await this.content.getVersion(
          ref.asset_id,
          ref.story_id ?? null,
          ref.version,
        )
      : await this.content.get(ref.asset_id, ref.story_id ?? null);
    if (!doc || (!prior && doc.deleted))
      throw new AppError(404, "reference_unavailable");
    if (doc.kind !== ref.kind || doc.projectId !== (ref.story_id ?? null))
      throw new AppError(403, "forbidden_scope");
    if (!prior && (!("revision" in doc) || doc.revision !== ref.revision))
      throw new AppError(409, "reference_changed");
    if (
      doc.currentVersion !== ref.version ||
      libraryContentHash(doc.content) !== ref.content_hash
    )
      throw new AppError(409, "reference_changed");
    if (Buffer.byteLength(JSON.stringify(doc.content)) > 60 * 1024)
      throw new AppError(400, "result_too_large");
    return { content: doc.content };
  }
  async validate(conversationId: string, refs: ExactRef[]) {
    for (const ref of refs) await this.read(conversationId, ref);
  }
  source(
    conversationId: string,
    taskId: string,
    ref: ExactRef,
    origin: SourceRecord["origin"],
    invocationId?: string,
  ): SourceRecord {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      kind: "source",
      revision: "",
      createdAt: now,
      conversationId,
      ref,
      origin,
      task_id: taskId,
      read_at: now,
      ...(invocationId ? { invocation_id: invocationId } : {}),
    };
  }
  async recordRead(task: FreeTask, ref: ExactRef, invocationId: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const c = await this.records.get<FreeConversation>(
        "library",
        "conversation",
        task.conversationId,
      );
      if (
        !c ||
        c.epoch !== task.epoch ||
        c.activeTaskId !== task.id ||
        task.cancelRequestedAt
      )
        throw new AppError(409, "authorization_revoked");
      const reads = (await this.sources(task.conversationId)).filter(
        (s) => s.task_id === task.id,
      );
      const old = reads.find((s) => s.invocation_id === invocationId);
      if (old) {
        if (freeDigest(old.ref) !== freeDigest(ref))
          throw new AppError(409, "operation_conflict");
        return;
      }
      if (reads.length >= 20) throw new AppError(400, "result_too_large");
      try {
        await this.records.transaction("library", [
          { record: c, revision: c.revision },
          {
            record: this.source(c.id, task.id, ref, "agent_read", invocationId),
            revision: null,
          },
        ]);
        return;
      } catch (e) {
        if (
          !(e instanceof AppError) ||
          e.message !== "free_revision_conflict" ||
          attempt === 2
        )
          throw e;
      }
    }
  }
  async agentRead(
    conversation: FreeConversation,
    taskId: string,
    args: { asset_id: string; revision: string; story_id?: string },
    invocationId: string,
  ) {
    const prior = (await this.sources(conversation.id)).find(
      (s) =>
        s.ref.type === "asset" &&
        s.ref.asset_id === args.asset_id &&
        s.ref.revision === args.revision &&
        s.ref.story_id === args.story_id,
    );
    let ref = prior?.ref as AssetRef | undefined;
    if (!ref) {
      const doc = await this.content.get(args.asset_id, args.story_id ?? null);
      if (!doc || doc.deleted) throw new AppError(404, "reference_unavailable");
      if (doc.revision !== args.revision)
        throw new AppError(409, "reference_changed");
      ref = exactRefSchema.parse({
        type: "asset",
        kind: doc.kind,
        asset_id: doc.id,
        ...(args.story_id ? { story_id: args.story_id } : {}),
        revision: doc.revision,
        version: doc.currentVersion,
        content_hash: libraryContentHash(doc.content),
      }) as AssetRef;
    }
    const result = await this.read(conversation.id, ref);
    const task = await this.records.get<FreeTask>("library", "task", taskId);
    if (
      !task ||
      task.conversationId !== conversation.id ||
      task.epoch !== conversation.epoch
    )
      throw new AppError(403, "forbidden_scope");
    await this.recordRead(task, ref, invocationId);
    return { ...ref, ...result };
  }
}
