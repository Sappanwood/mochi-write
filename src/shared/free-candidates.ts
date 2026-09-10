import type { Action, DraftContext, ExactRef, FreeBase } from "./free.js";
import type { Content } from "./model.js";
export type CandidateRef = Extract<ExactRef, { type: "candidate" }>;
export type ArtifactKind = "character" | "story_initialization" | "chapter";
export interface CandidateGroup extends FreeBase {
  kind: "group";
  conversationId: string;
  artifactKind: ArtifactKind;
  createdByTaskId: string;
  nextOrdinal: number;
  derivedFrom?: ExactRef;
}
export interface CandidateMember {
  member_id: string;
  kind: string;
  content: Content;
  sourceRef?: ExactRef;
}
export interface CandidatePayload {
  content: Content;
  draftContext: DraftContext;
  action: Action;
  parentRef?: CandidateRef;
  derivedFrom?: ExactRef;
  members?: CandidateMember[];
  business?: Record<string, unknown>;
}
export interface Candidate extends FreeBase {
  kind: "candidate";
  conversationId: string;
  groupId: string;
  ordinal: number;
  createdByTaskId: string;
  artifactKind: ArtifactKind;
  title: string;
  payload: CandidatePayload;
  draftRevision: "1";
  draftHash: string;
  inputDigest: string;
}
