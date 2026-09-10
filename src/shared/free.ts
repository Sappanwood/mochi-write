import { z } from "zod";
import type { Content } from "./model.js";
import { thinkingLevels } from "./creative.js";
export const freeId = z
  .string()
  .min(1)
  .max(128)
  .refine((v) => Buffer.byteLength(v) <= 128);
export const freeHash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const assetRefSchema = z
  .object({
    type: z.literal("asset"),
    kind: z.enum([
      "character",
      "world",
      "story",
      "setting",
      "outline",
      "snapshot",
      "chapter",
    ]),
    asset_id: z.uuid(),
    story_id: z.uuid().optional(),
    revision: freeId,
    version: z.number().int().positive(),
    content_hash: freeHash,
  })
  .strict()
  .refine((r) =>
    ["character", "world"].includes(r.kind)
      ? !r.story_id
      : !!r.story_id && (r.kind !== "story" || r.asset_id === r.story_id),
  );
export const candidateRefSchema = z
  .object({
    type: z.literal("candidate"),
    group_id: freeId,
    draft_id: freeId,
    draft_revision: z.literal("1"),
    draft_hash: freeHash,
    member_id: freeId.optional(),
  })
  .strict();
export const exactRefSchema = z.union([assetRefSchema, candidateRefSchema]);
export type ExactRef = z.infer<typeof exactRefSchema>;
export type AssetRef = z.infer<typeof assetRefSchema>;
export const freeInputSchema = z
  .object({
    clientRequestId: z.uuid(),
    message: z
      .string()
      .min(1)
      .refine((s) => s.trim().length > 0 && Buffer.byteLength(s) <= 16384),
    provider: z.string().min(1).max(64),
    model: z.string().min(1).max(256),
    thinkingLevel: z.enum(thinkingLevels).optional(),
    refs: z.array(exactRefSchema).max(8).default([]),
  })
  .strict();
export type FreeInput = z.infer<typeof freeInputSchema>;
export type Target =
  { kind: "character"; asset_id: string } | { kind: "story"; story_id: string };
export type Action =
  | "create_character"
  | "update_character"
  | "initialize_story"
  | "save_first_chapter"
  | "create_chapter";
export interface Binding {
  operationId: string;
  authorizationId: string;
  target: Target;
  action: Action;
  baseRevision: string | null;
  selectedDraft?: Extract<ExactRef, { type: "candidate" }>;
  evidenceDigest: string;
}
export interface DraftContext {
  mode: "new_character" | "existing_character" | "new_story" | "existing_story";
  target?: Target;
  baseRevision: string | null;
  chapterId?: string;
  reference?: ExactRef;
  evidenceDigest?: string;
}
export interface ScopeV2 {
  protocol_version: 2;
  conversation_id: string;
  task_id: string;
  source_message_id: string;
  operation_id: string;
  phase: "resolve" | "execute";
  refs_digest: string;
  binding_digest?: string;
  authorization_id?: string;
  action?: Action;
  target?: Target;
}
export interface FreeBase {
  id: string;
  kind: string;
  revision: string;
  createdAt: string;
  conversationId?: string;
}
export interface FreeConversation extends FreeBase {
  kind: "conversation";
  protocolVersion: 2;
  sessionId?: string;
  sessionDispatchStarted?: boolean;
  initialRefs: ExactRef[];
  associatedAssets: Target[];
  epoch: number;
  activeTaskId?: string;
  configuration: Pick<FreeInput, "provider" | "model" | "thinkingLevel">;
}
export interface PhaseRun {
  key: string;
  sessionId: string;
  payload: Record<string, unknown>;
  dispatchStarted: boolean;
  runId?: string;
  status?: string;
  usage?: unknown;
  eventCursor?: number;
  eventsComplete?: boolean;
  executionUsage?: {
    model_calls: number;
    tool_calls: number;
    duration_ms: number;
  };
}
export interface FreeTask extends FreeBase {
  kind: "task";
  conversationId: string;
  epoch: number;
  sourceMessageId: string;
  operationId: string;
  input: FreeInput;
  inputDigest: string;
  state:
    | "unresolved"
    | "resolving"
    | "clarifying"
    | "binding"
    | "authorized"
    | "running"
    | "succeeded"
    | "failed"
    | "interrupted"
    | "cancel_pending"
    | "revoked"
    | "conflict"
    | "committed"
    | "verifying";
  storyAllowlist: string[];
  classifier?: unknown;
  classifierRunId?: string;
  resolutionEvidence?: ResolutionEvidence;
  binding?: Binding;
  draftContext?: DraftContext;
  intentSessionId?: string;
  intentSessionDispatchStarted?: boolean;
  intentRun?: PhaseRun;
  resolutionRun?: PhaseRun;
  executionRun?: PhaseRun;
  cancelRequestedAt?: string;
  stopPending?: boolean;
  eventCursor?: number;
  receipt?: ReceiptV2;
  output?: string;
  error?: string;
}
export interface ResolutionEvidence {
  originalMessageHash: string;
  classifierResult: unknown;
  classifierRunId: string;
  predicates: unknown[];
  queryDigest: string;
  candidateIds: string[];
  candidateRevisions: string[];
  complete: boolean;
  matchedId?: string;
  headRevision?: string;
  policyVersion: "target-v2";
  verifiedAt: string;
}
export interface SourceRecord extends FreeBase {
  kind: "source";
  conversationId: string;
  ref: ExactRef;
  origin: "initial" | "explicit" | "agent_read";
  task_id: string;
  invocation_id?: string;
  read_at: string;
}
export interface Directory extends FreeBase {
  kind: "directory";
  conversationId: string;
  operationId: string;
  taskId: string;
  target: Target;
  partition: string;
  authorizationId: string;
  bindingDigest: string;
  stateProjection: string;
}
export interface Ledger extends FreeBase {
  kind: "op";
  conversationId: string;
  bindingDigest: string;
  authorizationId: string;
  taskId: string;
  sourceMessageId: string;
  action: Action;
  target: Target;
  baseRevision: string | null;
  status: "active" | "revoked" | "conflict" | "committed";
  draftRef?: Extract<ExactRef, { type: "candidate" }>;
  payloadHash?: string;
  receipt?: ReceiptV2;
}
export interface ReceiptV2 {
  protocol_version: 2;
  operation_id: string;
  status: "committed";
  conversation_id: string;
  task_id: string;
  kind:
    | "character_created"
    | "character_updated"
    | "story_initialized"
    | "first_chapter_saved"
    | "chapter_created";
  target: Target;
  draft_id: string;
  draft_revision: "1";
  draft_hash: string;
  content_hash: string;
  revision: string;
  assets?: {
    asset_id: string;
    kind: string;
    revision: string;
    content_hash: string;
  }[];
  chapter?: { chapter_id: string; revision: string; content_hash: string };
}
export interface RequestRecord extends FreeBase {
  kind: "request";
  conversationId: string;
  taskId: string;
  inputDigest: string;
}
export interface DraftClaim extends FreeBase {
  kind: "claim";
  conversationId: string;
  draftId: string;
  operationId: string;
  payloadHash: string;
}
export interface FreeEvent extends FreeBase {
  kind: "event";
  conversationId: string;
  taskId: string;
  cursor: number;
  remoteCursor: number;
  phase: "resolve" | "execute";
  runId: string;
  event: Record<string, unknown>;
}
export type FreeRecord =
  | FreeConversation
  | FreeTask
  | SourceRecord
  | Directory
  | Ledger
  | RequestRecord
  | FreeEvent
  | DraftClaim
  | import("./free-candidates.js").Candidate
  | import("./free-candidates.js").CandidateGroup;
export interface CandidateAccess {
  read(
    conversationId: string,
    ref: Extract<ExactRef, { type: "candidate" }>,
  ): Promise<{ content: Content; draftContext: DraftContext; action: Action }>;
}
