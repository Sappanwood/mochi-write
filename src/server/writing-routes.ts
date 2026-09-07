import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { scopeSchema, submitSchema } from "../shared/writing.js";
import { Writing, partition } from "./writing.js";
const query = z
  .object({
    type: z.enum(["story", "library"]),
    id: z.string(),
    conversationId: z.uuid().optional(),
    after: z.coerce.number().int().min(0).default(0),
  })
  .strict();
export function registerWriting(app: FastifyInstance, writing: Writing) {
  function scope(raw: unknown) {
    const q = query.parse(raw);
    return scopeSchema.parse({ type: q.type, id: q.id });
  }
  function id(raw: unknown) {
    return z.object({ draftId: z.uuid() }).parse(raw).draftId;
  }
  app.get("/api/writing/models", () => writing.mochi.request("/v1/models"));
  app.get("/api/writing/conversations", async (r) => ({
    items: await writing.conversations(scope(r.query)),
  }));
  app.post("/api/writing/conversations", async (r) =>
    writing.createConversation(scopeSchema.parse(r.body)),
  );
  app.get("/api/writing/history", async (r) => {
    const q = query.parse(r.query);
    const c = await writing.conversation(
      scope(r.query),
      z.uuid().parse(q.conversationId),
    );
    return writing.mochi.request(`/v1/sessions/${c.sessionId}/history`);
  });
  app.post("/api/writing/context", async (r) =>
    writing.resolve(submitSchema.parse(r.body)),
  );
  app.post("/api/writing/submit", async (r) =>
    writing.submit(submitSchema.parse(r.body)),
  );
  app.get("/api/writing/drafts", async (r) => {
    const q = query.parse(r.query),
      s = scope(r.query);
    const c = await writing.conversation(s, z.uuid().parse(q.conversationId));
    return { items: await writing.records.drafts(partition(s), c.id) };
  });
  app.get("/api/writing/drafts/:draftId", async (r) =>
    writing.resume(scope(r.query), id(r.params)),
  );
  app.post("/api/writing/drafts/:draftId/cancel", async (r) => {
    z.object({}).strict().parse(r.body);
    return writing.cancel(scope(r.query), id(r.params));
  });
  app.post("/api/writing/drafts/:draftId/accept", async (r) => {
    z.object({}).strict().parse(r.body);
    return writing.accept(scope(r.query), id(r.params));
  });
  app.get("/api/writing/drafts/:draftId/events", async (r) => {
    const d = await writing.requireDraft(scope(r.query), id(r.params));
    if (!d.runId)
      return { events: [], next_cursor: query.parse(r.query).after };
    return writing.mochi.request(
      `/v1/runs/${d.runId}/events?after=${query.parse(r.query).after}`,
    );
  });
}
