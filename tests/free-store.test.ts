import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { freeOperations, CosmosFreeStore } from "../src/server/free-store.js";
import type { Database } from "@azure/cosmos";
import type { Ledger } from "../src/shared/free.js";
function op(): Ledger {
  return {
    id: randomUUID(),
    kind: "op",
    revision: "",
    createdAt: new Date().toISOString(),
    conversationId: randomUUID(),
    bindingDigest: "sha256:" + "a".repeat(64),
    authorizationId: randomUUID(),
    taskId: randomUUID(),
    sourceMessageId: randomUUID(),
    action: "initialize_story",
    target: { kind: "story", story_id: randomUUID() },
    baseRevision: null,
    status: "active",
  };
}
it("does not allow a target ledger in another partition", () => {
  const record = op();
  expect(() =>
    freeOperations("library", [{ record, revision: null }]),
  ).toThrow();
  expect(() =>
    freeOperations(randomUUID(), [{ record, revision: null }]),
  ).toThrow();
});
it("uses create-only target OP and opaque revision CAS without library projection in story batch", () => {
  const record = op();
  const partition =
    record.target.kind === "story" ? record.target.story_id : "";
  const created = freeOperations(partition, [{ record, revision: null }]);
  expect(created[0]?.operationType).toBe("Create");
  expect(created[0]).toHaveProperty("resourceBody.projectId", partition);
  expect(created[0]).toHaveProperty("resourceBody.id", `free:op:${record.id}`);
  const updated = freeOperations(partition, [
    { record: { ...record, status: "revoked" }, revision: "etag" },
  ]);
  expect(updated[0]).toMatchObject({
    operationType: "Replace",
    ifMatch: "etag",
  });
});
it("Cosmos missing transaction etags never claims persistence success", async () => {
  const record = op();
  const partition =
    record.target.kind === "story" ? record.target.story_id : "";
  const db = {
    container: () => ({
      items: {
        batch: async () => ({ code: 200, result: [{ statusCode: 201 }] }),
      },
    }),
  };
  const store = new CosmosFreeStore(db as unknown as Database);
  await expect(
    store.transaction(partition, [{ record, revision: null }]),
  ).rejects.toThrow("invalid_free_transaction_result");
});
it("Cosmos target OP point read checks static partition identity", async () => {
  const record = op();
  const db = {
    container: () => ({
      item: () => ({
        read: async () => ({
          resource: {
            ...record,
            id: `free:op:${record.id}`,
            recordType: "free",
            schemaVersion: 2,
            projectId: randomUUID(),
            _etag: "etag",
          },
        }),
      }),
    }),
  };
  const store = new CosmosFreeStore(db as unknown as Database);
  await expect(store.get(randomUUID(), "op", record.id)).rejects.toThrow(
    "invalid_free_record",
  );
});
