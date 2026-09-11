import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { FreeSession } from "./free-session.js";
import type { DraftClaim, FreeConversation, FreeTask } from "../shared/free.js";
import { exactRefSchema } from "../shared/free.js";
import { AppError } from "../shared/model.js";
import { freeDigest } from "./free-references.js";
import { discoverReferences, resolveReference } from "./free-discovery.js";
const uuid = z.uuid();
const paging = z
  .object({
    cursor: z.string().max(4096).optional(),
    limit: z.coerce.number().int().min(1).max(20).default(20),
  })
  .strict();
function page<T>(items: T[], query: unknown, binding: string) {
  const { cursor, limit } = paging.parse(query);
  let offset = 0;
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
      if (
        decoded.binding !== binding ||
        !Number.isSafeInteger(decoded.offset) ||
        decoded.offset < 0 ||
        decoded.offset > items.length
      )
        throw Error();
      offset = decoded.offset;
    } catch {
      throw new AppError(400, "invalid_cursor");
    }
  }
  return {
    items: items.slice(offset, offset + limit),
    nextCursor:
      offset + limit < items.length
        ? Buffer.from(
            JSON.stringify({ binding, offset: offset + limit }),
          ).toString("base64url")
        : null,
  };
}
export function freeTaskDto(task: FreeTask) {
  return {
    id: task.id,
    conversationId: task.conversationId,
    createdAt: task.createdAt,
    state: task.state,
    input: task.input,
    sourceMessageId: task.sourceMessageId,
    operationId: task.operationId,
    refs: task.input.refs,
    target: task.binding?.target,
    action: task.binding?.action,
    draftContext: task.draftContext,
    stopPending: task.stopPending ?? false,
    receipt: task.receipt,
    output: task.output,
    error: task.error,
    resolutionEvidence: task.resolutionEvidence,
    ...Object.fromEntries(
      (["intentRun", "resolutionRun", "executionRun"] as const).map((k) => [
        k,
        task[k]
          ? {
              runId: task[k].runId,
              status: task[k].status,
              usage: task[k].usage,
            }
          : undefined,
      ]),
    ),
  };
}
export function registerFree(app: FastifyInstance, free: FreeSession) {
  const root = "/api/creative/free",
    base = root + "/conversations/:conversationId";
  const conversationId = (params: unknown) =>
    uuid.parse((params as { conversationId: string }).conversationId);
  async function scopedTask(params: unknown) {
    const p = params as { conversationId: string; taskId: string };
    const task = await free.task(uuid.parse(p.taskId));
    if (task.conversationId !== conversationId(p))
      throw new AppError(403, "forbidden_scope");
    return task;
  }
  app.get(`${root}/discover`, async (request) =>
    discoverReferences(free, null, request.query),
  );
  app.post(`${root}/references/resolve`, { bodyLimit: 4096 }, async (request) =>
    resolveReference(free, null, request.body),
  );
  app.post(`${root}/conversations`, { bodyLimit: 32768 }, async (request) => {
    const r = await free.start(request.body);
    return { ...r, task: freeTaskDto(r.task) };
  });
  app.get(`${root}/conversations`, async (request) =>
    page(
      await free.records.list<FreeConversation>("conversation"),
      request.query,
      "free-conversations",
    ),
  );
  app.get(
    `${root}/conversations/by-request/:clientRequestId`,
    async (request) => {
      const id = uuid.parse(
        (request.params as { clientRequestId: string }).clientRequestId,
      );
      const r = await free.byRequest(id);
      return { ...r, task: freeTaskDto(r.task) };
    },
  );
  app.get(base, async (request) => {
    const c = await free.conversation(conversationId(request.params));
    const associations = page(
      c.associatedAssets,
      request.query,
      "associations:" + c.id,
    );
    return {
      conversation: { ...c, associatedAssets: associations.items },
      activeTask: c.activeTaskId
        ? freeTaskDto(await free.task(c.activeTaskId))
        : undefined,
      associations: associations.items,
      nextCursor: associations.nextCursor,
    };
  });
  app.get(`${base}/tasks`, async (request) => {
    const id = conversationId(request.params);
    await free.conversation(id);
    return page(
      (await free.records.list<FreeTask>("task", id)).map(freeTaskDto),
      request.query,
      "tasks:" + id,
    );
  });
  app.post(`${base}/tasks`, { bodyLimit: 32768 }, async (request) => ({
    task: freeTaskDto(
      await free.submit(conversationId(request.params), request.body),
    ),
  }));
  app.get(`${base}/tasks/:taskId`, async (request) => {
    const task = await scopedTask(request.params);
    const sources = page(
      (await free.references.sources(task.conversationId)).filter(
        (s) => s.task_id === task.id,
      ),
      request.query,
      "sources:" + task.id,
    );
    return {
      task: freeTaskDto(task),
      receipts: task.receipt ? [task.receipt] : [],
      candidates: (await free.candidates.drafts(task.conversationId))
        .filter((d) => d.createdByTaskId === task.id)
        .map((d) => free.candidates.summary(d)),
      sources: sources.items,
      nextCursor: sources.nextCursor,
    };
  });
  for (const action of ["cancel", "verify"] as const)
    app.post(`${base}/tasks/:taskId/${action}`, async (request, reply) => {
      z.object({}).strict().parse(request.body);
      const original = await scopedTask(request.params);
      const task = await free[action](original.id);
      const state =
        task.stopPending || task.state === "cancel_pending"
          ? "cancel_pending"
          : task.state;
      if (state === "cancel_pending") reply.code(202);
      return { state, receipt: task.receipt };
    });
  app.get(`${base}/tasks/:taskId/events`, async (request) => {
    const task = await scopedTask(request.params);
    const { after } = z
      .object({ after: z.coerce.number().int().nonnegative().default(0) })
      .strict()
      .parse(request.query);
    return free.events(task.id, after);
  });
  app.get(`${base}/discover`, async (request) =>
    discoverReferences(free, conversationId(request.params), request.query),
  );
  app.post(`${base}/references/resolve`, { bodyLimit: 4096 }, async (request) =>
    resolveReference(free, conversationId(request.params), request.body),
  );
  app.get(`${base}/groups`, async (request) => {
    const id = conversationId(request.params);
    return page(
      await free.candidates.groups(id),
      request.query,
      "groups:" + id,
    );
  });
  app.get(`${base}/groups/:groupId/drafts`, async (request) => {
    const id = conversationId(request.params),
      groupId = uuid.parse((request.params as { groupId: string }).groupId);
    return page(
      (await free.candidates.drafts(id, groupId)).map((d) =>
        free.candidates.summary(d),
      ),
      request.query,
      "drafts:" + id + ":" + groupId,
    );
  });
  app.get(`${base}/drafts/:draftId`, async (request) => {
    const id = conversationId(request.params);
    await free.conversation(id);
    const draft = await free.candidates.get(
      id,
      uuid.parse((request.params as { draftId: string }).draftId),
    );
    const claim = await free.records.get<DraftClaim>(
      "library",
      "claim",
      draft.id,
    );
    const operation = claim
      ? await free.operation(claim.operationId)
      : undefined;
    if (
      claim &&
      (claim.conversationId !== id ||
        claim.draftId !== draft.id ||
        claim.payloadHash !==
          freeDigest({
            draftRef: free.candidates.ref(draft),
            ...(draft.artifactKind === "story_materials"
              ? { materials: draft.payload.business?.materials }
              : draft.artifactKind === "story_initialization"
                ? { initialization: draft.payload.business?.initialization }
                : {
                    content: draft.payload.content,
                    ...(draft.artifactKind === "chapter"
                      ? { chapterId: draft.payload.business?.chapterId }
                      : {}),
                  }),
          }) ||
        (operation?.receipt &&
          (operation.receipt.draft_id !== draft.id ||
            operation.receipt.draft_revision !== draft.draftRevision ||
            operation.receipt.draft_hash !== draft.draftHash)))
    )
      throw new AppError(409, "invalid_operation_receipt");
    return {
      draft,
      ...(claim
        ? {
            claim: {
              operationId: claim.operationId,
              status: operation!.status,
            },
          }
        : {}),
      ...(operation?.receipt ? { receipt: operation.receipt } : {}),
    };
  });
  app.get(`${base}/references`, async (request) => {
    const id = conversationId(request.params);
    const c = await free.conversation(id);
    const { ref: encoded } = z
      .object({
        ref: z
          .string()
          .min(1)
          .refine((s) => Buffer.byteLength(s) <= 4096),
      })
      .strict()
      .parse(request.query);
    let raw: unknown;
    try {
      raw = JSON.parse(encoded);
    } catch {
      throw new AppError(400, "invalid_reference");
    }
    const ref = exactRefSchema.parse(raw);
    const known = [
      ...c.initialRefs,
      ...(await free.references.sources(id)).map((s) => s.ref),
      ...(await free.records.list<FreeTask>("task", id)).flatMap(
        (t) => t.input.refs,
      ),
    ];
    if (
      ref.type !== "candidate" &&
      !known.some((r) => freeDigest(r) === freeDigest(ref))
    )
      throw new AppError(403, "forbidden_scope");
    try {
      return {
        ref,
        ...(await free.references.read(id, ref)),
        ...(ref.type === "asset"
          ? await (async () => {
              const head = await free.content.get(
                ref.asset_id,
                ref.story_id ?? null,
              );
              return head
                ? {
                    currentVersion: head.currentVersion,
                    currentDeleted: head.deleted,
                  }
                : {};
            })()
          : {}),
        availability: "exact",
      };
    } catch (e) {
      if (e instanceof AppError && [404, 409].includes(e.statusCode))
        return { ref, availability: "unavailable" };
      throw e;
    }
  });
}
