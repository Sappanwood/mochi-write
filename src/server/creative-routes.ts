import { thinkingLevels } from "../shared/creative.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CreativeTask, CreativeTaskView } from "../shared/creative.js";
import type { Creative } from "./creative.js";
const draftRef = z
  .object({
    draft_id: z.uuid(),
    draft_revision: z.string().min(1).max(128),
    draft_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
const submit = z
  .object({
    conversationId: z.uuid(),
    clientRequestId: z.uuid(),
    message: z
      .string()
      .min(1)
      .max(16000)
      .refine((s) => s.trim().length > 0),
    provider: z.string().min(1).max(128),
    model: z.string().min(1).max(128),
    thinkingLevel: z.enum(thinkingLevels).optional(),
    selectedDraft: draftRef.optional(),
  })
  .strict();
const params = z.object({ storyId: z.uuid(), taskId: z.uuid().optional() });
const query = z.object({ conversationId: z.uuid() }).strict();
function taskView(task: CreativeTask): CreativeTaskView {
  const {
    id,
    storyId,
    conversationId,
    createdAt,
    updatedAt,
    message,
    provider,
    model,
    thinkingLevel,
    selectedDraft,
    status,
    output,
    error,
    sources,
    artifacts,
    receipt,
    usage,
    intentUsage,
    operationStatus,
    stopPending,
  } = task;
  return {
    id,
    storyId,
    conversationId,
    createdAt,
    updatedAt,
    message,
    provider,
    model,
    thinkingLevel,
    selectedDraft,
    status,
    output,
    error,
    sources,
    artifacts,
    receipt,
    usage,
    intentUsage,
    operationStatus,
    stopPending,
  };
}
export function registerCreative(app: FastifyInstance, creative: Creative) {
  app.get("/api/creative/conversations", async () => ({
    items: await creative.lifecycleConversations(),
  }));
  app.post("/api/creative/conversations", async (r) => {
    const input = submit
      .omit({ conversationId: true, selectedDraft: true })
      .parse(r.body);
    const result = await creative.startConversation(input);
    return { conversation: result.conversation, task: taskView(result.task) };
  });
  app.get("/api/creative/conversations/:conversationId", async (r) =>
    creative.lifecycleConversation(
      z.object({ conversationId: z.uuid() }).parse(r.params).conversationId,
    ),
  );
  app.get(
    "/api/creative/conversations/by-request/:clientRequestId",
    async (r) => {
      const { clientRequestId } = z
        .object({ clientRequestId: z.uuid() })
        .parse(r.params);
      const result = await creative.lifecycle.byRequest(clientRequestId);
      return { conversation: result.conversation, task: taskView(result.task) };
    },
  );
  const base = "/api/stories/:storyId/creative";
  app.get(base + "/conversations", async (r) => ({
    items: await creative.conversations(params.parse(r.params).storyId),
  }));
  app.post(base + "/conversations", async (r) => {
    z.object({}).strict().parse(r.body);
    return creative.createConversation(params.parse(r.params).storyId);
  });
  app.get(base + "/tasks", async (r) => ({
    items: (
      await creative.tasks(
        params.parse(r.params).storyId,
        query.parse(r.query).conversationId,
      )
    ).map(taskView),
  }));
  app.post(base + "/tasks", async (r) =>
    taskView(
      await creative.submit(
        params.parse(r.params).storyId,
        submit.parse(r.body),
      ),
    ),
  );
  app.get(base + "/tasks/:taskId", async (r) => {
    const p = params.parse(r.params);
    return taskView(await creative.task(p.storyId, p.taskId!));
  });
  app.post(base + "/tasks/:taskId/cancel", async (r) => {
    z.object({}).strict().parse(r.body);
    const p = params.parse(r.params);
    return taskView(await creative.cancel(p.storyId, p.taskId!));
  });
  app.get(base + "/tasks/:taskId/events", async (r) => {
    const p = params.parse(r.params);
    const q = z
      .object({ after: z.coerce.number().int().min(0).default(0) })
      .strict()
      .parse(r.query);
    return creative.events(p.storyId, p.taskId!, q.after);
  });
  app.post(base + "/tasks/:taskId/verify", async (r) => {
    z.object({}).strict().parse(r.body);
    const p = params.parse(r.params);
    return taskView(await creative.verifyOperation(p.storyId, p.taskId!));
  });
  app.get(base + "/drafts/:draftId", async (r) => {
    const p = z
      .object({ storyId: z.uuid(), draftId: z.uuid() })
      .parse(r.params);
    return creative.draft(p.storyId, p.draftId);
  });
  app.get(base + "/drafts", async (r) => ({
    items: await creative.drafts(
      params.parse(r.params).storyId,
      query.parse(r.query).conversationId,
    ),
  }));
}
