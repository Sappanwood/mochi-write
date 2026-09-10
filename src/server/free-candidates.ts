import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FreeSession } from "./free-session.js";
import { freeDigest } from "./free-references.js";
import { stableId } from "./entities.js";
import { AppError, contentSchema, type Content } from "../shared/model.js";
import {
  candidateRefSchema,
  exactRefSchema,
  freeId,
  type Action,
  type FreeTask,
} from "../shared/free.js";
import type {
  ArtifactKind,
  Candidate,
  CandidateGroup,
  CandidatePayload,
  CandidateRef,
} from "../shared/free-candidates.js";
export const groupFields = {
  group_id: freeId.optional(),
  parent_ref: candidateRefSchema.optional(),
  derived_from: exactRefSchema.optional(),
};
const freezeSchema = z
  .object({
    artifactKind: z.enum(["character", "story_initialization", "chapter"]),
    content: contentSchema,
    ...groupFields,
  })
  .strict();
export class FreeCandidates {
  constructor(private free: FreeSession) {}
  ref(d: Candidate): CandidateRef {
    return {
      type: "candidate",
      group_id: d.groupId,
      draft_id: d.id,
      draft_revision: "1",
      draft_hash: d.draftHash,
    };
  }
  summary(d: Candidate) {
    const { type: _type, ...ref } = this.ref(d);
    void _type;
    return {
      ...ref,
      ordinal: d.ordinal,
      title: d.title,
      artifact_kind: d.artifactKind,
      ...(d.payload.parentRef ? { parent_ref: d.payload.parentRef } : {}),
      ...(d.payload.members
        ? {
            members: d.payload.members.map((m) => ({
              member_id: m.member_id,
              kind: m.kind,
              title: m.content.name,
              ...(m.sourceRef ? { source_ref: m.sourceRef } : {}),
            })),
          }
        : {}),
    };
  }
  async get(conversationId: string, id: string) {
    const d = await this.free.records.get<Candidate>(
      "library",
      "candidate",
      id,
    );
    if (!d) throw new AppError(404, "reference_unavailable");
    if (d.conversationId !== conversationId)
      throw new AppError(403, "forbidden_scope");
    if (
      freeDigest({
        id: d.id,
        groupId: d.groupId,
        artifactKind: d.artifactKind,
        payload: d.payload,
      }) !== d.draftHash
    )
      throw new AppError(409, "draft_conflict");
    return d;
  }
  async exact(conversationId: string, raw: CandidateRef) {
    const ref = candidateRefSchema.parse(raw),
      d = await this.get(conversationId, ref.draft_id);
    if (d.groupId !== ref.group_id || d.draftHash !== ref.draft_hash)
      throw new AppError(409, "draft_conflict");
    if (
      ref.member_id &&
      !d.payload.members?.some((m) => m.member_id === ref.member_id)
    )
      throw new AppError(404, "reference_unavailable");
    return d;
  }
  async read(conversationId: string, ref: CandidateRef) {
    const d = await this.exact(conversationId, ref);
    const content = ref.member_id
      ? d.payload.members!.find((m) => m.member_id === ref.member_id)!.content
      : d.payload.content;
    if (Buffer.byteLength(JSON.stringify(content)) > 60 * 1024)
      throw new AppError(400, "result_too_large");
    return {
      content: structuredClone(content),
      draftContext: d.payload.draftContext,
      action: d.payload.action,
    };
  }
  async groups(id: string) {
    await this.free.conversation(id);
    return (await this.free.records.list<CandidateGroup>("group", id)).sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }
  async drafts(id: string, groupId?: string) {
    await this.free.conversation(id);
    if (groupId) {
      const g = await this.free.records.get<CandidateGroup>(
        "library",
        "group",
        groupId,
      );
      if (!g) throw new AppError(404, "not_found");
      if (g.conversationId !== id) throw new AppError(403, "forbidden_scope");
    }
    return (await this.free.records.list<Candidate>("candidate", id))
      .filter((d) => !groupId || d.groupId === groupId)
      .sort((a, b) =>
        groupId
          ? a.ordinal - b.ordinal
          : a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
  }
  async freeze(
    task: FreeTask,
    raw: {
      artifactKind: ArtifactKind;
      content: Content;
      group_id?: string;
      parent_ref?: CandidateRef;
      derived_from?: import("../shared/free.js").ExactRef;
    },
    invocationId: string,
    extra?: {
      members?: CandidatePayload["members"];
      business?: CandidatePayload["business"];
      action?: Action;
    },
  ) {
    const input = freezeSchema.parse(raw);
    freeId.parse(invocationId);
    const id = stableId(
        `candidate:${task.conversationId}:${task.id}:${invocationId}`,
      ),
      inputDigest = freeDigest({ input, ...(extra ? { extra } : {}) });
    const old = await this.free.records.get<Candidate>(
      "library",
      "candidate",
      id,
    );
    if (old) {
      if (old.inputDigest !== inputDigest)
        throw new AppError(409, "operation_conflict");
      return old;
    }
    if (
      Boolean(input.group_id) !== Boolean(input.parent_ref) ||
      (input.group_id && input.derived_from)
    )
      throw new AppError(400, "invalid_arguments");
    const current = await this.free.task(task.id),
      gate = await this.free.guard(current);
    if (!["authorized", "running"].includes(current.state))
      throw new AppError(409, "task_closed");
    let context = current.draftContext;
    if (!context) throw new AppError(403, "forbidden_scope");
    let group: CandidateGroup | undefined;
    if (input.parent_ref) {
      const parent = await this.exact(task.conversationId, input.parent_ref);
      if (
        parent.groupId !== input.group_id ||
        parent.artifactKind !== input.artifactKind ||
        input.parent_ref.member_id
      )
        throw new AppError(409, "draft_conflict");
      if (
        context.mode !== parent.payload.draftContext.mode ||
        freeDigest(context.target ?? null) !==
          freeDigest(parent.payload.draftContext.target ?? null) ||
        context.baseRevision !== parent.payload.draftContext.baseRevision
      )
        throw new AppError(403, "forbidden_scope");
      context = parent.payload.draftContext;
      group = await this.free.records.get<CandidateGroup>(
        "library",
        "group",
        parent.groupId,
      );
      if (!group) throw new AppError(404, "reference_unavailable");
    }
    if (input.derived_from) {
      if (
        input.derived_from.type === "asset" &&
        input.derived_from.story_id &&
        !current.storyAllowlist.includes(input.derived_from.story_id)
      )
        throw new AppError(403, "forbidden_scope");
      await this.free.references.read(task.conversationId, input.derived_from);
    }
    if (
      (input.artifactKind === "character") !==
      context.mode.endsWith("character")
    )
      throw new AppError(403, "forbidden_scope");
    const now = new Date().toISOString(),
      groupRevision = group?.revision ?? null;
    group ??= {
      id: randomUUID(),
      kind: "group",
      revision: "",
      createdAt: now,
      conversationId: task.conversationId,
      artifactKind: input.artifactKind,
      createdByTaskId: task.id,
      nextOrdinal: 1,
      ...(input.derived_from ? { derivedFrom: input.derived_from } : {}),
    };
    const action: Action =
      extra?.action ??
      (input.artifactKind === "character"
        ? context.mode === "existing_character"
          ? "update_character"
          : "create_character"
        : input.artifactKind === "chapter"
          ? "create_chapter"
          : "initialize_story");
    const payload: CandidatePayload = {
      content: input.content,
      draftContext: context,
      action,
      ...(input.parent_ref ? { parentRef: input.parent_ref } : {}),
      ...(input.derived_from ? { derivedFrom: input.derived_from } : {}),
      ...(extra?.members ? { members: extra.members } : {}),
      ...(extra?.business ? { business: extra.business } : {}),
    };
    if (
      payload.members &&
      (payload.members.length > 8 ||
        new Set(payload.members.map((m) => m.member_id)).size !==
          payload.members.length)
    )
      throw new AppError(400, "invalid_arguments");
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (
      bytes >
      (input.artifactKind === "story_initialization" ? 256 : 60) * 1024
    )
      throw new AppError(400, "result_too_large");
    const drafts = (await this.drafts(task.conversationId)).filter(
      (d) => d.createdByTaskId === task.id,
    );
    if (
      drafts.length >= 8 ||
      drafts.reduce(
        (n, d) => n + Buffer.byteLength(JSON.stringify(d.payload)),
        bytes,
      ) >
        1024 * 1024
    )
      throw new AppError(400, "result_too_large");
    const d: Candidate = {
      id,
      kind: "candidate",
      revision: "",
      createdAt: now,
      conversationId: task.conversationId,
      groupId: group.id,
      ordinal: group.nextOrdinal++,
      createdByTaskId: task.id,
      artifactKind: input.artifactKind,
      title: input.content.name,
      payload,
      draftRevision: "1",
      draftHash: freeDigest({
        id,
        groupId: group.id,
        artifactKind: input.artifactKind,
        payload,
      }),
      inputDigest,
    };
    await this.free.records.transaction("library", [
      { record: gate, revision: gate.revision },
      { record: current, revision: current.revision },
      { record: group, revision: groupRevision },
      { record: d, revision: null },
    ]);
    return this.get(task.conversationId, id);
  }
}
