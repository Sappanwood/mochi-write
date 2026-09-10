import { appendStory, type StoryWrite } from "./free-story-operations.js";
import {
  BulkOperationType,
  type Database,
  type OperationInput,
} from "@azure/cosmos";
import type { FreeRecord } from "../shared/free.js";
import { AppError } from "../shared/model.js";
import {
  appendCharacter,
  type CharacterWrite,
} from "./free-character-operations.js";
export interface FreeWrite {
  record: FreeRecord;
  revision: string | null;
}
export interface FreeStore {
  get<T extends FreeRecord>(
    partition: string,
    kind: T["kind"],
    id: string,
  ): Promise<T | undefined>;
  list<T extends FreeRecord>(
    kind: T["kind"],
    conversationId?: string,
  ): Promise<T[]>;
  transaction(
    partition: string,
    writes: FreeWrite[],
    character?: CharacterWrite,
    story?: StoryWrite,
  ): Promise<FreeRecord[]>;
}
export const freeRecordId = (kind: string, id: string) => `free:${kind}:${id}`;
export function freeOperations(
  partition: string,
  writes: FreeWrite[],
  character?: CharacterWrite,
  story?: StoryWrite,
): OperationInput[] {
  if (
    !writes.length ||
    writes.length > 98 ||
    new Set(writes.map((w) => freeRecordId(w.record.kind, w.record.id)))
      .size !== writes.length ||
    writes.some(
      (w) =>
        !w.record.id ||
        (w.record.kind === "candidate" && w.revision !== null) ||
        (partition !== "library" && w.record.kind !== "op") ||
        (w.record.kind === "op" &&
          (w.record.target.kind === "character"
            ? "library"
            : w.record.target.story_id) !== partition) ||
        (w.revision !== null && !w.revision),
    )
  )
    throw new AppError(400, "invalid_free_transaction");
  const result: OperationInput[] = writes.map(({ record, revision }) => {
    const { revision: _revision, ...value } = record;
    void _revision;
    const resourceBody: Record<string, import("@azure/cosmos").JSONValue> =
      JSON.parse(
        JSON.stringify({
          ...value,
          id: freeRecordId(record.kind, record.id),
          recordType: "free",
          schemaVersion: 2,
          ...(partition === "library"
            ? { scopeId: "library" }
            : { projectId: partition }),
        }),
      );
    return revision === null
      ? { operationType: BulkOperationType.Create, resourceBody }
      : {
          operationType: BulkOperationType.Replace,
          id: freeRecordId(record.kind, record.id),
          ifMatch: revision,
          resourceBody,
        };
  });
  if (character && story) throw new AppError(400, "invalid_free_transaction");
  if (story) appendStory(result, partition, writes, story);
  if (character) appendCharacter(result, partition, writes, character);
  if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
    throw new AppError(400, "result_too_large");
  return result;
}
function decode(
  row: Record<string, unknown>,
  kind: string,
  partition: string,
): FreeRecord {
  const prefix = `free:${kind}:`;
  if (
    row.recordType !== "free" ||
    row.schemaVersion !== 2 ||
    row.kind !== kind ||
    typeof row.id !== "string" ||
    !row.id.startsWith(prefix) ||
    typeof row._etag !== "string" ||
    !row._etag ||
    (partition === "library"
      ? row.scopeId !== partition
      : row.projectId !== partition)
  )
    throw new AppError(503, "invalid_free_record");
  const value = {
    ...row,
    id: row.id.slice(prefix.length),
    revision: row._etag,
  };
  for (const k of [
    "recordType",
    "schemaVersion",
    "scopeId",
    "projectId",
    "_etag",
    "_rid",
    "_self",
    "_attachments",
    "_ts",
  ])
    delete (value as Record<string, unknown>)[k];
  return value as unknown as FreeRecord;
}
function fail(error: unknown): never {
  if (error instanceof AppError) throw error;
  const code = Number((error as { code?: number })?.code);
  throw new AppError(
    [409, 412].includes(code) ? 409 : 503,
    [409, 412].includes(code)
      ? "free_revision_conflict"
      : "free_store_unavailable",
  );
}
export class CosmosFreeStore implements FreeStore {
  constructor(private db: Database) {}
  async get<T extends FreeRecord>(
    partition: string,
    kind: T["kind"],
    id: string,
  ): Promise<T | undefined> {
    try {
      const { resource } = await this.db
        .container(partition === "library" ? "library" : "stories")
        .item(freeRecordId(kind, id), partition)
        .read();
      return resource ? (decode(resource, kind, partition) as T) : undefined;
    } catch (e) {
      if (Number((e as { code?: number })?.code) === 404) return undefined;
      fail(e);
    }
  }
  async list<T extends FreeRecord>(
    kind: T["kind"],
    conversationId?: string,
  ): Promise<T[]> {
    try {
      const { resources } = await this.db
        .container("library")
        .items.query(
          {
            query:
              "SELECT * FROM c WHERE c.recordType = 'free' AND c.kind = @kind" +
              (conversationId ? " AND c.conversationId = @conversationId" : ""),
            parameters: [
              { name: "@kind", value: kind },
              ...(conversationId
                ? [{ name: "@conversationId", value: conversationId }]
                : []),
            ],
          },
          { partitionKey: "library", forceQueryPlan: false },
        )
        .fetchAll();
      return resources
        .map((r) => decode(r, kind, "library") as T)
        .sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        );
    } catch (e) {
      fail(e);
    }
  }
  async transaction(
    partition: string,
    writes: FreeWrite[],
    character?: CharacterWrite,
    story?: StoryWrite,
  ) {
    const ops = freeOperations(partition, writes, character, story);
    try {
      const response = await this.db
        .container(partition === "library" ? "library" : "stories")
        .items.batch(ops, partition);
      const codes = [
        response.code,
        ...(response.result ?? []).map((r) => r.statusCode),
      ];
      if (codes.some((c) => c === 409 || c === 412))
        throw new AppError(409, "free_revision_conflict");
      if (
        response.result?.length !== ops.length ||
        !codes.every((c) => typeof c === "number" && c >= 200 && c < 300) ||
        response.result.some((r) => !r.eTag)
      )
        throw new AppError(503, "invalid_free_transaction_result");
      return writes.map((w, i) => ({
        ...w.record,
        revision: response.result![i]!.eTag!,
      }));
    } catch (e) {
      fail(e);
    }
  }
}
