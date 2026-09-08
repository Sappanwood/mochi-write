import { randomUUID } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { Creative, wireId } from "../src/server/creative.js";
import { entity } from "../src/server/entities.js";
import { Writing } from "../src/server/writing.js";
import type { CreativeTask } from "../src/shared/creative.js";
import type { Submit } from "../src/shared/writing.js";
import { FakeCreativeMochi } from "./support/creative-mochi.js";
import { MemoryCreativeStore } from "./support/creative-store.js";
import { FakeMochi } from "./support/fake-mochi.js";
import { MemoryStore } from "./support/memory-store.js";
import { MemoryWritingStore } from "./support/writing-store.js";

const services: Creative[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});
async function fixture(pending: boolean) {
  const content = new MemoryStore();
  const storyId = randomUUID();
  const story = await content.commit(
    {
      ...entity(
        "story",
        {
          name: "Synthetic story",
          markdown: "Established initial setting",
          genres: [],
          ageBand: "",
          sourceMetadata: {},
        },
        storyId,
        storyId,
      ),
      status: "ready",
    },
    null,
  );
  // Seed the server-owned persisted state without using a public editing API.
  if (pending)
    content.heads.set(
      `${storyId}:${storyId}`,
      Object.assign(story, { initializationPending: true }),
    );
  const records = new MemoryCreativeStore(content);
  const mochi = new FakeCreativeMochi();
  const creative = new Creative(content, records, mochi, { pollMs: 1 });
  services.push(creative);
  return { content, records, mochi, creative, storyId, story };
}
async function running(service: Creative, task: CreativeTask) {
  for (let i = 0; i < 300; i++) {
    const current = await service.task(task.storyId, task.id);
    if (current.status === "running" && current.runId) return current;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Creative task did not reach running state");
}

test.each([true, false])(
  "create_chapter v1 respects initializationPending=%s without consuming a rejected draft",
  async (pending) => {
    const f = await fixture(pending);
    const conversation = await f.creative.createConversation(f.storyId);
    f.mochi.intent = "create_and_save";
    const submitted = await f.creative.submit(f.storyId, {
      conversationId: conversation.id,
      clientRequestId: randomUUID(),
      provider: "deepseek",
      model: "test",
      message: "写第一章并保存",
    });
    const task = await running(f.creative, submitted);
    const ctx = (await f.creative.resolveTask(wireId(f.storyId, task.id)))!;
    await ctx.bindRun(task.runId!);
    const preview = await f.creative.createChapter(
      ctx,
      { mode: "draft", title: "First chapter", body: "Exact first chapter\n" },
      randomUUID(),
    );
    const data = preview.data as {
      draft_id: string;
      draft_revision: string;
      draft_hash: string;
    };
    const commit = () =>
      f.creative.createChapter(
        ctx,
        {
          mode: "commit",
          draft_id: data.draft_id,
          draft_revision: data.draft_revision,
          draft_hash: data.draft_hash,
        },
        randomUUID(),
      );
    if (pending) {
      await expect(commit()).rejects.toMatchObject({ code: "forbidden_scope" });
      expect(
        (await f.creative.task(f.storyId, task.id)).receipt,
      ).toBeUndefined();
      expect(
        (await f.records.draft(f.storyId, data.draft_id))?.receipt,
      ).toBeUndefined();
      expect(
        (await f.creative.task(f.storyId, task.id)).authorization?.status,
      ).toBe("active");
    } else {
      const result = await commit();
      expect(result.receipt).toMatchObject({
        operation_id: task.operationId,
        status: "committed",
        story_id: f.storyId,
        content_hash: data.draft_hash,
      });
      expect(result.receipt).not.toHaveProperty("kind");
      expect((await commit()).receipt).toEqual(result.receipt);
    }
    expect(
      (await f.content.list({ projectId: f.storyId, kind: "chapter" })).items,
    ).toHaveLength(pending ? 0 : 1);
    expect(await f.content.get(f.storyId, f.storyId)).toEqual(f.story);
    expect(f.content.history.size).toBe(pending ? 1 : 2);
  },
);

test.each([true, false])(
  "legacy Writing.accept respects initializationPending=%s and preserves the exact saved draft",
  async (pending) => {
    const f = await fixture(pending);
    const records = new MemoryWritingStore(f.content);
    const writing = new Writing(f.content, records, new FakeMochi());
    const scope = { type: "story" as const, id: f.storyId };
    const conversation = await writing.createConversation(scope);
    const input: Submit = {
      conversationId: conversation.id,
      clientRequestId: randomUUID(),
      provider: "deepseek",
      model: "model",
      message: "写第一章",
      pageContext: { schemaVersion: 1, scope, location: null, selection: null },
      attachedRefs: [],
      target: { id: null, revision: null, name: "First chapter", order: 1 },
    };
    const draft = await writing.submit(input);
    expect(draft.status).toBe("succeeded");
    if (pending) {
      await expect(writing.accept(scope, draft.id)).rejects.toMatchObject({
        statusCode: 409,
      });
      const retained = await writing.requireDraft(scope, draft.id);
      expect(retained.status).toBe("succeeded");
      expect(retained.output).toBe(draft.output);
      expect(retained.resultVersion).toBeUndefined();
    } else {
      const result = await writing.accept(scope, draft.id);
      expect(await writing.accept(scope, draft.id)).toEqual(result);
      expect(
        (await f.content.get(result.id!, f.storyId))?.content.markdown,
      ).toBe(draft.output);
    }
    expect(
      (await f.content.list({ projectId: f.storyId, kind: "chapter" })).items,
    ).toHaveLength(pending ? 0 : 1);
    expect(await f.content.get(f.storyId, f.storyId)).toEqual(f.story);
    expect(f.content.history.size).toBe(pending ? 1 : 2);
  },
);
