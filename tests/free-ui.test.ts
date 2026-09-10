import { expect, it } from "vitest";
import {
  readInformation,
  settleSubmission,
  blocksMessage,
} from "../src/web/free-client.js";
import type { Api } from "../src/web/api.js";
import type { ExactRef } from "../src/shared/free.js";
const ref: ExactRef = {
  type: "asset",
  kind: "character",
  asset_id: "a",
  revision: "old",
  version: 1,
  content_hash: "hash",
};
it("never substitutes a changed head for the selected exact asset", async () => {
  const api: Api = async <T>() =>
    ({ revision: "new", currentVersion: 2, content: { name: "new" } }) as T;
  await expect(
    readInformation(api, "", { ref, title: "old", recorded: false }),
  ).rejects.toThrow("原版本不可取得");
});
it("opens recorded sources only through the scoped exact-history endpoint", async () => {
  const paths: string[] = [];
  const api: Api = async <T>(path: string) => {
    paths.push(path);
    return { availability: "unavailable", ref } as T;
  };
  const result = await readInformation(api, "/creative/free/conversations/c", {
    ref,
    title: "old",
    recorded: true,
  });
  expect(result.availability).toBe("unavailable");
  expect(paths).toHaveLength(1);
  expect(paths[0]).toContain("/references?ref=");
});
it("a delayed acknowledgement cannot clear newer input or references", () => {
  const sent = {
    message: "sent",
    refs: [{ ref, title: "old", recorded: false }],
  };
  const edited = { message: "new feedback", refs: [] };
  expect(settleSubmission(edited, sent)).toEqual(edited);
  expect(settleSubmission(sent, sent)).toEqual({ message: "", refs: [] });
});
it("blocks pending targets and unresolved original runs even after a receipt, but permits completed discussion", () => {
  expect(blocksMessage({ state: "verifying", stopPending: false })).toBe(true);
  expect(
    blocksMessage({ state: "committed", executionRun: { status: "running" } }),
  ).toBe(true);
  expect(blocksMessage({ state: "clarifying" })).toBe(false);
  expect(blocksMessage({ state: "succeeded" })).toBe(false);
  expect(
    blocksMessage({
      state: "revoked",
      stopPending: false,
      executionRun: { status: "running" },
    }),
  ).toBe(false);
});
it("opens the actual saved chapter from a receipt instead of the story's first chapter", async () => {
  const { assetPath } = await import("../src/web/free-client.js");
  expect(
    assetPath(
      { kind: "story", story_id: "story" },
      { chapter_id: "third", revision: "1", content_hash: "hash" },
    ),
  ).toBe("story/story/chapter/third");
  expect(assetPath({ kind: "story", story_id: "story" })).toBe(
    "story/story/chapter",
  );
  expect(assetPath({ kind: "character", asset_id: "role" })).toBe("asset/role");
});
