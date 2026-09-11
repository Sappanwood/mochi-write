import { materialMemberSchema } from "../shared/story-materials.js";
import { z } from "zod";
import { freeId, freeHash, type FreeTask } from "../shared/free.js";
import { AppError } from "../shared/model.js";
import { ToolError } from "../shared/creative-tools.js";
import type { FreeSession } from "./free-session.js";
import { freeDigest } from "./free-references.js";
import { freeScope } from "./free-workflow.js";
import { freeTools } from "./free-tools.js";
import { LibraryTools } from "./library-tools.js";
import { AssetTools } from "./asset-tools.js";
import { candidateTool } from "./free-candidate-tools.js";
const target = z.union([
  z.object({ kind: z.enum(["character", "world"]), asset_id: freeId }).strict(),
  z.object({ kind: z.literal("story"), story_id: freeId }).strict(),
]);
const scope = z
  .object({
    protocol_version: z.literal(2),
    conversation_id: freeId,
    source_message_id: freeId,
    operation_id: freeId,
    phase: z.enum(["resolve", "execute"]),
    refs_digest: freeHash,
    binding_digest: freeHash.optional(),
    authorization_id: freeId.optional(),
    action: z
      .enum([
        "create_world",
        "update_world",
        "create_character",
        "update_character",
        "initialize_story",
        "save_first_chapter",
        "create_chapter",
        "revise_story_materials",
      ])
      .optional(),
    target: target.optional(),
    material_members: z.array(materialMemberSchema).min(1).max(8).optional(),
  })
  .strict();
const schema = z
  .object({
    protocol_version: z.literal(2),
    app_id: z.literal("mochi-write"),
    session_id: z.uuid(),
    run_id: z.uuid(),
    task_id: z.uuid(),
    scope,
    invocation_id: freeId,
    tool_call_id: freeId,
    tool: z.object({ name: freeId, version: freeId }).strict(),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();
export interface FreeToolHandler {
  invoke(
    task: FreeTask,
    name: string,
    args: Record<string, unknown>,
    invocationId: string,
  ): Promise<{ data: unknown; receipt?: unknown }>;
}
export class FreeCallback {
  private readonly assets: AssetTools;
  constructor(
    readonly free: FreeSession,
    readonly handler?: FreeToolHandler,
  ) {
    this.assets = new AssetTools(free.content);
  }
  async invoke(raw: unknown) {
    const cb = schema.parse(raw),
      base = { protocol_version: 2, invocation_id: cb.invocation_id };
    try {
      let task = await this.free.task(cb.task_id);
      const c = await this.free.conversation(task.conversationId);
      const tool = freeTools(c).find(
        (t) => t.name === cb.tool.name && t.version === cb.tool.version,
      );
      if (!tool || (task.binding?.target.kind === "world" && !c.toolsetVersion))
        throw new AppError(403, "forbidden_scope");
      if (
        cb.tool.name === "discover_artifacts" &&
        cb.tool.version === "2" &&
        cb.arguments.kind === "world"
      )
        throw new AppError(400, "invalid_arguments");
      const expected = freeScope(task, cb.scope.phase);
      const { task_id: _taskId, ...expectedScope } = expected;
      void _taskId;
      if (
        c.sessionId !== cb.session_id ||
        freeDigest(expectedScope) !== freeDigest(cb.scope)
      )
        throw new AppError(403, "forbidden_scope");
      const field =
        cb.scope.phase === "resolve" ? "resolutionRun" : "executionRun";
      const stage = task[field];
      if (
        !stage?.dispatchStarted ||
        stage.sessionId !== cb.session_id ||
        (stage.runId && stage.runId !== cb.run_id)
      )
        throw new AppError(403, "forbidden_scope");
      if (
        cb.scope.phase === "execute" &&
        cb.arguments.mode === "commit" &&
        task.binding
      ) {
        const args = z
          .object({
            mode: z.literal("commit"),
            draft_id: freeId,
            draft_revision: z.literal("1"),
            draft_hash: freeHash,
          })
          .strict()
          .parse(cb.arguments);
        const expectedTool =
          task.binding.action === "revise_story_materials"
            ? "revise_story_materials"
            : task.binding.target.kind === "world"
              ? "save_world"
              : task.binding.target.kind === "character"
                ? "save_character"
                : task.binding.action === "create_chapter"
                  ? "create_chapter"
                  : "initialize_story";
        if (cb.tool.name !== expectedTool || cb.tool.version !== "2")
          throw new AppError(403, "forbidden_scope");
        const directory = await this.free.operations.directory(
          task.operationId,
        );
        if (!directory || directory.bindingDigest !== freeDigest(task.binding))
          throw new AppError(409, "operation_conflict");
        const operation = await this.free.operation(task.operationId);
        if (operation.receipt) {
          const receipt = operation.receipt;
          if (
            receipt.draft_id !== args.draft_id ||
            receipt.draft_revision !== args.draft_revision ||
            receipt.draft_hash !== args.draft_hash
          )
            throw new AppError(409, "operation_conflict");
          return {
            ...base,
            outcome: "ok",
            data: { status: "committed" },
            receipt,
          };
        }
      }
      await this.free.guard(task);
      if (stage.status && !["queued", "running"].includes(stage.status))
        throw new AppError(403, "forbidden_scope");
      if (!stage.runId)
        task = await this.free.change(task.id, (t) => {
          if (t[field]!.runId && t[field]!.runId !== cb.run_id)
            throw new AppError(403, "forbidden_scope");
          t[field]!.runId = cb.run_id;
        });

      if (!tool) throw new AppError(400, "invalid_arguments");
      if (tool.effect === "write" && cb.scope.phase === "resolve")
        throw new AppError(403, "authorization_required");
      let result: { data: unknown; receipt?: unknown };
      const library = new LibraryTools(this.free.content);
      const args = cb.arguments;
      if (tool.name === "library_vocabulary")
        result = { data: await library.vocabulary(args) };
      else if (tool.name === "search_library")
        result = { data: await library.search(args) };
      else if (tool.name === "read_library") {
        const parsed = z
          .object({ asset_id: z.uuid(), revision: freeId })
          .strict()
          .parse(args);
        result = {
          data: await this.free.references.agentRead(
            c,
            task.id,
            parsed,
            cb.invocation_id,
          ),
        };
      } else if (tool.name === "search_assets" || tool.name === "read_asset") {
        const { story_id, ...rest } = args;
        const storyId = z.uuid().parse(story_id);
        if (!task.storyAllowlist.includes(storyId))
          throw new AppError(403, "forbidden_scope");
        if (tool.name === "read_asset") {
          const parsed = z
            .object({ asset_id: z.uuid(), revision: freeId })
            .strict()
            .parse(rest);
          result = {
            data: await this.free.references.agentRead(
              c,
              task.id,
              { ...parsed, story_id: storyId },
              cb.invocation_id,
            ),
          };
        } else
          result = {
            data: await this.assets.search(
              { storyId, recordSource: async () => {} },
              rest,
            ),
          };
      } else {
        if (tool.effect === "write" && args.mode === "commit") {
          if (!task.binding) throw new AppError(403, "authorization_required");
          const d = await this.free.operations.directory(task.operationId);
          const op = d ? await this.free.operations.ledger(d) : undefined;
          if (!op || op.status === "revoked")
            throw new AppError(409, "authorization_revoked");
          if (op.status === "conflict")
            throw new AppError(409, "revision_conflict");
          const expectedTool =
            task.binding.action === "revise_story_materials"
              ? "revise_story_materials"
              : task.binding.target.kind === "world"
                ? "save_world"
                : task.binding.target.kind === "character"
                  ? "save_character"
                  : task.binding.action === "create_chapter"
                    ? "create_chapter"
                    : "initialize_story";
          if (tool.name !== expectedTool)
            throw new AppError(403, "forbidden_scope");
        }
        result = this.handler
          ? await this.handler.invoke(task, tool.name, args, cb.invocation_id)
          : await candidateTool(
              this.free,
              task,
              tool.name,
              args,
              cb.invocation_id,
            );
      }
      const response = { ...base, outcome: "ok", ...result };
      if (Buffer.byteLength(JSON.stringify(response)) > 65536)
        throw new AppError(400, "result_too_large");
      return response;
    } catch (e) {
      if (e instanceof AppError && e.statusCode >= 500) throw e;
      if (
        e instanceof AppError ||
        e instanceof ToolError ||
        e instanceof z.ZodError
      )
        return {
          ...base,
          outcome: "error",
          error: {
            code:
              e instanceof ToolError
                ? e.code
                : e instanceof AppError
                  ? e.message === "题材或年龄层不在受控词表中"
                    ? "invalid_arguments"
                    : e.message
                  : "invalid_arguments",
            retryable: false,
          },
        };
      throw e;
    }
  }
}
