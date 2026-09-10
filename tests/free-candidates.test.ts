import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { FreeSession } from "../src/server/free-session.js";
import { MemoryStore } from "./support/memory-store.js";
import { MemoryFreeStore } from "./support/free-store.js";
async function fixture() {
  const free = new FreeSession(
    new MemoryStore(),
    new MemoryFreeStore(),
    {
      async request() {
        throw Error("No model");
      },
    },
    { autoStart: false },
  );
  const { task } = await free.start({
    clientRequestId: randomUUID(),
    message: "讨论角色",
    provider: "fake",
    model: "fake",
  });
  await free.change(task.id, (t) => {
    t.draftContext = { mode: "new_character", baseRevision: null };
    t.state = "authorized";
  });
  return { free, task: await free.task(task.id) };
}
const content = (name: string) => ({
  name,
  markdown: name,
  genres: [],
  ageBand: "",
  sourceMetadata: {},
});
it("allocates independent ordinals and restores immutable old candidates by exact hash", async () => {
  const { free, task } = await fixture();
  const a = await free.candidates.freeze(
    task,
    { artifactKind: "character", content: content("甲") },
    "a",
  );
  const b = await free.candidates.freeze(
    task,
    { artifactKind: "character", content: content("乙") },
    "b",
  );
  const a2 = await free.candidates.freeze(
    task,
    {
      artifactKind: "character",
      content: content("甲2"),
      group_id: a.groupId,
      parent_ref: free.candidates.ref(a),
    },
    "a2",
  );
  expect([a.ordinal, b.ordinal, a2.ordinal]).toEqual([1, 1, 2]);
  expect(a.groupId).not.toBe(b.groupId);
  expect(
    (await free.candidates.read(task.conversationId, free.candidates.ref(a)))
      .content.markdown,
  ).toBe("甲");
  expect(
    await free.candidates.freeze(
      task,
      { artifactKind: "character", content: content("甲") },
      "a",
    ),
  ).toEqual(a);
  await expect(
    free.candidates.freeze(
      task,
      { artifactKind: "character", content: content("换稿") },
      "a",
    ),
  ).rejects.toThrow("operation_conflict");
  await expect(
    free.candidates.read(randomUUID(), free.candidates.ref(a)),
  ).rejects.toThrow("forbidden_scope");
  await expect(
    free.candidates.read(task.conversationId, {
      ...free.candidates.ref(a),
      draft_hash: "sha256:" + "0".repeat(64),
    }),
  ).rejects.toThrow("draft_conflict");
  expect((await free.task(task.id)).binding).toBeUndefined();
});
it("rejects invalid parent/group combinations and bounds each task to eight candidates", async () => {
  const { free, task } = await fixture();
  const a = await free.candidates.freeze(
    task,
    { artifactKind: "character", content: content("甲") },
    "a",
  );
  await expect(
    free.candidates.freeze(
      task,
      {
        artifactKind: "character",
        content: content("甲"),
        group_id: a.groupId,
      },
      "bad",
    ),
  ).rejects.toThrow();
  for (let i = 1; i < 8; i++)
    await free.candidates.freeze(
      task,
      { artifactKind: "character", content: content(String(i)) },
      String(i),
    );
  await expect(
    free.candidates.freeze(
      task,
      { artifactKind: "character", content: content("9") },
      "9",
    ),
  ).rejects.toThrow("result_too_large");
});
it("does not allow freezing an unresolved task even with a context", async () => {
  const { free, task } = await fixture();
  await free.change(task.id, (t) => {
    t.state = "unresolved";
  });
  await expect(
    free.candidates.freeze(
      await free.task(task.id),
      { artifactKind: "character", content: content("甲") },
      "early",
    ),
  ).rejects.toThrow("task_closed");
});
it("records exact candidate reads and explicit sends without authorizing or changing the original candidate", async () => {
  const { free, task } = await fixture();
  const { candidateTool } =
    await import("../src/server/free-candidate-tools.js");
  const d = await free.candidates.freeze(
    task,
    { artifactKind: "character", content: content("甲") },
    "a",
  );
  const found = await candidateTool(
    free,
    task,
    "discover_artifacts",
    { query: "甲" },
    "find",
  );
  expect(found.data).toMatchObject({ items: [{ draft_id: d.id }] });
  expect(await free.references.sources(task.conversationId)).toHaveLength(0);
  await candidateTool(
    free,
    task,
    "read_artifact",
    { draft_id: d.id, draft_revision: "1", draft_hash: d.draftHash },
    "read",
  );
  expect(await free.references.sources(task.conversationId)).toMatchObject([
    { origin: "agent_read", ref: free.candidates.ref(d) },
  ]);
  const input = {
    clientRequestId: randomUUID(),
    message: "普通文字 @甲",
    provider: "fake",
    model: "fake",
    refs: [free.candidates.ref(d)],
  };
  const next = await free.submit(task.conversationId, input);
  expect(next.input.refs).toEqual(input.refs);
  expect(next.binding).toBeUndefined();
  expect(await free.submit(task.conversationId, input)).toEqual(next);
  expect(
    (await free.references.sources(task.conversationId)).filter(
      (s) => s.task_id === next.id,
    ),
  ).toMatchObject([{ origin: "explicit", ref: input.refs[0] }]);
  await expect(
    free.candidates.freeze(
      task,
      { artifactKind: "character", content: content("迟到") },
      "late",
    ),
  ).rejects.toThrow("authorization_revoked");
});
it("concurrent group revisions allocate once and retry with the original invocation", async () => {
  const { free, task } = await fixture();
  const d = await free.candidates.freeze(
    task,
    { artifactKind: "character", content: content("甲") },
    "a",
  );
  const raw = {
    artifactKind: "character" as const,
    content: content("甲2"),
    group_id: d.groupId,
    parent_ref: free.candidates.ref(d),
  };
  const results = await Promise.allSettled([
    free.candidates.freeze(task, raw, "b"),
    free.candidates.freeze(task, raw, "c"),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const retry = results[0].status === "rejected" ? "b" : "c";
  expect((await free.candidates.freeze(task, raw, retry)).ordinal).toBe(3);
});
it("freezes story members and derivation independently and refuses cross-group parents", async () => {
  const { free, task } = await fixture();
  const a = await free.candidates.freeze(
    task,
    { artifactKind: "character", content: content("甲") },
    "a",
  );
  const b = await free.candidates.freeze(
    task,
    { artifactKind: "character", content: content("乙") },
    "b",
  );
  await expect(
    free.candidates.freeze(
      task,
      {
        artifactKind: "character",
        content: content("变更"),
        group_id: b.groupId,
        parent_ref: free.candidates.ref(a),
      },
      "bad",
    ),
  ).rejects.toThrow("draft_conflict");
  await free.change(task.id, (t) => {
    t.draftContext = {
      mode: "new_story",
      baseRevision: null,
      target: { kind: "story", story_id: randomUUID() },
    };
  });
  const storyTask = await free.task(task.id);
  const member = {
    member_id: randomUUID(),
    kind: "snapshot",
    content: content("甲"),
    sourceRef: free.candidates.ref(a),
  };
  const story = await free.candidates.freeze(
    storyTask,
    {
      artifactKind: "story_initialization",
      content: content("故事"),
      derived_from: free.candidates.ref(a),
    },
    "story",
    { members: [member], business: { chapter: { body: "first" } } },
  );
  member.content.markdown = "changed";
  expect(
    (
      await free.candidates.read(task.conversationId, {
        ...free.candidates.ref(story),
        member_id: member.member_id,
      })
    ).content.markdown,
  ).toBe("甲");
  expect(story.ordinal).toBe(1);
  expect(story.groupId).not.toBe(a.groupId);
  await expect(
    free.candidates.read(task.conversationId, {
      ...free.candidates.ref(story),
      member_id: randomUUID(),
    }),
  ).rejects.toThrow("reference_unavailable");
});
it("draft tool validates full character content and preserves existing metadata without writes", async () => {
  const { free, task } = await fixture();
  const { candidateTool } =
    await import("../src/server/free-candidate-tools.js");
  const { entity } = await import("../src/server/entities.js");
  const doc = await free.content.commit(
    entity("character", {
      ...content("旧"),
      sourceMetadata: { legacy: { nested: "preserved" }, occupation: "侦探" },
    }),
    null,
  );
  await free.change(task.id, (t) => {
    t.draftContext = {
      mode: "existing_character",
      target: { kind: "character", asset_id: doc.id },
      baseRevision: doc.revision,
    };
  });
  const current = await free.task(task.id),
    args = {
      mode: "draft",
      name: " 新 ",
      markdown: "new\r\nbody",
      genres: [],
      age_band: "",
    };
  const result = await candidateTool(
    free,
    current,
    "save_character",
    args,
    "draft",
  );
  const summary = result.data as { draft_id: string };
  const d = await free.candidates.get(task.conversationId, summary.draft_id);
  expect(d.payload.content).toMatchObject({
    name: "新",
    markdown: "new\r\nbody",
    sourceMetadata: { legacy: { nested: "preserved" }, occupation: "侦探" },
  });
  expect((await free.content.get(doc.id, null))?.revision).toBe(doc.revision);
  expect((await free.task(task.id)).binding).toBeUndefined();
  await expect(
    candidateTool(
      free,
      current,
      "save_character",
      { ...args, genres: ["not valid"] },
      "bad",
    ),
  ).rejects.toThrow();
  await expect(
    candidateTool(
      free,
      current,
      "save_character",
      { ...args, markdown: "文".repeat(17000) },
      "large",
    ),
  ).rejects.toThrow();
});
it("allows several reference materials while save_current binds only the selected candidate", async () => {
  const { free, task } = await fixture();
  const { entity } = await import("../src/server/entities.js");
  const d = await free.candidates.freeze(
    task,
    { artifactKind: "character", content: content("甲") },
    "a",
  );
  const material = await free.content.commit(
    entity("world", content("背景")),
    null,
  );
  const { freeDigest } = await import("../src/server/free-references.js");
  const message = "保存选定角色稿";
  const next = await free.submit(task.conversationId, {
    clientRequestId: randomUUID(),
    message,
    provider: "fake",
    model: "fake",
    refs: [
      free.candidates.ref(d),
      {
        type: "asset",
        kind: "world",
        asset_id: material.id,
        revision: material.revision,
        version: material.currentVersion,
        content_hash: freeDigest(material.content),
      },
    ],
  });
  const resolved = await free.resolve(
    next.id,
    {
      intent: "save_current",
      evidence: { start: 0, end: message.length, text: message },
      target: { mode: "new", kind: "character", predicates: [] },
    },
    randomUUID(),
  );
  expect(resolved.binding?.action).toBe("create_character");
  expect(resolved.binding?.selectedDraft).toEqual(free.candidates.ref(d));
  expect(resolved.binding?.target.kind).toBe("character");
  expect((await free.content.get(material.id, null))?.revision).toBe(
    material.revision,
  );
});
it("candidate target predicates still reject a mismatching name with extra background refs", async () => {
  const { free, task } = await fixture();
  const d = await free.candidates.freeze(
    task,
    { artifactKind: "character", content: content("甲") },
    "a",
  );
  const message = "保存乙的角色稿";
  const next = await free.submit(task.conversationId, {
    clientRequestId: randomUUID(),
    message,
    provider: "fake",
    model: "fake",
    refs: [free.candidates.ref(d)],
  });
  const resolved = await free.resolve(
    next.id,
    {
      intent: "save_current",
      evidence: { start: 0, end: message.length, text: message },
      target: {
        mode: "new",
        kind: "character",
        predicates: [
          {
            field: "name",
            operator: "eq",
            value: "乙",
            evidence: { start: 2, end: 3, text: "乙" },
          },
        ],
      },
    },
    randomUUID(),
  );
  expect(resolved.state).toBe("clarifying");
  expect(resolved.binding).toBeUndefined();
});
it("never replaces an immutable candidate through the underlying transaction", async () => {
  const { free, task } = await fixture();
  const d = await free.candidates.freeze(
    task,
    { artifactKind: "character", content: content("甲") },
    "a",
  );
  await expect(
    free.records.transaction("library", [
      { record: { ...d, title: "changed" }, revision: d.revision },
    ]),
  ).rejects.toThrow("invalid_free_transaction");
});
