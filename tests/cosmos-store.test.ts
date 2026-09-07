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
    fetchNext: async () => ({ resources: [], continuationToken: undefined }),
    hasMoreResults: () => false,
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
      enableQueryControl: true,
      forceQueryPlan: true,
      continuationToken: "opaque",
      maxItemCount: 12,
    });
  });
});

describe("Cosmos SDK 4.10 empty query pages", () => {
  function iterator(
    pages: {
      resources?: unknown[];
      continuationToken?: string;
      more: boolean;
    }[],
  ) {
    let current = { more: true };
    return {
      fetchNext: vi.fn(async () => {
        const next = pages.shift();
        if (!next) throw Error("Unexpected fetch");
        current = next;
        return next;
      }),
      hasMoreResults: () => current.more,
    };
  }
  function storeWith(pages: ReturnType<typeof iterator>) {
    const query = vi.fn<(spec: unknown, options: unknown) => typeof pages>(
      () => pages,
    );
    const container = vi.fn(() => ({ items: { query } }));
    return {
      store: new CosmosStore({ container } as unknown as Database),
      query,
    };
  }
  it("normalizes only exhausted undefined pages into an empty result", async () => {
    const pages = iterator([{ resources: undefined, more: false }]);
    const f = storeWith(pages);
    expect(await f.store.list({ kind: "story" })).toEqual({ items: [] });
    expect(pages.fetchNext).toHaveBeenCalledTimes(1);
  });
  it("keeps the same iterator through multiple interim empty pages and preserves the data-page cursor", async () => {
    const pages = iterator([
      { resources: undefined, more: true },
      { resources: [], continuationToken: "interim-cursor", more: true },
      {
        resources: [{ ...doc, recordType: "head", _etag: "etag" }],
        continuationToken: "next-page",
        more: true,
      },
    ]);
    const f = storeWith(pages);
    const page = await f.store.list({ projectId: null, limit: 1 });
    expect(page.items.map((d) => d.id)).toEqual([doc.id]);
    expect(page.cursor).toBe("next-page");
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(pages.fetchNext).toHaveBeenCalledTimes(3);
  });
  it("can exhaust several empty pages without exposing an intermediate cursor", async () => {
    const pages = iterator([
      { resources: undefined, continuationToken: "temporary", more: true },
      { resources: [], more: true },
      { resources: undefined, more: false },
    ]);
    const f = storeWith(pages);
    expect(await f.store.list({ kind: "story" })).toEqual({ items: [] });
    expect(pages.fetchNext).toHaveBeenCalledTimes(3);
  });
  it("preserves requested continuation and returns the next logical data page", async () => {
    const pages = iterator([
      { resources: undefined, more: true },
      {
        resources: [{ ...doc, recordType: "head", _etag: "final" }],
        more: false,
      },
    ]);
    const f = storeWith(pages);
    const page = await f.store.list({
      projectId: null,
      cursor: "opaque-previous",
    });
    expect(f.query.mock.calls[0]?.[1]).toMatchObject({
      continuationToken: "opaque-previous",
    });
    expect(page.items[0]?.revision).toBe("final");
    expect(page.cursor).toBeUndefined();
  });
  it("does not convert a failure after an empty intermediate page into successful exhaustion", async () => {
    const pages = iterator([{ resources: undefined, more: true }]);
    const f = storeWith(pages);
    await expect(f.store.list({ kind: "story" })).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(pages.fetchNext).toHaveBeenCalledTimes(2);
  });
  it("rejects nonempty pages that still have data but cannot provide a resumable cursor", async () => {
    const pages = iterator([
      {
        resources: [{ ...doc, recordType: "head", _etag: "etag" }],
        more: true,
      },
    ]);
    await expect(
      storeWith(pages).store.list({ kind: "story" }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});
