import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  freeInputSchema,
  exactRefSchema,
  type Binding,
  type CandidateAccess,
  type ExactRef,
  type FreeConversation,
  type FreeTask,
  type RequestRecord,
} from "../shared/free.js";
import { AppError } from "../shared/model.js";
import type { Store } from "./store.js";
import type { FreeStore, FreeWrite } from "./free-store.js";
import type { Mochi } from "./mochi-client.js";
import { FreeReferences, freeDigest } from "./free-references.js";
import { FreeOperations } from "./free-operations.js";
import { resolveTarget } from "./free-resolver.js";
import { freeEvents } from "./free-events.js";
import { FreeWorkflow } from "./free-workflow.js";
import { FreeCandidates } from "./free-candidates.js";
import { isSaveIntent } from "./free-conversation.js";
export class FreeSession {
  readonly candidates: FreeCandidates;
  readonly references: FreeReferences;
  readonly operations: FreeOperations;
  readonly workflow: FreeWorkflow;
  constructor(
    readonly content: Store,
    readonly records: FreeStore,
    readonly mochi: Mochi,
    readonly options: {
      autoStart?: boolean;
      pollMs?: number;
      candidates?: CandidateAccess;
    } = {},
  ) {
    this.candidates = new FreeCandidates(this);
    this.references = new FreeReferences(
      content,
      records,
      options.candidates ?? this.candidates,
    );
    this.operations = new FreeOperations(records);
    this.workflow = new FreeWorkflow(this, options.pollMs ?? 500);
  }
  async conversation(id: string) {
    const c = await this.records.get<FreeConversation>(
      "library",
      "conversation",
      id,
    );
    if (!c) throw new AppError(404, "conversation_not_found");
    return c;
  }
  async task(id: string) {
    const t = await this.records.get<FreeTask>("library", "task", id);
    if (!t) throw new AppError(404, "task_not_found");
    return t;
  }
  async byRequest(id: string) {
    const r = await this.records.get<RequestRecord>("library", "request", id);
    if (!r) throw new AppError(404, "request_not_found");
    return {
      conversation: await this.conversation(r.conversationId),
      task: await this.task(r.taskId),
    };
  }
  async start(raw: unknown) {
    const parsed = z
      .object({
        ...freeInputSchema.shape,
        initialRefs: z.array(exactRefSchema).max(8).default([]),
      })
      .strict()
      .parse(raw);
    if (Buffer.byteLength(JSON.stringify(parsed)) > 32768)
      throw new AppError(400, "result_too_large");
    const { initialRefs, ...input } = parsed;
    const digest = freeDigest(parsed);
    const old = await this.records.get<RequestRecord>(
      "library",
      "request",
      input.clientRequestId,
    );
    if (old) {
      if (old.inputDigest !== digest)
        throw new AppError(409, "operation_conflict");
      return this.byRequest(input.clientRequestId);
    }
    const id = randomUUID(),
      now = new Date().toISOString();
    await this.references.validate(id, [...initialRefs, ...input.refs]);
    const configuration = {
      provider: input.provider,
      model: input.model,
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
    };
    const conversation: FreeConversation = {
      kind: "conversation",
      id,
      protocolVersion: 2,
      toolsetVersion: "materials-v1",
      revision: "",
      createdAt: now,
      epoch: 1,
      initialRefs,
      associatedAssets: initialRefs
        .filter(
          (r) =>
            r.type === "asset" &&
            ["character", "world", "story"].includes(r.kind),
        )
        .map((r) =>
          r.type === "asset" && (r.kind === "character" || r.kind === "world")
            ? { kind: r.kind, asset_id: r.asset_id }
            : {
                kind: "story",
                story_id: r.type === "asset" ? r.story_id! : "",
              },
        ),
      configuration,
    };
    const task = this.makeTask(conversation, input, digest);
    conversation.activeTaskId = task.id;
    try {
      await this.records.transaction("library", [
        { record: conversation, revision: null },
        ...this.inputWrites(task, digest, initialRefs),
      ]);
    } catch (e) {
      const prior = await this.records.get<RequestRecord>(
        "library",
        "request",
        input.clientRequestId,
      );
      if (!prior || prior.inputDigest !== digest) throw e;
      return this.byRequest(input.clientRequestId);
    }
    if (this.options.autoStart !== false) this.workflow.start(task.id);
    return this.byRequest(input.clientRequestId);
  }
  private makeTask(
    c: FreeConversation,
    input: z.infer<typeof freeInputSchema>,
    digest: string,
  ): FreeTask {
    const storyAllowlist = [
      ...new Set(
        [...c.initialRefs, ...input.refs].flatMap((r) =>
          r.type === "asset" && r.story_id ? [r.story_id] : [],
        ),
      ),
    ];
    if (storyAllowlist.length > 8) throw new AppError(400, "result_too_large");
    return {
      kind: "task",
      id: input.clientRequestId,
      conversationId: c.id,
      revision: "",
      createdAt: new Date().toISOString(),
      epoch: c.epoch,
      sourceMessageId: randomUUID(),
      operationId: randomUUID(),
      input,
      inputDigest: digest,
      state: "unresolved",
      storyAllowlist,
    };
  }
  private inputWrites(
    task: FreeTask,
    digest: string,
    initialRefs: ExactRef[] = [],
  ): FreeWrite[] {
    return [
      { record: task, revision: null },
      {
        record: {
          id: task.input.clientRequestId,
          kind: "request",
          createdAt: task.createdAt,
          revision: "",
          conversationId: task.conversationId,
          taskId: task.id,
          inputDigest: digest,
        },
        revision: null,
      },
      ...[
        ...initialRefs.map((ref) => ({ ref, origin: "initial" as const })),
        ...task.input.refs.map((ref) => ({ ref, origin: "explicit" as const })),
      ].flatMap(({ ref, origin }) => [
        {
          record: this.references.source(
            task.conversationId,
            task.id,
            ref,
            origin,
          ),
          revision: null,
        },
      ]),
    ];
  }
  async submit(conversationId: string, raw: unknown) {
    const input = freeInputSchema.parse(raw);
    if (Buffer.byteLength(JSON.stringify(input)) > 32768)
      throw new AppError(400, "result_too_large");
    const digest = freeDigest({ conversationId, input });
    const old = await this.records.get<RequestRecord>(
      "library",
      "request",
      input.clientRequestId,
    );
    if (old) {
      if (old.inputDigest !== digest || old.conversationId !== conversationId)
        throw new AppError(409, "operation_conflict");
      return this.task(old.taskId);
    }
    await this.references.validate(conversationId, input.refs);
    let c = await this.conversation(conversationId);
    if (c.activeTaskId) {
      await this.cancel(c.activeTaskId);
      const prior = await this.task(c.activeTaskId);
      if (prior.stopPending || prior.state === "cancel_pending")
        throw new AppError(409, "previous_operation_pending");
      c = await this.conversation(conversationId);
    }
    c.epoch++;
    const task = this.makeTask(c, input, digest);
    c.activeTaskId = task.id;
    await this.records.transaction("library", [
      { record: c, revision: c.revision },
      ...this.inputWrites(task, digest),
    ]);
    if (this.options.autoStart !== false) this.workflow.start(task.id);
    return this.task(task.id);
  }
  async change(id: string, fn: (task: FreeTask) => void) {
    const task = await this.task(id);
    fn(task);
    await this.records.transaction("library", [
      { record: task, revision: task.revision },
    ]);
    return this.task(id);
  }
  async changeActive(
    id: string,
    fn: (task: FreeTask, conversation: FreeConversation) => void,
  ) {
    const task = await this.task(id);
    const conversation = await this.guard(task);
    if (
      !["unresolved", "resolving", "binding", "authorized", "running"].includes(
        task.state,
      )
    )
      throw new AppError(409, "task_closed");
    fn(task, conversation);
    await this.records.transaction("library", [
      { record: task, revision: task.revision },
      { record: conversation, revision: conversation.revision },
    ]);
    return this.task(id);
  }
  async guard(task: FreeTask) {
    const c = await this.conversation(task.conversationId);
    if (
      c.activeTaskId !== task.id ||
      c.epoch !== task.epoch ||
      task.cancelRequestedAt
    )
      throw new AppError(409, "authorization_revoked");
    return c;
  }
  async resolve(id: string, raw: unknown, classifierRunId: string) {
    const task = await this.task(id);
    const c = await this.guard(task);
    if (task.binding) return task;
    if (!["unresolved", "resolving"].includes(task.state))
      throw new AppError(409, "resolution_closed");
    const result = await resolveTarget(
      this.content,
      this.references,
      c,
      task,
      raw,
      classifierRunId,
    );
    const current = await this.task(id),
      gate = await this.guard(current);
    if (current.revision !== task.revision)
      throw new AppError(409, "resolution_changed");
    current.classifier = raw;
    current.classifierRunId = classifierRunId;
    current.resolutionEvidence = result.evidence;
    if (result.clarify && isSaveIntent(raw)) {
      current.state = "clarifying";
      current.error = result.clarify;
    } else {
      current.conversationNote = result.clarify;
      current.draftContext = result.draftContext
        ? {
            ...result.draftContext,
            evidenceDigest: freeDigest(result.evidence),
          }
        : undefined;
      current.state = "authorized";
      if (result.target && result.action) {
        const binding: Binding = {
          operationId: task.operationId,
          authorizationId: randomUUID(),
          target: result.target,
          action: result.action,
          baseRevision: result.baseRevision ?? null,
          ...(result.draftContext?.materials
            ? { materials: result.draftContext.materials }
            : {}),
          evidenceDigest: freeDigest(result.evidence),
          ...(task.input.refs.filter((r) => r.type === "candidate").length ===
            1 && (raw as { intent?: string })?.intent === "save_current"
            ? {
                selectedDraft: task.input.refs.find(
                  (r) => r.type === "candidate",
                )!,
              }
            : {}),
        };
        current.binding = binding;
        current.state = "binding";
        if (
          binding.target.kind === "story" &&
          !current.storyAllowlist.includes(binding.target.story_id)
        ) {
          if (current.storyAllowlist.length >= 8)
            throw new AppError(400, "result_too_large");
          current.storyAllowlist.push(binding.target.story_id);
        }
      }
    }
    if (
      current.draftContext?.target?.kind === "story" &&
      !current.storyAllowlist.includes(current.draftContext.target.story_id)
    ) {
      if (current.storyAllowlist.length >= 8)
        throw new AppError(400, "result_too_large");
      current.storyAllowlist.push(current.draftContext.target.story_id);
    }
    const writes: FreeWrite[] = [
      { record: current, revision: current.revision },
      { record: gate, revision: gate.revision },
    ];
    if (current.binding)
      writes.push({
        record: this.operations.makeDirectory(current, current.binding),
        revision: null,
      });
    await this.records.transaction("library", writes);
    if (current.binding) {
      await this.operations.activate(current);
      await this.change(id, (t) => {
        if (!t.cancelRequestedAt && t.state === "binding")
          t.state = "authorized";
      });
    }
    return this.task(id);
  }
  async cancel(id: string) {
    let task = await this.task(id);
    const c = await this.conversation(task.conversationId);
    if (!task.cancelRequestedAt) {
      task.cancelRequestedAt = new Date().toISOString();
      task.stopPending = true;
      task.state = task.binding ? "cancel_pending" : "revoked";
      if (c.activeTaskId === task.id) c.epoch++;
      await this.records.transaction("library", [
        { record: task, revision: task.revision },
        { record: c, revision: c.revision },
      ]);
      task = await this.task(id);
    }
    try {
      if (task.binding) {
        await this.operations.revoke(task);
        await this.operations.reconcile(id);
      }
    } catch {
      return this.task(id);
    }
    const stopped = await this.workflow.stop(task);
    await this.change(id, (t) => {
      t.stopPending = !stopped;
    });
    return this.task(id);
  }
  events(id: string, after: number) {
    return freeEvents(this, id, after);
  }
  operation(id: string) {
    return this.operations.query(id);
  }
  async verify(id: string) {
    await this.workflow.refresh(id);
    await this.operations.reconcile(id);
    const task = await this.task(id);
    if (task.stopPending) return this.cancel(id);
    return task;
  }
  async recover() {
    for (const task of await this.records.list<FreeTask>("task")) {
      if (task.cancelRequestedAt || task.stopPending) {
        await this.cancel(task.id);
        continue;
      }
      if (task.binding) {
        await this.operations.reconcile(task.id);
        const current = await this.task(task.id);
        if (current.state === "binding") {
          await this.operations.activate(current);
          await this.change(task.id, (t) => {
            t.state = "authorized";
          });
        }
      }
      if (this.options.autoStart !== false) this.workflow.start(task.id);
    }
  }
  close() {
    return this.workflow.close();
  }
}
