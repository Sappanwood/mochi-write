import { z } from "zod";

const bytes = (max: number) =>
  z
    .string()
    .min(1)
    .refine((value) => new TextEncoder().encode(value).length <= max);
export const toolIdSchema = bytes(128);
export const assetKindSchema = z.enum([
  "setting",
  "outline",
  "snapshot",
  "chapter",
]);
export const searchAssetsSchema = z
  .object({
    query: z.string().refine((value) => [...value].length <= 256),
    kind: assetKindSchema.optional(),
    limit: z.number().int().min(1).max(20).default(10),
    cursor: bytes(4096).optional(),
  })
  .strict();
export const readAssetSchema = z
  .object({ asset_id: toolIdSchema, revision: toolIdSchema })
  .strict();
export const callbackSchema = z
  .object({
    protocol_version: z.literal(1),
    app_id: toolIdSchema,
    session_id: toolIdSchema,
    run_id: toolIdSchema,
    task_id: toolIdSchema,
    scope: z
      .object({
        story_id: toolIdSchema,
        source_message_id: toolIdSchema,
        operation_id: toolIdSchema,
        authorization_id: toolIdSchema.optional(),
      })
      .strict(),
    tool: z.object({ name: toolIdSchema, version: z.literal("1") }).strict(),
    tool_call_id: toolIdSchema,
    invocation_id: toolIdSchema,
    arguments: z.unknown(),
  })
  .strict();
export type ToolCallback = z.infer<typeof callbackSchema>;
export type AssetSource = {
  asset_id: string;
  kind: z.infer<typeof assetKindSchema> | "draft" | "character" | "world";
  title: string;
  revision: string;
  scope?: "library";
  version?: number;
  content_hash?: string;
};
export type AssetRead = AssetSource & { content: string };
export type ToolErrorCode =
  | "invalid_arguments"
  | "forbidden_scope"
  | "authorization_required"
  | "authorization_revoked"
  | "draft_conflict"
  | "operation_conflict"
  | "revision_conflict"
  | "invalid_cursor"
  | "not_found"
  | "result_too_large";
export class ToolError extends Error {
  constructor(public code: ToolErrorCode) {
    super(code);
  }
}
export const TOOL_RESPONSE_BYTES = 64 * 1024;
export const TOOL_REQUEST_BYTES = 128 * 1024;
