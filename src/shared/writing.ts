import { z } from "zod";
export const scopeSchema = z
  .object({ type: z.enum(["story", "library"]), id: z.string().min(1) })
  .strict()
  .refine((s) =>
    s.type === "library"
      ? s.id === "library"
      : z.uuid().safeParse(s.id).success,
  );
export const refSchema = z
  .object({ id: z.uuid(), revision: z.string().min(1) })
  .strict();
export const contextSchema = z
  .object({
    schemaVersion: z.literal(1),
    scope: scopeSchema,
    location: z
      .object({ type: z.string(), id: z.uuid(), revision: z.string() })
      .strict()
      .nullable(),
    selection: z
      .object({ text: z.string().max(8000) })
      .strict()
      .nullable(),
  })
  .strict();
export const submitSchema = z
  .object({
    conversationId: z.uuid(),
    clientRequestId: z.uuid(),
    message: z.string().trim().min(1).max(16000),
    provider: z.string().min(1),
    model: z.string().min(1),
    pageContext: contextSchema,
    attachedRefs: z.array(refSchema).max(20),
    target: z
      .object({
        id: z.uuid().nullable(),
        revision: z.string().nullable(),
        name: z.string().trim().min(1).max(200),
        order: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    feedbackDraftId: z.uuid().optional(),
  })
  .strict();
export type Scope = z.infer<typeof scopeSchema>;
export type PageContext = z.infer<typeof contextSchema>;
export type Submit = z.infer<typeof submitSchema>;
export interface Run {
  run_id: string;
  session_id: string;
  status:
    "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  result: { text: string } | null;
  error: string | null;
  usage?: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    total_tokens: number;
  } | null;
}
export interface Conversation {
  id: string;
  projectId: string | null;
  sessionId: string;
  createdAt: string;
}
export interface DraftRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  projectId: string | null;
  conversationId: string;
  request: Submit;
  digest: string;
  prompt: string;
  maxOutputTokens: number;
  targetId: string | null;
  runId: string | null;
  status:
    | "pending"
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "interrupted"
    | "accepted";
  output: string;
  usage?: Run["usage"];
  resultVersion?: number;
  revision: string;
}
