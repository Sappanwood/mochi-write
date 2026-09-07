import {
  BulkOperationType,
  type Database,
  type OperationInput,
} from "@azure/cosmos";
import type { Store } from "./store.js";
import {
  AppError,
  type Entity,
  type Document,
  type Filter,
  type Page,
} from "../shared/model.js";
import { clean } from "./entities.js";
function deserialize(raw: Record<string, unknown>): Document {
  const value = { ...raw };
  delete value.recordType;
  return { ...clean(value as unknown as Entity), revision: String(raw._etag) };
}
function storageError(error: unknown): never {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? Number(error.code)
      : 0;
  throw new AppError(
    [409, 412].includes(code) ? 409 : 503,
    [409, 412].includes(code)
      ? "版本冲突，请重新读取"
      : "存储暂不可用，请保留内容并重试",
  );
}
export class CosmosStore implements Store {
  constructor(readonly database: Database) {}
  async get(
    id: string,
    projectId: string | null,
  ): Promise<Document | undefined> {
    try {
      const { resource } = await this.database
        .container(projectId === null ? "library" : "stories")
        .item(id, projectId ?? "library")
        .read();
      return resource ? deserialize(resource) : undefined;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === 404
      )
        return undefined;
      storageError(error);
    }
  }
  async list(f: Filter): Promise<Page> {
    const clauses = [
      "c.recordType = 'head'",
      "(NOT IS_DEFINED(c.deleted) OR c.deleted = false)",
      "(c.kind != 'story' OR c.status = 'ready')",
    ];
    const parameters: { name: string; value: string }[] = [];
    if (f.kind) {
      clauses.push("c.kind = @kind");
      parameters.push({ name: "@kind", value: f.kind });
    }
    if (f.name) {
      clauses.push("CONTAINS(c.content.name, @name, true)");
      parameters.push({ name: "@name", value: f.name });
    }
    if (f.genre) {
      clauses.push("ARRAY_CONTAINS(c.content.genres, @genre)");
      parameters.push({ name: "@genre", value: f.genre });
    }
    if (f.ageBand) {
      clauses.push("c.content.ageBand = @ageBand");
      parameters.push({ name: "@ageBand", value: f.ageBand });
    }
    try {
      const response = await this.database
        .container(f.projectId === null ? "library" : "stories")
        .items.query(
          {
            query: `SELECT * FROM c WHERE ${clauses.join(" AND ")} ORDER BY c.id`,
            parameters,
          },
          {
            maxItemCount: f.limit ?? 40,
            continuationToken: f.cursor,
            ...(f.projectId !== undefined
              ? { partitionKey: f.projectId ?? "library" }
              : {}),
          },
        )
        .fetchNext();
      return {
        items: response.resources.map(deserialize),
        ...(response.continuationToken
          ? { cursor: response.continuationToken }
          : {}),
      };
    } catch (error) {
      storageError(error);
    }
  }
  async publishStory(story: Document): Promise<Document> {
    const head = {
      ...clean(story),
      status: "ready" as const,
      recordType: "head",
    };
    try {
      const response = await this.database.container("stories").items.batch(
        [
          {
            operationType: BulkOperationType.Replace,
            id: story.id,
            ifMatch: story.revision,
            resourceBody: head,
          },
        ],
        story.projectId!,
      );
      if (
        [
          response.code,
          ...(response.result ?? []).map((x) => x.statusCode),
        ].some((c) => c === 409 || c === 412)
      )
        throw { code: 409 };
      if (!response.result?.[0]?.eTag || response.result[0].statusCode >= 400)
        throw { code: 503 };
      return {
        ...clean(story),
        status: "ready",
        revision: response.result[0].eTag,
      };
    } catch (error) {
      storageError(error);
    }
  }
  async commit(input: Entity, revision: string | null): Promise<Document> {
    const e = clean(input);
    const partition = e.projectId ?? "library";
    const head = { ...e, recordType: "head" };
    const version = {
      id: `version:${e.id}:${e.currentVersion}`,
      kind: "version",
      entityId: e.id,
      version: e.currentVersion,
      content: e,
      ...(e.projectId === null
        ? { scopeId: "library" }
        : { projectId: e.projectId }),
    };
    const ops: OperationInput[] = [
      { operationType: BulkOperationType.Create, resourceBody: version },
      revision === null
        ? { operationType: BulkOperationType.Create, resourceBody: head }
        : {
            operationType: BulkOperationType.Replace,
            id: e.id,
            ifMatch: revision,
            resourceBody: head,
          },
    ];
    try {
      const response = await this.database
        .container(e.projectId === null ? "library" : "stories")
        .items.batch(ops, partition);
      const codes = [
        response.code,
        ...(response.result ?? []).map((x) => x.statusCode),
      ];
      // SDK Response exposes operation results through result.
      const results = response.result;
      if (codes.some((x) => x === 409 || x === 412)) throw { code: 409 };
      if (codes.some((x) => x !== undefined && x >= 400) || !results?.[1]?.eTag)
        throw { code: 503 };
      return { ...e, revision: results[1].eTag };
    } catch (error) {
      storageError(error);
    }
  }
}
