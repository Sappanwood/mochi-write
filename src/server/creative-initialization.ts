import { AppError } from "../shared/model.js";
import type {
  CreativeDraft,
  CreativeTask,
  InitializationReceipt,
} from "../shared/creative.js";
import { ToolError } from "../shared/creative-tools.js";
import type { ToolTaskContext } from "./tool-routes.js";
import { activeTask, decodeWire, type Creative } from "./creative.js";
import { hash, stableId } from "./entities.js";
import { libraryContentHash } from "./library-tools.js";
import {
  initializationArgs,
  canonicalJson,
  packageHash,
  checkPackageSize,
  initializationSummary,
} from "./initialization-package.js";
import { buildInitialization } from "./initialization-builder.js";
export class CreativeInitialization {
  constructor(private readonly host: Creative) {}
  async create(
    context: ToolTaskContext,
    raw: unknown,
    invocationId: string,
  ): Promise<{ data: unknown; receipt?: InitializationReceipt }> {
    if (Buffer.byteLength(JSON.stringify(raw) ?? "") > 120 * 1024)
      throw new ToolError("result_too_large");
    const parsed = initializationArgs.safeParse(raw);
    if (!parsed.success) throw new ToolError("invalid_arguments");
    const { storyId, taskId } = decodeWire(context.taskId),
      args = parsed.data;
    if (
      storyId !== context.storyId ||
      !invocationId ||
      Buffer.byteLength(invocationId) > 128
    )
      throw new ToolError("forbidden_scope");
    return this.host.serial(async () => {
      const task = await this.host.requireTask(storyId, taskId),
        conversation = await this.host.requireConversation(
          storyId,
          task.conversationId,
        );
      if (
        !conversation.lifecycle ||
        conversation.sessionId !== context.sessionId ||
        task.operationId !== context.operationId ||
        task.sourceMessageId !== context.sourceMessageId ||
        task.authorization?.id !== context.authorizationId
      )
        throw new ToolError("forbidden_scope");
      if (args.mode === "draft") {
        const inputDigest = packageHash(args),
          priorId = Object.hasOwn(task.draftInvocations, invocationId)
            ? task.draftInvocations[invocationId]
            : undefined;
        if (priorId) {
          const prior = await this.host.records.draft(storyId, priorId);
          if (
            prior?.artifactKind !== "story_initialization" ||
            prior.inputDigest !== inputDigest
          )
            throw new ToolError("operation_conflict");
          return { data: this.data(prior) };
        }
        if (!activeTask(task) || conversation.activeTaskId !== task.id)
          throw new ToolError("authorization_revoked");
        if (task.artifacts.length >= 20)
          throw new ToolError("result_too_large");
        const story = await this.host.lifecycle.target(
          storyId,
          conversation.id,
        );
        if (
          (
            await this.host.content.list({
              projectId: storyId,
              kind: "chapter",
              limit: 1,
            })
          ).items.length
        )
          throw new ToolError("forbidden_scope");
        if (story && !args.chapter) throw new ToolError("forbidden_scope");
        const now = new Date().toISOString(),
          draftId = stableId(`${task.id}:${invocationId}`);
        const initialization = await buildInitialization(
          this.host.content,
          storyId,
          story,
          args,
          draftId,
          async (a) => {
            const source = conversation.librarySources?.find(
              (s) =>
                s.asset_id === a.source_id &&
                s.version === a.source_version &&
                s.content_hash === a.source_hash &&
                s.scope === "library",
            );
            if (!source) throw new ToolError("forbidden_scope");
            const master = await this.host.content.getVersion(
              source.asset_id,
              null,
              source.version!,
            );
            if (
              !master ||
              master.deleted ||
              master.projectId !== null ||
              !["character", "world"].includes(master.kind) ||
              libraryContentHash(master.content) !== source.content_hash
            )
              throw new ToolError("revision_conflict");
            if (
              Buffer.byteLength(
                JSON.stringify({ ...source, content: master.content }),
              ) >
              60 * 1024
            )
              throw new ToolError("result_too_large");
            return { source, master };
          },
        );
        const draft: CreativeDraft = {
          id: draftId,
          kind: "draft",
          storyId,
          conversationId: conversation.id,
          taskId,
          createdAt: now,
          updatedAt: now,
          revision: "",
          title: args.title,
          body: args.chapter?.body ?? "",
          artifactKind: "story_initialization",
          initialization,
          inputDigest,
          draftRevision: "1",
          hash: packageHash(initialization),
        };
        const data = this.data(draft);
        task.artifacts.push({
          draft_id: draft.id,
          draft_revision: "1",
          draft_hash: draft.hash,
          artifact_kind: "story_initialization",
          includes_chapter: Boolean(initialization.chapter),
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
        draft.artifactKind !== "story_initialization" ||
        !draft.initialization ||
        draft.conversationId !== conversation.id ||
        draft.draftRevision !== args.draft_revision ||
        draft.hash !== args.draft_hash ||
        draft.hash !== packageHash(draft.initialization)
      )
        throw new ToolError("draft_conflict");
      const digest = hash(canonicalJson({ tool: "initialize_story", ...args }));
      if (task.receipt) {
        if (!("kind" in task.receipt) || task.commitDigest !== digest)
          throw new ToolError("operation_conflict");
        return this.committed(task.receipt);
      }
      if (draft.receipt) throw new ToolError("operation_conflict");
      this.authorize(task, draft, conversation.activeTaskId);
      const pack = draft.initialization;
      checkPackageSize(pack);
      const story = await this.host.lifecycle.target(storyId, conversation.id);
      if ((story?.revision ?? null) !== pack.story.baseRevision)
        throw new ToolError("revision_conflict");
      if (
        (
          await this.host.content.list({
            projectId: storyId,
            kind: "chapter",
            limit: 1,
          })
        ).items.length
      )
        throw new ToolError("revision_conflict");
      for (const a of pack.assets) {
        const current = await this.host.content.get(a.entity.id, storyId);
        if ((current?.revision ?? null) !== a.baseRevision)
          throw new ToolError("revision_conflict");
      }
      const receipt: InitializationReceipt = {
        operation_id: task.operationId,
        status: "committed",
        story_id: storyId,
        revision: String(pack.story.entity.currentVersion),
        content_hash: draft.hash,
        draft_id: draft.id,
        draft_revision: draft.draftRevision,
        draft_hash: draft.hash,
        assets: pack.assets.map((a) => ({
          asset_id: a.entity.id,
          kind: a.entity.kind as "setting" | "outline" | "snapshot",
          revision: String(a.entity.currentVersion),
          content_hash: libraryContentHash(a.entity.content),
        })),
        ...(pack.chapter
          ? {
              kind: "first_chapter_saved",
              chapter: {
                chapter_id: pack.chapter.entity.id,
                revision: "1",
                content_hash:
                  "sha256:" + hash(pack.chapter.entity.content.markdown),
              },
            }
          : { kind: "story_initialized" }),
      };
      task.authorization!.status = "consumed";
      task.receipt = receipt;
      task.commitDigest = digest;
      task.operationStatus = "committed";
      task.updatedAt = new Date().toISOString();
      draft.receipt = receipt;
      draft.updatedAt = task.updatedAt;
      try {
        await this.host.records.transaction(
          storyId,
          [
            { record: conversation, revision: conversation.revision },
            { record: task, revision: task.revision },
            { record: draft, revision: draft.revision },
          ],
          pack,
        );
      } catch (error) {
        if (error instanceof AppError && error.statusCode === 409) {
          const latest = await this.host.requireTask(storyId, taskId);
          if (
            latest.receipt &&
            "kind" in latest.receipt &&
            latest.commitDigest === digest
          )
            return this.committed(latest.receipt);
          throw new ToolError(
            latest.authorization?.status === "revoked"
              ? "authorization_revoked"
              : "revision_conflict",
          );
        }
        if (error instanceof AppError && error.statusCode === 413)
          throw new ToolError("result_too_large");
        throw error;
      }
      return this.committed(receipt);
    });
  }
  private authorize(
    task: CreativeTask,
    draft: CreativeDraft,
    activeTaskId: string | null,
  ) {
    const auth = task.authorization;
    if (!auth) throw new ToolError("authorization_required");
    if (
      !activeTask(task) ||
      activeTaskId !== task.id ||
      auth.status !== "active"
    )
      throw new ToolError("authorization_revoked");
    if (
      auth.action !== "initialize_story" ||
      auth.maxCreates !== 1 ||
      auth.includesChapter !== Boolean(draft.initialization?.chapter)
    )
      throw new ToolError("forbidden_scope");
    const selected = auth.draftRef;
    if (
      selected
        ? selected.draft_id !== draft.id ||
          selected.draft_revision !== draft.draftRevision ||
          selected.draft_hash !== draft.hash
        : draft.taskId !== task.id
    )
      throw new ToolError("draft_conflict");
  }
  private data(draft: CreativeDraft) {
    return {
      draft_id: draft.id,
      draft_revision: draft.draftRevision,
      draft_hash: draft.hash,
      title: draft.title,
      artifact_kind: "story_initialization",
      includes_chapter: Boolean(draft.initialization?.chapter),
      assets: initializationSummary(draft.initialization!),
    };
  }
  private committed(receipt: InitializationReceipt) {
    return {
      data: {
        story_id: receipt.story_id,
        kind: receipt.kind,
        revision: receipt.revision,
      },
      receipt,
    };
  }
}
