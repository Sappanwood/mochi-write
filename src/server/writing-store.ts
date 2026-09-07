import type { Database, OperationInput } from "@azure/cosmos";
import { BulkOperationType } from "@azure/cosmos";
import { AppError, type Entity } from "../shared/model.js";
import type { Conversation, DraftRecord } from "../shared/writing.js";
import { clean } from "./entities.js";
export interface WritingStore {
  reserve(id: string, digest: string, projectId: string | null): Promise<void>;
  conversations(projectId: string | null): Promise<Conversation[]>;
  createConversation(value: Conversation): Promise<void>;
  get(id: string, projectId: string | null): Promise<DraftRecord | undefined>;
  drafts(
    projectId: string | null,
    conversationId: string,
  ): Promise<DraftRecord[]>;
  save(value: DraftRecord, revision: string | null): Promise<DraftRecord>;
  accept(
    draft: DraftRecord,
    chapter: Entity,
    baseRevision: string | null,
  ): Promise<void>;
}
export class CosmosWritingStore implements WritingStore {
  constructor(private db: Database) {}
  async reserve(id: string, digest: string, projectId: string | null) {
    const container = this.db.container("library");
    try {
      await container.items.create({
        id: `request:${id}`,
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        recordType: "writing",
        kind: "request",
        scopeId: "library",
        digest,
        targetPartition: projectId,
      });
    } catch (e) {
      if ((e as { code?: number }).code !== 409)
        throw new AppError(503, "请求登记失败");
      const { resource } = await container
        .item(`request:${id}`, "library")
        .read();
      if (resource?.digest !== digest || resource.targetPartition !== projectId)
        throw new AppError(409, "请求 ID 已用于其他输入或范围");
    }
  }

  private container(p: string | null) {
    return this.db.container(p === null ? "library" : "stories");
  }
  private raw(value: Conversation | DraftRecord) {
    const rest = { ...value } as Partial<DraftRecord>;
    delete rest.revision;
    for (const key of ["_etag", "_rid", "_self", "_attachments", "_ts"])
      delete (rest as Record<string, unknown>)[key];
    return {
      ...rest,
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      recordType: "writing",
      kind: "sessionId" in value ? "conversation" : "draft",
      ...(value.projectId === null ? { scopeId: "library" } : {}),
    };
  }
  private async query<T>(
    p: string | null,
    kind: string,
    conversationId?: string,
  ) {
    try {
      const { resources } = await this.container(p)
        .items.query(
          {
            query:
              "SELECT * FROM c WHERE c.recordType = 'writing' AND c.kind = @kind" +
              (conversationId ? " AND c.conversationId = @conversationId" : ""),
            parameters: [
              { name: "@kind", value: kind },
              ...(conversationId
                ? [{ name: "@conversationId", value: conversationId }]
                : []),
            ],
          },
          { partitionKey: p ?? "library" },
        )
        .fetchAll();
      return resources.map((r) => ({ ...r, revision: r._etag })) as T[];
    } catch {
      throw new AppError(503, "写作存储暂不可用");
    }
  }
  conversations(p: string | null) {
    return this.query<Conversation>(p, "conversation");
  }
  drafts(p: string | null, c: string) {
    return this.query<DraftRecord>(p, "draft", c).then((values) =>
      values.sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      ),
    );
  }
  async createConversation(v: Conversation) {
    try {
      await this.container(v.projectId).items.create(this.raw(v));
    } catch {
      throw new AppError(503, "会话关联保存失败");
    }
  }
  async get(id: string, p: string | null) {
    try {
      const { resource } = await this.container(p)
        .item(id, p ?? "library")
        .read();
      return resource?.recordType === "writing" && resource.kind === "draft"
        ? ({ ...resource, revision: resource._etag } as DraftRecord)
        : undefined;
    } catch (e) {
      if ((e as { code?: number }).code === 404) return undefined;
      throw new AppError(503, "草稿读取失败");
    }
  }
  async save(v: DraftRecord, revision: string | null) {
    const ops: OperationInput[] = [
      revision === null
        ? { operationType: BulkOperationType.Create, resourceBody: this.raw(v) }
        : {
            operationType: BulkOperationType.Replace,
            id: v.id,
            ifMatch: revision,
            resourceBody: this.raw(v),
          },
    ];
    const result = await this.batch(v.projectId, ops);
    return { ...v, revision: result[0]!.eTag! };
  }
  private async batch(p: string | null, ops: OperationInput[]) {
    if (Buffer.byteLength(JSON.stringify(ops)) > 1900 * 1024)
      throw new AppError(413, "完整采纳事务过大，请减少输出");
    try {
      const response = await this.container(p).items.batch(ops, p ?? "library");
      const codes = [
        response.code,
        ...(response.result ?? []).map((r) => r.statusCode),
      ];
      if (codes.some((c) => c === 409 || c === 412))
        throw new AppError(409, "版本冲突，请重新读取");
      if (
        codes.some((c) => c !== undefined && c >= 400) ||
        response.result?.length !== ops.length ||
        !response.result?.every((r) => r.eTag)
      )
        throw new AppError(503, "写作保存失败");
      return response.result;
    } catch (e) {
      if (e instanceof AppError) throw e;
      if ([409, 412].includes(Number((e as { code?: number })?.code)))
        throw new AppError(409, "版本冲突，请重新读取");
      throw new AppError(503, "写作保存失败");
    }
  }
  async accept(d: DraftRecord, input: Entity, baseRevision: string | null) {
    const chapter = clean(input);
    await this.batch(d.projectId, [
      {
        operationType: BulkOperationType.Create,
        resourceBody: {
          id: `version:${chapter.id}:${chapter.currentVersion}`,
          kind: "version",
          entityId: chapter.id,
          version: chapter.currentVersion,
          projectId: chapter.projectId,
          content: chapter,
        },
      },
      baseRevision === null
        ? {
            operationType: BulkOperationType.Create,
            resourceBody: { ...chapter, recordType: "head" },
          }
        : {
            operationType: BulkOperationType.Replace,
            id: chapter.id,
            ifMatch: baseRevision,
            resourceBody: { ...chapter, recordType: "head" },
          },
      {
        operationType: BulkOperationType.Replace,
        id: d.id,
        ifMatch: d.revision,
        resourceBody: this.raw({
          ...d,
          status: "accepted",
          resultVersion: chapter.currentVersion,
        }),
      },
    ]);
  }
}
