import type { Entity } from "./model.js";
import type { AssetSource } from "./creative-tools.js";

export const thinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];
export interface CreativeConfiguration {
  provider: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
}
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
export interface InitializationWrite {
  entity: Entity;
  baseRevision: string | null;
  source?: AssetSource;
}
export interface InitializationPackage {
  story: InitializationWrite;
  assets: InitializationWrite[];
  chapter?: InitializationWrite;
}
export type InitializationReceipt = {
  operation_id: string;
  status: "committed";
  story_id: string;
  revision: string;
  content_hash: string;
  draft_id: string;
  draft_revision: string;
  draft_hash: string;
  assets: {
    asset_id: string;
    kind: "setting" | "outline" | "snapshot";
    revision: string;
    content_hash: string;
  }[];
} & (
  | { kind: "story_initialized"; chapter?: never }
  | {
      kind: "first_chapter_saved";
      chapter: { chapter_id: string; revision: string; content_hash: string };
    }
);
export type CreativeReceipt = ChapterReceipt | InitializationReceipt;
export type DraftArtifact = DraftRef & {
  artifact_kind?: "story_initialization";
  includes_chapter?: boolean;
};
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
  configuration?: CreativeConfiguration;
  activeTaskId: string | null;
  lifecycle?: true;
  initialInput?: {
    clientRequestId: string;
    message: string;
    provider: string;
    model: string;
    thinkingLevel?: ThinkingLevel;
  };
  sessionDispatchStarted?: boolean;
  librarySources?: AssetSource[];
}
export type CreativeIntent =
  | "discuss"
  | "draft"
  | "save_current"
  | "create_and_save"
  | "initialize_only"
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
  thinkingLevel?: ThinkingLevel;
  operationId: string;
  chapterId: string;
  selectedDraft?: DraftRef;
  authorization?: {
    id: string;
    status: "active" | "paused" | "revoked" | "consumed";
    action: "create_chapter" | "initialize_story";
    includesChapter?: boolean;
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
  creativePrompt?: string;
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
  artifacts: DraftArtifact[];
  draftInvocations: Record<string, string>;
  receipt?: CreativeReceipt;
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
  artifactKind?: "story_initialization";
  initialization?: InitializationPackage;
  inputDigest?: string;
  draftRevision: "1";
  hash: string;
  receipt?: CreativeReceipt;
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
  | "thinkingLevel"
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
