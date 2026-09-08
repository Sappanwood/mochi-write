import type { FastifyInstance } from "fastify";
import type { ChapterReceipt } from "../shared/creative.js";
import {
  callbackSchema,
  toolIdSchema,
  ToolError,
  TOOL_REQUEST_BYTES,
  TOOL_RESPONSE_BYTES,
  type ToolCallback,
} from "../shared/creative-tools.js";
import type { AssetContext, AssetTools } from "./asset-tools.js";

export interface ToolTaskContext extends AssetContext {
  taskId: string;
  sessionId: string;
  sourceMessageId: string;
  operationId: string;
  authorizationId?: string;
  // Atomically bind the first run; reject a different run instead of taking over.
  bindRun: (runId: string) => Promise<void>;
}
export interface AgentToolOptions {
  assets: AssetTools;
  resolveTask: (taskId: string) => Promise<ToolTaskContext | undefined>;
  createChapter?: (
    context: ToolTaskContext,
    args: unknown,
    invocationId: string,
  ) => Promise<{ data: unknown; receipt?: ChapterReceipt }>;
  operation?: (operationId: string) => Promise<unknown>;
}
export function registerAgentTools(
  app: FastifyInstance,
  options: AgentToolOptions,
) {
  app.post(
    "/api/agent/tools",
    { bodyLimit: TOOL_REQUEST_BYTES, config: { mochiCallback: true } },
    async (request) => {
      const callback = callbackSchema.parse(request.body);
      const base = {
        protocol_version: 1 as const,
        invocation_id: callback.invocation_id,
      };
      try {
        if (callback.app_id !== "mochi-write")
          throw new ToolError("forbidden_scope");
        if (
          ![
            "search_assets",
            "read_asset",
            ...(options.createChapter ? ["create_chapter"] : []),
          ].includes(callback.tool.name)
        )
          throw new ToolError("invalid_arguments");
        const context = await options.resolveTask(callback.task_id);
        checkBinding(context, callback);
        await context.bindRun(callback.run_id);
        const result =
          callback.tool.name === "create_chapter"
            ? await options.createChapter!(
                context,
                callback.arguments,
                callback.invocation_id,
              )
            : {
                data:
                  callback.tool.name === "search_assets"
                    ? await options.assets.search(context, callback.arguments)
                    : await options.assets.read(context, callback.arguments),
              };
        const response = { ...base, outcome: "ok" as const, ...result };
        if (Buffer.byteLength(JSON.stringify(response)) > TOOL_RESPONSE_BYTES)
          throw new ToolError("result_too_large");
        return response;
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        return {
          ...base,
          outcome: "error" as const,
          error: { code: error.code, retryable: false },
        };
      }
    },
  );
  if (options.operation)
    app.get(
      "/api/agent/operations/:operationId",
      { config: { mochiCallback: true } },
      async (request) => {
        const { operationId } = request.params as { operationId: string };
        toolIdSchema.parse(operationId);
        try {
          return await options.operation!(operationId);
        } catch (error) {
          if (!(error instanceof ToolError)) throw error;
          return {
            protocol_version: 1,
            operation_id: operationId,
            status: "rejected",
            error: { code: error.code },
          };
        }
      },
    );
}
function checkBinding(
  context: ToolTaskContext | undefined,
  callback: ToolCallback,
): asserts context is ToolTaskContext {
  if (
    !context ||
    context.taskId !== callback.task_id ||
    context.sessionId !== callback.session_id ||
    context.storyId !== callback.scope.story_id ||
    context.sourceMessageId !== callback.scope.source_message_id ||
    context.operationId !== callback.scope.operation_id ||
    context.authorizationId !== callback.scope.authorization_id
  )
    throw new ToolError("forbidden_scope");
}
