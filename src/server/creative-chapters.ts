import { z } from "zod";
import { AppError } from "../shared/model.js";
import type { ChapterReceipt, CreativeDraft } from "../shared/creative.js";
import { ToolError, TOOL_RESPONSE_BYTES } from "../shared/creative-tools.js";
import type { ToolTaskContext } from "./tool-routes.js";
import { entity, hash, stableId } from "./entities.js";
import { activeTask, decodeWire, type Creative } from "./creative.js";
const ref = z
  .object({
    mode: z.literal("commit"),
    draft_id: z.uuid(),
    draft_revision: z.literal("1"),
    draft_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
const draftInput = z
  .object({
    mode: z.literal("draft"),
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((s) => Buffer.byteLength(s) <= 512),
    body: z
      .string()
      .min(1)
      .refine((s) => Buffer.byteLength(s) <= 49152),
  })
  .strict();
const argsSchema = z.discriminatedUnion("mode", [ref, draftInput]);
export class CreativeChapters {
  constructor(private readonly host: Creative) {}
  async create(
    context: ToolTaskContext,
    raw: unknown,
    invocationId: string,
  ): Promise<{ data: unknown; receipt?: ChapterReceipt }> {
    const parsed = argsSchema.safeParse(raw);
    if (!parsed.success) throw new ToolError("invalid_arguments");
    const args = parsed.data;
    const { storyId, taskId } = decodeWire(context.taskId);
    if (
      storyId !== context.storyId ||
      !invocationId ||
      Buffer.byteLength(invocationId) > 128
    )
      throw new ToolError("forbidden_scope");
    return this.host.serial(async () => {
      const task = await this.host.requireTask(storyId, taskId);
      const conversation = await this.host.requireConversation(
        storyId,
        task.conversationId,
      );
      if (
        context.sessionId !== conversation.sessionId ||
        context.operationId !== task.operationId ||
        context.sourceMessageId !== task.sourceMessageId ||
        context.authorizationId !== task.authorization?.id
      )
        throw new ToolError("forbidden_scope");
      if (args.mode === "draft") {
        const priorId = Object.hasOwn(task.draftInvocations, invocationId)
          ? task.draftInvocations[invocationId]
          : undefined;
        if (priorId) {
          const prior = await this.host.records.draft(storyId, priorId);
          if (
            !prior ||
            prior.artifactKind ||
            prior.body !== args.body ||
            prior.title !== args.title
          )
            throw new ToolError("operation_conflict");
          return { data: this.data(prior) };
        }
        if (!activeTask(task) || conversation.activeTaskId !== task.id)
          throw new ToolError("authorization_revoked");
        if (task.artifacts.length >= 20)
          throw new ToolError("result_too_large");
        const now = new Date().toISOString();
        const draft: CreativeDraft = {
          id: stableId(`${task.id}:${invocationId}`),
          kind: "draft",
          storyId,
          conversationId: task.conversationId,
          taskId: task.id,
          createdAt: now,
          updatedAt: now,
          revision: "",
          title: args.title,
          body: args.body,
          draftRevision: "1",
          hash: `sha256:${hash(args.body)}`,
        };
        const data = this.data(draft);
        if (
          Buffer.byteLength(JSON.stringify(data)) >
          TOOL_RESPONSE_BYTES - 1024
        )
          throw new ToolError("result_too_large");
        task.artifacts.push({
          draft_id: draft.id,
          draft_revision: draft.draftRevision,
          draft_hash: draft.hash,
        });
        task.draftInvocations[invocationId] = draft.id;
        task.updatedAt = now;
        await this.host.records.transaction(storyId, [
          { record: task, revision: task.revision },
          { record: draft, revision: null },
        ]);
        return { data };
      }
      const draft = await this.host.records.draft(storyId, args.draft_id);
      if (
        !draft ||
        draft.artifactKind ||
        draft.conversationId !== task.conversationId ||
        draft.draftRevision !== args.draft_revision ||
        draft.hash !== args.draft_hash ||
        draft.hash !== `sha256:${hash(draft.body)}`
      )
        throw new ToolError("draft_conflict");
      const digest = hash(
        JSON.stringify({
          draft_id: draft.id,
          revision: draft.draftRevision,
          title: draft.title,
          body: draft.body,
          hash: draft.hash,
        }),
      );
      if (task.receipt) {
        if ("kind" in task.receipt || task.commitDigest !== digest)
          throw new ToolError("operation_conflict");
        return this.committed(task.receipt);
      }
      if (draft.receipt) throw new ToolError("operation_conflict");
      if (
        !task.authorization ||
        context.authorizationId !== task.authorization.id
      )
        throw new ToolError("authorization_required");
      if (
        !activeTask(task) ||
        conversation.activeTaskId !== task.id ||
        task.authorization.status !== "active"
      )
        throw new ToolError("authorization_revoked");
      if (
        task.authorization.action !== "create_chapter" ||
        task.authorization.maxCreates !== 1
      )
        throw new ToolError("forbidden_scope");
      const selected = task.authorization.draftRef;
      if (
        selected
          ? selected.draft_id !== draft.id ||
            selected.draft_revision !== draft.draftRevision ||
            selected.draft_hash !== draft.hash
          : draft.taskId !== task.id
      )
        throw new ToolError("draft_conflict");
      if (task.commitDigest && task.commitDigest !== digest)
        throw new ToolError("operation_conflict");
      const story = await this.host.scope(storyId);
      if (story.initializationPending) throw new ToolError("forbidden_scope");
      let cursor: string | undefined;
      let order = 0;
      let pages = 0;
      do {
        if (++pages > 50) throw new ToolError("result_too_large");
        const page = await this.host.content.list({
          projectId: storyId,
          kind: "chapter",
          limit: 40,
          cursor,
        });
        for (const chapter of page.items)
          order = Math.max(order, chapter.order ?? 0);
        cursor = page.cursor;
      } while (cursor);
      if (await this.host.content.get(task.chapterId, storyId))
        throw new ToolError("operation_conflict");
      const chapter = {
        ...entity(
          "chapter",
          {
            name: draft.title,
            markdown: draft.body,
            genres: [],
            ageBand: "",
            sourceMetadata: {},
          },
          storyId,
          task.chapterId,
        ),
        order: order + 1,
      };
      const receipt: ChapterReceipt = {
        operation_id: task.operationId,
        status: "committed",
        story_id: storyId,
        chapter_id: task.chapterId,
        revision: "1",
        content_hash: draft.hash,
      };
      task.authorization.status = "consumed";
      task.receipt = receipt;
      task.operationStatus = "committed";
      task.commitDigest = digest;
      task.updatedAt = new Date().toISOString();
      draft.receipt = receipt;
      draft.updatedAt = task.updatedAt;
      try {
        await this.host.records.transaction(
          storyId,
          [
            { record: task, revision: task.revision },
            { record: draft, revision: draft.revision },
            { record: conversation, revision: conversation.revision },
          ],
          chapter,
        );
      } catch (error) {
        if (error instanceof AppError && error.statusCode === 409) {
          const latest = await this.host.requireTask(storyId, taskId);
          if (
            latest.receipt &&
            !("kind" in latest.receipt) &&
            latest.commitDigest === digest
          )
            return this.committed(latest.receipt);
          throw new ToolError(
            latest.authorization?.status === "revoked"
              ? "authorization_revoked"
              : "operation_conflict",
          );
        }
        throw error;
      }
      return this.committed(receipt);
    });
  }
  private data(draft: CreativeDraft) {
    return {
      draft_id: draft.id,
      draft_revision: draft.draftRevision,
      draft_hash: draft.hash,
      title: draft.title,
      body: draft.body,
    };
  }
  private committed(receipt: ChapterReceipt) {
    return {
      data: {
        chapter_id: receipt.chapter_id,
        revision: receipt.revision,
        content_hash: receipt.content_hash,
      },
      receipt,
    };
  }
  async operation(encoded: string) {
    const { storyId, taskId } = decodeWire(encoded);
    const task = await this.host.records.task(storyId, taskId);
    const base = { protocol_version: 1 as const, operation_id: encoded };
    if (!task || task.operationId !== encoded)
      return { ...base, status: "not_found" as const };
    if (task.receipt)
      return { ...base, status: "committed" as const, receipt: task.receipt };
    if (task.authorization?.status === "revoked" || task.status === "cancelled")
      return {
        ...base,
        status: "rejected" as const,
        error: { code: "authorization_revoked" },
      };
    return { ...base, status: "not_found" as const };
  }
}
