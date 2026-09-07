import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { Writing } from "../src/server/writing.js";
import { AppError } from "../src/shared/model.js";
import { entity } from "../src/server/entities.js";
import type { Submit } from "../src/shared/writing.js";
import { FakeMochi } from "./support/fake-mochi.js";
import { MemoryStore } from "./support/memory-store.js";
import { MemoryWritingStore } from "./support/writing-store.js";
async function fixture() {
  const content = new MemoryStore(),
    records = new MemoryWritingStore(content),
    mochi = new FakeMochi(),
    writing = new Writing(content, records, mochi);
  const storyId = randomUUID();
  await content.commit(
    {
      ...entity(
        "story",
        {
          name: "故事",
          markdown: "",
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
  const scope = { type: "story" as const, id: storyId };
  const conversation = await writing.createConversation(scope);
  const input: Submit = {
    conversationId: conversation.id,
    clientRequestId: randomUUID(),
    provider: "deepseek",
    model: "model",
    message: "写下一章",
    pageContext: { schemaVersion: 1, scope, location: null, selection: null },
    attachedRefs: [],
    target: { id: null, revision: null, name: "第三章", order: 3 },
  };
  return { content, records, mochi, writing, scope, input };
}
test("complete result is persisted and accepted once with immutable version", async () => {
  const f = await fixture();
  const draft = await f.writing.submit(f.input);
  expect(draft.status).toBe("succeeded");
  const result = await f.writing.accept(f.scope, draft.id);
  expect(await f.writing.accept(f.scope, draft.id)).toEqual(result);
  expect((await f.content.get(result.id!, f.scope.id))?.content.markdown).toBe(
    "完整的新章节。",
  );
  expect(f.content.history.size).toBe(2);
});
test("lost submission response is recovered by request key without second run", async () => {
  const f = await fixture();
  f.mochi.loseResponse = true;
  await expect(f.writing.submit(f.input)).rejects.toMatchObject({
    statusCode: 503,
  });
  const draft = await f.writing.resume(f.scope, f.input.clientRequestId);
  expect(draft.status).toBe("succeeded");
  expect(f.mochi.calls.filter((p) => p.endsWith("/runs"))).toHaveLength(1);
  expect((await f.writing.submit(f.input)).id).toBe(draft.id);
});
test("unknown pending query never silently resubmits", async () => {
  const f = await fixture();
  const request = f.mochi.request.bind(f.mochi);
  f.mochi.request = async (path, body) => {
    if (path.endsWith("/runs")) throw new AppError(503, "断线");
    return request(path, body);
  };
  await expect(f.writing.submit(f.input)).rejects.toMatchObject({
    statusCode: 503,
  });
  const before = f.mochi.calls.length;
  expect(
    (await f.writing.resume(f.scope, f.input.clientRequestId)).status,
  ).toBe("pending");
  expect(f.mochi.calls.slice(before).every((p) => !p.endsWith("/runs"))).toBe(
    true,
  );
});
test("request key rejects changed inputs and scopes", async () => {
  const f = await fixture();
  await f.writing.submit(f.input);
  await expect(
    f.writing.submit({ ...f.input, message: "不同" }),
  ).rejects.toMatchObject({ statusCode: 409 });
  const scope = { type: "library" as const, id: "library" },
    c = await f.writing.createConversation(scope);
  await expect(
    f.writing.submit({
      ...f.input,
      conversationId: c.id,
      pageContext: { ...f.input.pageContext, scope },
      target: null,
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
});
test.each(["failed", "cancelled", "interrupted", "running"] as const)(
  "%s output cannot be accepted",
  async (status) => {
    const f = await fixture();
    f.mochi.status = status;
    const draft = await f.writing.submit(f.input);
    await expect(f.writing.accept(f.scope, draft.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(f.content.history.size).toBe(1);
  },
);
test("same base revision permits only one draft, conflict preserves competing output", async () => {
  const f = await fixture();
  const old = await f.content.commit(
    {
      ...entity(
        "chapter",
        {
          name: "章",
          markdown: "旧",
          genres: [],
          ageBand: "",
          sourceMetadata: {},
        },
        f.scope.id,
      ),
      order: 1,
    },
    null,
  );
  f.input.target = { id: old.id, revision: old.revision, name: "章", order: 1 };
  const a = await f.writing.submit(f.input),
    b = await f.writing.submit({ ...f.input, clientRequestId: randomUUID() });
  await f.writing.accept(f.scope, a.id);
  await expect(f.writing.accept(f.scope, b.id)).rejects.toMatchObject({
    statusCode: 409,
  });
  expect((await f.writing.requireDraft(f.scope, b.id)).output).toBe(
    "完整的新章节。",
  );
  expect((await f.content.get(old.id, f.scope.id))?.currentVersion).toBe(2);
});
test("failed atomic acceptance leaves both chapter and draft unaccepted", async () => {
  const f = await fixture();
  const d = await f.writing.submit(f.input);
  f.content.failNext = true;
  await expect(f.writing.accept(f.scope, d.id)).rejects.toMatchObject({
    statusCode: 503,
  });
  expect(await f.content.get(d.targetId!, f.scope.id)).toBeUndefined();
  expect((await f.writing.requireDraft(f.scope, d.id)).status).toBe(
    "succeeded",
  );
});
test("foreign refs, stale refs and oversized contexts fail before model submission", async () => {
  const f = await fixture();
  await expect(
    f.writing.submit({
      ...f.input,
      attachedRefs: [{ id: randomUUID(), revision: "x" }],
    }),
  ).rejects.toMatchObject({ statusCode: 404 });
  const asset = await f.content.commit(
    entity(
      "setting",
      {
        name: "设定",
        markdown: "资料",
        genres: [],
        ageBand: "",
        sourceMetadata: {},
      },
      f.scope.id,
    ),
    null,
  );
  await expect(
    f.writing.submit({
      ...f.input,
      clientRequestId: randomUUID(),
      attachedRefs: [{ id: asset.id, revision: "stale" }],
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  await expect(
    f.writing.submit({
      ...f.input,
      clientRequestId: randomUUID(),
      message: "字".repeat(9000),
    }),
  ).rejects.toMatchObject({ statusCode: 413 });
  expect(f.mochi.calls.filter((p) => p.endsWith("/runs"))).toHaveLength(0);
});
test("navigation cannot change draft target and library has no acceptance action", async () => {
  const f = await fixture();
  const d = await f.writing.submit(f.input);
  await expect(
    f.writing.accept({ type: "story", id: randomUUID() }, d.id),
  ).rejects.toMatchObject({ statusCode: 404 });
  const scope = { type: "library" as const, id: "library" },
    c = await f.writing.createConversation(scope);
  const library = await f.writing.submit({
    ...f.input,
    clientRequestId: randomUUID(),
    conversationId: c.id,
    pageContext: { ...f.input.pageContext, scope },
    target: null,
  });
  await expect(f.writing.accept(scope, library.id)).rejects.toMatchObject({
    statusCode: 400,
  });
});
test("running conversations reject another task and cancellation retains result", async () => {
  const f = await fixture();
  f.mochi.status = "running";
  const d = await f.writing.submit(f.input);
  await expect(
    f.writing.submit({ ...f.input, clientRequestId: randomUUID() }),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect((await f.writing.cancel(f.scope, d.id)).status).toBe("cancelled");
  expect(await f.writing.requireDraft(f.scope, d.id)).toBeDefined();
});
test("feedback is frozen with original target and output", async () => {
  const f = await fixture();
  const d = await f.writing.submit(f.input);
  const rewrite = await f.writing.submit({
    ...f.input,
    clientRequestId: randomUUID(),
    message: "更简练",
    feedbackDraftId: d.id,
  });
  expect(rewrite.prompt).toContain(d.output);
  expect(rewrite.request.target).toEqual(d.request.target);
});

test("failed terminal output is recovered from durable events but stays unadoptable", async () => {
  const f = await fixture();
  f.mochi.status = "failed";
  const draft = await f.writing.submit(f.input);
  expect(draft.output).toBe("不完整的片段");
  expect((await f.writing.resume(f.scope, draft.id)).output).toBe(draft.output);
  await expect(f.writing.accept(f.scope, draft.id)).rejects.toMatchObject({
    statusCode: 409,
  });
});
test("rewritten new-chapter drafts share the preallocated target and cannot create duplicate chapters", async () => {
  const f = await fixture();
  const a = await f.writing.submit(f.input);
  const b = await f.writing.submit({
    ...f.input,
    clientRequestId: randomUUID(),
    feedbackDraftId: a.id,
    message: "改写",
  });
  expect(b.targetId).toBe(a.targetId);
  await f.writing.accept(f.scope, b.id);
  await expect(f.writing.accept(f.scope, a.id)).rejects.toMatchObject({
    statusCode: 409,
  });
  expect(
    (await f.content.list({ projectId: f.scope.id, kind: "chapter" })).items,
  ).toHaveLength(1);
});
test("model output budget is fixed in the persisted request before dispatch", async () => {
  const f = await fixture();
  const d = await f.writing.submit(f.input);
  expect(d.maxOutputTokens).toBe(4000);
});

test("manifest roundtrip preserves generated chapters with equal order using stable IDs", async () => {
  const { exportFiles } = await import("../src/server/export.js");
  const { importFiles, preflight } = await import("../src/server/import.js");
  const f = await fixture();
  await f.content.commit(
    {
      ...entity(
        "chapter",
        {
          name: "原章",
          markdown: "原章正文",
          genres: [],
          ageBand: "",
          sourceMetadata: {},
        },
        f.scope.id,
      ),
      order: 3,
    },
    null,
  );
  const draft = await f.writing.submit(f.input);
  await f.writing.accept(f.scope, draft.id);
  const bundle = await exportFiles(f.content);
  expect(
    preflight(bundle, "roundtrip").filter((d) => d.kind === "chapter"),
  ).toHaveLength(2);
  const restored = new MemoryStore();
  await importFiles(restored, bundle, "roundtrip");
  const before = (
      await f.content.list({ projectId: f.scope.id, kind: "chapter" })
    ).items,
    after = (await restored.list({ projectId: f.scope.id, kind: "chapter" }))
      .items;
  expect(after.map((d) => [d.id, d.order, d.content])).toEqual(
    before.map((d) => [d.id, d.order, d.content]),
  );
});

test("legacy Markdown still rejects duplicate chapter order without a manifest", async () => {
  const { readBundle } = await import("../src/server/filesystem.js");
  const { preflight } = await import("../src/server/import.js");
  const bundle = await readBundle("tests/fixtures/novel");
  const duplicate = bundle.map((f) =>
    f.path.endsWith("/ch02.md")
      ? { ...f, text: "---\norder: 1\n---\n" + f.text }
      : f,
  );
  expect(() => preflight(duplicate, "legacy-duplicate")).toThrow(
    "章节顺序缺失或重复",
  );
});
