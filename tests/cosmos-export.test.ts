import { describe, expect, it } from "vitest";
import type { Database } from "@azure/cosmos";
import { CosmosStore } from "../src/server/cosmos-store.js";
import { entity } from "../src/server/entities.js";
import { exportFiles } from "../src/server/export.js";

const content = {
  name: "Synthetic",
  markdown: "Fixture",
  sourceMetadata: {},
  genres: [],
  ageBand: "",
};
describe("Cosmos scoped export", () => {
  it("exports each story partition once when forced plans ignore the logical partition header", async () => {
    const storyA = { ...entity("story", content), status: "ready" };
    storyA.projectId = storyA.id;
    const storyB = { ...entity("story", content), status: "ready" };
    storyB.projectId = storyB.id;
    const rows = [
      entity("character", content),
      storyA,
      storyB,
      { ...entity("chapter", content), projectId: storyA.id, order: 1 },
      { ...entity("chapter", content), projectId: storyB.id, order: 1 },
    ];
    const database = {
      container(name: string) {
        return {
          items: {
            query(
              spec: {
                query: string;
                parameters: { name: string; value: string }[];
              },
              options: { partitionKey?: string; forceQueryPlan?: boolean },
            ) {
              let filtered = rows.filter(
                (r) => (r.projectId === null) === (name === "library"),
              );
              // SDK 4.10 forced plans route physical ranges without a logical key header.
              if (options.partitionKey && !options.forceQueryPlan)
                filtered = filtered.filter(
                  (r) => (r.projectId ?? "library") === options.partitionKey,
                );
              const parameter = (name: string) =>
                spec.parameters.find((p) => p.name === name)?.value;
              if (spec.query.includes("c.projectId = @projectId"))
                filtered = filtered.filter(
                  (r) => r.projectId === parameter("@projectId"),
                );
              if (parameter("@kind"))
                filtered = filtered.filter(
                  (r) => r.kind === parameter("@kind"),
                );
              return {
                hasMoreResults: () => false,
                fetchNext: async () => ({
                  resources: filtered.map((r) => ({
                    ...r,
                    recordType: "head",
                    _etag: "fixture",
                  })),
                }),
              };
            },
          },
        };
      },
    };
    const files = await exportFiles(
      new CosmosStore(database as unknown as Database),
    );
    const markdown = files.filter((f) => f.path !== "manifest.json");
    expect(markdown).toHaveLength(rows.length);
    expect(new Set(markdown.map((f) => f.path)).size).toBe(rows.length);
    const manifest = JSON.parse(
      files.find((f) => f.path === "manifest.json")!.text,
    );
    expect(
      manifest.entries
        .map((entry: { entityId: string }) => entry.entityId)
        .sort(),
    ).toEqual(rows.map((r) => r.id).sort());
  });
});
