import type { AssetSource } from "./creative-tools.js";

export interface DraftRef {
  draft_id: string;
  draft_revision: string;
  draft_hash: string;
}
export interface ChapterReceipt {
  operation_id: string;
  status: "committed";
  story_id: string;
  chapter_id: string;
  revision: string;
  content_hash: string;
}
interface RecordBase {
  id: string;
  storyId: string;
  createdAt: string;
  updatedAt: string;
  revision: string;
}
export interface CreativeConversation extends RecordBase {
  kind: "conversation";
  sessionId: string;
  activeTaskId: string | null;
  lifecycle?: true;
  initialInput?: {
    clientRequestId: string;
    message: string;
    provider: string;
    model: string;
  };
  sessionDispatchStarted?: boolean;
  librarySources?: AssetSource[];
}
export type CreativeIntent =
  | "discuss"
  | "draft"
  | "save_current"
  | "create_and_save"
  | "revoke"
  | "unclear";
export interface CreativeTask extends RecordBase {
  kind: "task";
  conversationId: string;
  message: string;
  digest: string;
  sourceMessageId: string;
  sourceHash: string;
  provider: string;
  model: string;
  operationId: string;
  chapterId: string;
  selectedDraft?: DraftRef;
  authorization?: {
    id: string;
    status: "active" | "paused" | "revoked" | "consumed";
    action: "create_chapter";
    maxCreates: 1;
    draftRef?: DraftRef;
  };
  intent?: CreativeIntent;
  intentEvidence?: { start: number; end: number; text: string };
  intentSessionId: string | null;
  intentRunId: string | null;
  inputValidated?: boolean;
  intentDispatchStarted?: boolean;
  creativeDispatchStarted?: boolean;
  stopPending?: boolean;
  operationStatus?: "unknown" | "committed" | "rejected";
  intentUsage?: CreativeTask["usage"];
  runId: string | null;
  status:
    | "interpreting"
    | "pending"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "interrupted"
    | "unclear";
  output: string;
  error?: string;
  sources: AssetSource[];
  artifacts: DraftRef[];
  draftInvocations: Record<string, string>;
  receipt?: ChapterReceipt;
  commitDigest?: string;
  usage?: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    total_tokens: number;
  } | null;
}
export interface CreativeDraft extends RecordBase {
  kind: "draft";
  conversationId: string;
  taskId: string;
  title: string;
  body: string;
  draftRevision: "1";
  hash: string;
  receipt?: ChapterReceipt;
}
export type CreativeRecord =
  CreativeConversation | CreativeTask | CreativeDraft;

export type CreativeTaskView = Pick<
  CreativeTask,
  | "id"
  | "storyId"
  | "conversationId"
  | "createdAt"
  | "updatedAt"
  | "message"
  | "provider"
  | "model"
  | "selectedDraft"
  | "status"
  | "output"
  | "error"
  | "sources"
  | "artifacts"
  | "receipt"
  | "usage"
  | "intentUsage"
  | "operationStatus"
  | "stopPending"
>;
