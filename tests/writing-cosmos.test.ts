import { expect, test, vi } from "vitest";
import type { Database } from "@azure/cosmos";
import { randomUUID } from "node:crypto";
import { CosmosWritingStore } from "../src/server/writing-store.js";
import { entity } from "../src/server/entities.js";
import type { DraftRecord } from "../src/shared/writing.js";
const projectId = randomUUID();
const chapter = {
  ...entity(
    "chapter",
    {
      name: "章",
      markdown: "完整",
      genres: [],
      ageBand: "",
      sourceMetadata: {},
    },
    projectId,
  ),
  order: 1,
};
const draft = {
  id: randomUUID(),
  projectId,
  revision: "draft-old",
  status: "succeeded",
  output: "完整",
} as DraftRecord;
function fixture(
  result: unknown = [
    { statusCode: 201, eTag: "v" },
    { statusCode: 201, eTag: "h" },
    { statusCode: 200, eTag: "d" },
  ],
) {
  const batch = vi.fn().mockResolvedValue({ code: 200, result });
  const container = vi.fn(() => ({ items: { batch } }));
  return {
    store: new CosmosWritingStore({ container } as unknown as Database),
    batch,
    container,
  };
}
test("acceptance creates immutable version, conditionally replaces head and marks draft in one partition batch", async () => {
  const f = fixture();
  await f.store.accept(draft, chapter, "chapter-old");
  const [ops, partition] = f.batch.mock.calls[0]!;
  expect(partition).toBe(projectId);
  expect(ops).toHaveLength(3);
  expect(ops[0]).toMatchObject({
    operationType: "Create",
    resourceBody: { id: `version:${chapter.id}:1` },
  });
  expect(ops[1]).toMatchObject({
    operationType: "Replace",
    id: chapter.id,
    ifMatch: "chapter-old",
  });
  expect(ops[2]).toMatchObject({
    operationType: "Replace",
    id: draft.id,
    ifMatch: "draft-old",
    resourceBody: { status: "accepted", resultVersion: 1 },
  });
});
test("new chapters use Create, never upsert", async () => {
  const f = fixture();
  await f.store.accept(draft, chapter, null);
  expect(f.batch.mock.calls[0]![0][1].operationType).toBe("Create");
});
test.each([[], [{ statusCode: 201, eTag: "one" }], null])(
  "missing operation results cannot declare acceptance: %j",
  async (result) => {
    await expect(
      fixture(result).store.accept(draft, chapter, null),
    ).rejects.toMatchObject({ statusCode: 503 });
  },
);
test.each([409, 412])(
  "transaction conflict %s is recoverable 409",
  async (code) => {
    await expect(
      fixture([
        { statusCode: 424 },
        { statusCode: code },
        { statusCode: 424 },
      ]).store.accept(draft, chapter, null),
    ).rejects.toMatchObject({ statusCode: 409 });
  },
);

test.each([409, 412])(
  "SDK-thrown conflict %s remains a 409 instead of generic outage",
  async (code) => {
    const f = fixture();
    f.batch.mockRejectedValueOnce({ code });
    await expect(f.store.accept(draft, chapter, null)).rejects.toMatchObject({
      statusCode: 409,
    });
  },
);
