import { describe, expect, it, vi } from "vitest";
import type { Database } from "@azure/cosmos";
import { CosmosStore } from "../src/server/cosmos-store.js";
import { entity } from "../src/server/entities.js";
function fixture(code = 200, operationCode = 200) {
  const batch = vi.fn().mockResolvedValue({
    code,
    result: [
      { statusCode: 201 },
      { statusCode: operationCode, eTag: "etag-next" },
    ],
  });
  const query = vi.fn().mockReturnValue({
    fetchNext: async () => ({ resources: [], continuationToken: "next" }),
  });
  const container = vi.fn().mockReturnValue({ items: { batch, query } });
  return {
    store: new CosmosStore({ container } as unknown as Database),
    batch,
    query,
    container,
  };
}
const doc = entity("character", {
  name: "测试",
  markdown: "正文",
  sourceMetadata: {},
  genres: [],
  ageBand: "",
});
describe("Cosmos transaction contract", () => {
  it("creates immutable version and conditional head together in the library partition", async () => {
    const f = fixture();
    const result = await f.store.commit(
      { ...doc, currentVersion: 2 },
      "etag-old",
    );
    expect(f.container).toHaveBeenCalledWith("library");
    expect(f.batch.mock.calls[0]?.[1]).toBe("library");
    const ops = f.batch.mock.calls[0]?.[0];
    expect(ops[0]).toMatchObject({
      operationType: "Create",
      resourceBody: {
        id: `version:${doc.id}:2`,
        kind: "version",
        scopeId: "library",
      },
    });
    expect(ops[1]).toMatchObject({
      operationType: "Replace",
      id: doc.id,
      ifMatch: "etag-old",
    });
    expect(result.revision).toBe("etag-next");
  });
  it("uses create-only for new heads", async () => {
    const f = fixture();
    await f.store.commit(doc, null);
    expect(
      f.batch.mock.calls[0]?.[0].map(
        (x: { operationType: string }) => x.operationType,
      ),
    ).toEqual(["Create", "Create"]);
  });
  it.each([409, 412])(
    "maps transaction conflicts (%s) to 409",
    async (code) => {
      await expect(fixture(code).store.commit(doc, null)).rejects.toMatchObject(
        { statusCode: 409 },
      );
      await expect(
        fixture(200, code).store.commit(doc, null),
      ).rejects.toMatchObject({ statusCode: 409 });
    },
  );
  it("does not report success for failed dependencies or missing result", async () => {
    await expect(
      fixture(200, 424).store.commit(doc, null),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
  it("parameterizes filters and passes continuation tokens", async () => {
    const f = fixture();
    await f.store.list({
      projectId: null,
      name: "' OR true",
      genre: "奇幻",
      cursor: "opaque",
      limit: 12,
    });
    const [spec, options] = f.query.mock.calls[0]!;
    expect(spec.query).not.toContain("' OR true");
    expect(spec.parameters).toContainEqual({
      name: "@name",
      value: "' OR true",
    });
    expect(options).toMatchObject({
      partitionKey: "library",
      continuationToken: "opaque",
      maxItemCount: 12,
    });
  });
});
