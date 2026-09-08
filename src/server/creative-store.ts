import type {
  CreativeConversation,
  CreativeDraft,
  CreativeRecord,
  CreativeTask,
  InitializationPackage,
} from "../shared/creative.js";
import type { Entity } from "../shared/model.js";
import { AppError } from "../shared/model.js";
import {
  BulkOperationType,
  type Database,
  type OperationInput,
} from "@azure/cosmos";
import { appendInitialization } from "./initialization-operations.js";
import { clean } from "./entities.js";

export interface CreativeWrite {
  record: CreativeRecord;
  revision: string | null;
}
export interface CreativeStore {
  reserve(id: string, digest: string, storyId: string): Promise<void>;
  conversation(
    storyId: string,
    id: string,
  ): Promise<CreativeConversation | undefined>;
  conversations(storyId?: string): Promise<CreativeConversation[]>;
  task(storyId: string, id: string): Promise<CreativeTask | undefined>;
  tasks(storyId: string, conversationId: string): Promise<CreativeTask[]>;
  activeTasks(): Promise<CreativeTask[]>;
  draft(storyId: string, id: string): Promise<CreativeDraft | undefined>;
  drafts(storyId: string, conversationId: string): Promise<CreativeDraft[]>;
  transaction(
    storyId: string,
    writes: CreativeWrite[],
    chapter?: Entity | InitializationPackage,
  ): Promise<CreativeRecord[]>;
}

export function creativeRecordId(kind: CreativeRecord["kind"], id: string) {
  return `creative:${kind}:${id}`;
}
function storageError(error: unknown): never {
  if (error instanceof AppError) throw error;
  const code = Number((error as { code?: number } | null)?.code);
  throw new AppError(
    [409, 412].includes(code) ? 409 : 503,
    [409, 412].includes(code) ? "创作记录版本冲突" : "创作存储暂不可用",
  );
}
function raw(record: CreativeRecord) {
  const value = { ...record } as Record<string, unknown>;
  for (const key of [
    "revision",
    "_etag",
    "_rid",
    "_self",
    "_attachments",
    "_ts",
  ])
    delete value[key];
  return {
    ...value,
    id: creativeRecordId(record.kind, record.id),
    projectId: record.storyId,
    recordType: "creative",
    schemaVersion: 1,
  };
}
function deserialize(
  value: Record<string, unknown>,
  kind: CreativeRecord["kind"],
  storyId?: string,
): CreativeRecord {
  const prefix = `creative:${kind}:`;
  if (
    value.recordType !== "creative" ||
    value.kind !== kind ||
    typeof value.id !== "string" ||
    !value.id.startsWith(prefix) ||
    !value.id.slice(prefix.length) ||
    typeof value._etag !== "string" ||
    !value._etag ||
    typeof value.storyId !== "string" ||
    value.projectId !== value.storyId ||
    (storyId !== undefined && value.storyId !== storyId)
  )
    throw new AppError(503, "创作记录无效");
  const record = {
    ...value,
    id: value.id.slice(prefix.length),
    revision: value._etag,
  };
  for (const key of [
    "recordType",
    "schemaVersion",
    "projectId",
    "_etag",
    "_rid",
    "_self",
    "_attachments",
    "_ts",
  ])
    delete (record as Record<string, unknown>)[key];
  return record as unknown as CreativeRecord;
}

export function creativeOperations(
  storyId: string,
  writes: CreativeWrite[],
  input?: Entity | InitializationPackage,
): OperationInput[] {
  if (
    !writes.length ||
    writes.length > 98 ||
    writes.some(
      ({ record, revision }) =>
        record.storyId !== storyId ||
        !record.id ||
        (revision !== null && !revision),
    ) ||
    new Set(
      writes.map(({ record }) => creativeRecordId(record.kind, record.id)),
    ).size !== writes.length
  )
    throw new AppError(400, "创作事务范围无效");
  const ops: OperationInput[] = writes.map(({ record, revision }) =>
    revision === null
      ? { operationType: BulkOperationType.Create, resourceBody: raw(record) }
      : {
          operationType: BulkOperationType.Replace,
          id: creativeRecordId(record.kind, record.id),
          ifMatch: revision,
          resourceBody: raw(record),
        },
  );
  if (input && "story" in input) {
    appendInitialization(ops, storyId, writes, input);
    return ops;
  }
  if (input) {
    const chapter = clean(input);
    const taskWrite = writes.find(
      ({ record }) =>
        record.kind === "task" &&
        record.receipt &&
        "chapter_id" in record.receipt &&
        record.receipt.chapter_id === chapter.id,
    );
    const task =
      taskWrite?.record.kind === "task" ? taskWrite.record : undefined;
    const draftWrite = writes.find(
      ({ record }) =>
        record.kind === "draft" &&
        record.receipt &&
        "chapter_id" in record.receipt &&
        record.receipt.chapter_id === chapter.id,
    );
    const draft =
      draftWrite?.record.kind === "draft" ? draftWrite.record : undefined;
    const conversationWrite = writes.find(
      ({ record }) =>
        record.kind === "conversation" && record.id === task?.conversationId,
    );
    if (
      chapter.kind !== "chapter" ||
      chapter.projectId !== storyId ||
      chapter.currentVersion !== 1 ||
      chapter.deleted ||
      !task ||
      !draft ||
      !conversationWrite ||
      taskWrite!.revision === null ||
      draftWrite!.revision === null ||
      conversationWrite.revision === null ||
      task.authorization?.status !== "consumed" ||
      task.authorization.action !== "create_chapter" ||
      task.authorization.maxCreates !== 1 ||
      task.chapterId !== chapter.id ||
      task.receipt?.story_id !== storyId ||
      task.receipt.operation_id !== task.operationId ||
      draft.conversationId !== task.conversationId ||
      JSON.stringify(task.receipt) !== JSON.stringify(draft.receipt)
    )
      throw new AppError(
        400,
        "新章事务缺少一致的任务、草稿、授权或会话条件写入",
      );
    ops.push(
      {
        operationType: BulkOperationType.Create,
        resourceBody: {
          id: `version:${chapter.id}:1`,
          kind: "version",
          entityId: chapter.id,
          version: 1,
          projectId: storyId,
          content: chapter,
        },
      },
      {
        operationType: BulkOperationType.Create,
        resourceBody: { ...chapter, recordType: "head" },
      },
    );
  }
  if (Buffer.byteLength(JSON.stringify(ops)) > 1900 * 1024)
    throw new AppError(413, "完整创作事务过大");
  return ops;
}

export class CosmosCreativeStore implements CreativeStore {
  constructor(private readonly db: Database) {}
  async reserve(id: string, digest: string, storyId: string) {
    const container = this.db.container("library");
    try {
      const response = await container.items.create({
        id: `creative:request:${id}`,
        recordType: "creative",
        kind: "request",
        schemaVersion: 1,
        scopeId: "library",
        storyId,
        digest,
        createdAt: new Date().toISOString(),
      });
      if (
        typeof response.statusCode !== "number" ||
        response.statusCode < 200 ||
        response.statusCode >= 300 ||
        typeof response.resource?._etag !== "string" ||
        !response.resource._etag
      )
        throw new AppError(503, "请求登记结果无效");
    } catch (error) {
      if (Number((error as { code?: number } | null)?.code) !== 409)
        storageError(error);
      try {
        const { resource } = await container
          .item(`creative:request:${id}`, "library")
          .read();
        if (
          resource?.recordType !== "creative" ||
          resource.kind !== "request" ||
          resource.digest !== digest ||
          resource.storyId !== storyId
        )
          throw new AppError(409, "请求 ID 已用于其他输入或故事");
      } catch (error) {
        storageError(error);
      }
    }
  }
  private async get<T extends CreativeRecord>(
    storyId: string,
    id: string,
    kind: T["kind"],
  ): Promise<T | undefined> {
    try {
      const { resource } = await this.db
        .container("stories")
        .item(creativeRecordId(kind, id), storyId)
        .read();
      return resource ? (deserialize(resource, kind, storyId) as T) : undefined;
    } catch (error) {
      if (Number((error as { code?: number } | null)?.code) === 404)
        return undefined;
      storageError(error);
    }
  }
  private async query<T extends CreativeRecord>(
    kind: T["kind"],
    storyId?: string,
    conversationId?: string,
    active = false,
  ): Promise<T[]> {
    try {
      const clauses = ["c.recordType = 'creative'", "c.kind = @kind"];
      const parameters = [{ name: "@kind", value: kind as string }];
      if (storyId !== undefined) {
        clauses.push("c.projectId = @storyId");
        parameters.push({ name: "@storyId", value: storyId });
      }
      if (conversationId !== undefined) {
        clauses.push("c.conversationId = @conversationId");
        parameters.push({ name: "@conversationId", value: conversationId });
      }
      if (active)
        clauses.push("c.status IN ('interpreting', 'pending', 'running')");
      const { resources } = await this.db
        .container("stories")
        .items.query(
          {
            query: `SELECT * FROM c WHERE ${clauses.join(" AND ")}`,
            parameters,
          },
          storyId === undefined
            ? { forceQueryPlan: true }
            : { partitionKey: storyId, forceQueryPlan: false },
        )
        .fetchAll();
      return resources
        .map((row) => deserialize(row, kind, storyId) as T)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        );
    } catch (error) {
      storageError(error);
    }
  }
  conversation(storyId: string, id: string) {
    return this.get<CreativeConversation>(storyId, id, "conversation");
  }
  conversations(storyId?: string) {
    return this.query<CreativeConversation>("conversation", storyId);
  }
  task(storyId: string, id: string) {
    return this.get<CreativeTask>(storyId, id, "task");
  }
  tasks(storyId: string, conversationId: string) {
    return this.query<CreativeTask>("task", storyId, conversationId);
  }
  activeTasks() {
    return this.query<CreativeTask>("task", undefined, undefined, true);
  }
  draft(storyId: string, id: string) {
    return this.get<CreativeDraft>(storyId, id, "draft");
  }
  drafts(storyId: string, conversationId: string) {
    return this.query<CreativeDraft>("draft", storyId, conversationId);
  }
  async transaction(
    storyId: string,
    writes: CreativeWrite[],
    chapter?: Entity | InitializationPackage,
  ): Promise<CreativeRecord[]> {
    const ops = creativeOperations(storyId, writes, chapter);
    try {
      const response = await this.db
        .container("stories")
        .items.batch(ops, storyId);
      const codes = [
        response.code,
        ...(response.result ?? []).map((result) => result.statusCode),
      ];
      if (codes.some((code) => code === 409 || code === 412))
        throw new AppError(409, "创作记录版本冲突");
      if (
        !codes.every(
          (code) => typeof code === "number" && code >= 200 && code < 300,
        ) ||
        response.result?.length !== ops.length ||
        !response.result.every(
          (result) => typeof result.eTag === "string" && result.eTag.length > 0,
        )
      )
        throw new AppError(503, "创作事务结果无效");
      return writes.map(({ record }, index) => ({
        ...record,
        revision: response.result![index]!.eTag!,
      }));
    } catch (error) {
      storageError(error);
    }
  }
}
