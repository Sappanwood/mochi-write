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
  async assetScopes(id: string): Promise<(string | null)[]> {
    try {
      const results = await Promise.all(
        ["stories", "library"].map(async (name) => {
          const { resources } = await this.database
            .container(name)
            .items.query<{ projectId: string | null }>(
              {
                query:
                  "SELECT TOP 2 c.projectId FROM c WHERE c.recordType = 'head' AND c.id = @id",
                parameters: [{ name: "@id", value: id }],
              },
              {
                forceQueryPlan: name === "stories",
                ...(name === "library" ? { partitionKey: "library" } : {}),
              },
            )
            .fetchAll();
          return resources.map((row) => row.projectId);
        }),
      );
      return results.flat();
    } catch (error) {
      storageError(error);
    }
  }
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
  async getVersion(
    id: string,
    projectId: string | null,
    version: number,
  ): Promise<Entity | undefined> {
    try {
      const { resource } = await this.database
        .container(projectId === null ? "library" : "stories")
        .item(`version:${id}:${version}`, projectId ?? "library")
        .read();
      if (!resource) return undefined;
      if (
        resource.kind !== "version" ||
        resource.entityId !== id ||
        resource.version !== version ||
        resource.content?.id !== id ||
        resource.content?.projectId !== projectId ||
        resource.content?.currentVersion !== version
      )
        throw new Error("Invalid immutable version");
      return clean(resource.content);
    } catch (error) {
      if (Number((error as { code?: number })?.code) === 404) return undefined;
      storageError(error);
    }
  }
  async searchLibrary(f: import("../shared/model.js").LibraryFilter) {
    return this.query<import("../shared/model.js").LibraryEntry>(
      { ...f, projectId: null },
      `SELECT c.id AS asset_id, c.kind, c.content.name AS name, c._etag AS revision, c.currentVersion AS version, c.content.genres AS genres, c.content.ageBand AS age_band, c.content.sourceMetadata.gender AS gender, c.content.sourceMetadata.occupation AS occupation, c.content.sourceMetadata.traits AS traits, c.content.sourceMetadata.era AS era, c.content.sourceMetadata.tags AS tags FROM c`,
      (row) => row as unknown as import("../shared/model.js").LibraryEntry,
    );
  }
  async discoverAssets(f: Filter) {
    return this.query<import("./store.js").DiscoveryEntry>(
      f,
      "SELECT c.id AS asset_id, c.kind, c.projectId AS story_id, c.content.name AS name, c._etag AS revision, c.currentVersion AS version FROM c",
      (row) => {
        const value = { ...row };
        if (!value.story_id) delete value.story_id;
        return value as unknown as import("./store.js").DiscoveryEntry;
      },
    );
  }
  async list(f: Filter): Promise<Page> {
    return this.query(f, "SELECT * FROM c", deserialize);
  }
  private async query<T>(
    f: Filter,
    select: string,
    decode: (row: Record<string, unknown>) => T,
  ): Promise<{ items: T[]; cursor?: string }> {
    const clauses = [
      "c.recordType = 'head'",
      "(NOT IS_DEFINED(c.deleted) OR c.deleted = false)",
      "(c.kind != 'story' OR c.status = 'ready')",
    ];
    const parameters: { name: string; value: string }[] = [];
    if (typeof f.projectId === "string") {
      clauses.push("c.projectId = @projectId");
      parameters.push({ name: "@projectId", value: f.projectId });
    }
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
    for (const field of ["gender", "occupation", "era"] as const) {
      if (f[field]) {
        const path = `c.content.sourceMetadata.${field}`;
        clauses.push(
          `IS_STRING(${path}) AND ${field === "gender" ? `${path} = @${field}` : `CONTAINS(${path}, @${field}, true)`}`,
        );
        parameters.push({ name: `@${field}`, value: f[field]! });
      }
    }
    if (f.trait) {
      clauses.push(
        "IS_ARRAY(c.content.sourceMetadata.traits) AND EXISTS(SELECT VALUE t FROM t IN c.content.sourceMetadata.traits WHERE IS_STRING(t) AND CONTAINS(t, @trait, true))",
      );
      parameters.push({ name: "@trait", value: f.trait });
    }
    if (f.tag) {
      clauses.push(
        "IS_ARRAY(c.content.sourceMetadata.tags) AND ARRAY_CONTAINS(c.content.sourceMetadata.tags, @tag)",
      );
      parameters.push({ name: "@tag", value: f.tag });
    }
    try {
      const iterator = this.database
        .container(f.projectId === null ? "library" : "stories")
        .items.query(
          {
            query: `${select} WHERE ${clauses.join(" AND ")} ORDER BY c.id`,
            parameters,
          },
          {
            maxItemCount: f.limit ?? 40,
            enableQueryControl: true,
            forceQueryPlan: f.projectId === undefined,
            continuationToken: f.cursor,
            ...(f.projectId !== undefined
              ? { partitionKey: f.projectId ?? "library" }
              : {}),
          },
        );
      while (true) {
        const response = await iterator.fetchNext();
        if (
          response.resources !== undefined &&
          !Array.isArray(response.resources)
        )
          throw new Error("Invalid Cosmos query resources");
        const more = iterator.hasMoreResults();
        if (!response.resources?.length && more) continue;
        if (more && !response.continuationToken)
          throw new Error(
            "Cosmos query cannot be resumed without a continuation token",
          );
        return {
          items: (response.resources ?? []).map(decode),
          ...(more && response.continuationToken
            ? { cursor: response.continuationToken }
            : {}),
        };
      }
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
