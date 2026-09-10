import { randomUUID } from "node:crypto";
import type {
  AssetRef,
  CandidateAccess,
  ExactRef,
  FreeConversation,
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
    ref: AssetRef,
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
  async agentRead(
    conversation: FreeConversation,
    taskId: string,
    args: { asset_id: string; revision: string; story_id?: string },
    invocationId: string,
  ) {
    const prior = (await this.sources(conversation.id)).find(
      (s) =>
        s.ref.asset_id === args.asset_id &&
        s.ref.revision === args.revision &&
        s.ref.story_id === args.story_id,
    );
    let ref = prior?.ref;
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
    const reads = (await this.sources(conversation.id)).filter(
      (s) => s.task_id === taskId,
    );
    if (
      reads.length >= 20 &&
      !reads.some((s) => s.invocation_id === invocationId)
    )
      throw new AppError(400, "result_too_large");
    if (!reads.some((s) => s.invocation_id === invocationId)) {
      const current = await this.records.get<FreeConversation>(
        "library",
        "conversation",
        conversation.id,
      );
      if (
        !current ||
        current.epoch !== conversation.epoch ||
        current.activeTaskId !== taskId
      )
        throw new AppError(409, "authorization_revoked");
      await this.records.transaction("library", [
        { record: current, revision: current.revision },
        {
          record: this.source(
            conversation.id,
            taskId,
            ref,
            "agent_read",
            invocationId,
          ),
          revision: null,
        },
      ]);
    }
    return { ...ref, ...result };
  }
}
