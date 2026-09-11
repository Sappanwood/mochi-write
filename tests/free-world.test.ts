import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { FreeSession } from "../src/server/free-session.js";
import { candidateTool } from "../src/server/free-candidate-tools.js";
import { MemoryStore } from "./support/memory-store.js";
import { MemoryFreeStore } from "./support/free-store.js";
import { entity } from "../src/server/entities.js";
import { freeDigest } from "../src/server/free-references.js";
import type { ExactRef, FreeTask } from "../src/shared/free.js";
export const worldContent = (name = "雾海") => ({
  name,
  markdown: "雾海群岛\r\n有三座灯塔。\n",
  genres: ["奇幻"],
  ageBand: "",
  sourceMetadata: {},
});
export async function worldFixture() {
  const content = new MemoryStore(),
    records = new MemoryFreeStore();
  const calls: { path: string; input: unknown }[] = [];
  const free = new FreeSession(
    content,
    records,
    {
      async request<T>(path: string, input?: unknown): Promise<T> {
        calls.push({ path, input });
        if (path === "/v1/models")
          return { models: [{ provider: "fake", id: "fake" }] } as T;
        if (path === "/v1/sessions") return { session_id: randomUUID() } as T;
        throw Error("No model");
      },
    },
    { autoStart: false },
  );
  const start = await free.start({
    clientRequestId: randomUUID(),
    message: "构思世界观",
    provider: "fake",
    model: "fake",
  });
  return { content, records, free, calls, ...start };
}
export async function worldResolve(
  free: FreeSession,
  task: FreeTask,
  intent = "draft",
  mode = "new",
  predicates: unknown[] = [],
) {
  const evidence = {
    start: 0,
    end: task.input.message.length,
    text: task.input.message,
  };
  return free.resolve(
    task.id,
    {
      intent,
      evidence,
      target: { mode, kind: "world", predicates },
      ...(intent === "update_world" ? { changeEvidence: evidence } : {}),
    },
    randomUUID(),
  );
}
export async function worldNext(
  free: FreeSession,
  id: string,
  message: string,
  refs: ExactRef[] = [],
) {
  return free.submit(id, {
    clientRequestId: randomUUID(),
    message,
    provider: "fake",
    model: "fake",
    refs,
  });
}
export async function worldDraft(
  free: FreeSession,
  task: FreeTask,
  args: Record<string, unknown> = {},
  invocationId = randomUUID(),
) {
  const result = await candidateTool(
    free,
    task,
    "save_world",
    {
      mode: "draft",
      name: "雾海",
      markdown: "完整世界设定\r\n",
      genres: ["奇幻"],
      ...args,
    },
    invocationId,
  );
  return free.candidates.get(
    task.conversationId,
    (result.data as { draft_id: string }).draft_id,
  );
}
it("new world-capable conversations retain exact eleven-tool snapshots while old conversations retain ten", async () => {
  const f = await worldFixture();
  expect(f.conversation).toHaveProperty("toolsetVersion", "world-v1");
  await f.free.workflow.session(f.task);
  const snapshot = (
    f.calls.find((c) => c.path === "/v1/sessions")!.input as {
      tools: { name: string; version: string }[];
    }
  ).tools;
  expect(snapshot).toHaveLength(11);
  expect(snapshot[5]).toMatchObject({
    name: "discover_artifacts",
    version: "3",
  });
  expect(snapshot[10]!.name).toBe("save_world");
  const old = await worldFixture();
  const c = await old.free.conversation(old.conversation.id);
  const legacy = { ...c };
  delete (legacy as { toolsetVersion?: string }).toolsetVersion;
  await old.records.transaction("library", [
    { record: legacy, revision: c.revision },
  ]);
  await old.free.workflow.session(old.task);
  expect(
    (
      old.calls.find((c) => c.path === "/v1/sessions")!.input as {
        tools: unknown[];
      }
    ).tools,
  ).toHaveLength(10);
  const blocked = await worldResolve(old.free, old.task);
  expect(blocked.state).toBe("clarifying");
  expect(blocked.error).toBe("world_creation_unavailable");
  expect(blocked.binding).toBeUndefined();
});
it("world preview and interleaved groups preserve old exact content without formal writes", async () => {
  const f = await worldFixture(),
    t = await worldResolve(f.free, f.task);
  expect(t.state).toBe("authorized");
  expect(t.binding).toBeUndefined();
  expect(t.draftContext?.mode).toBe("new_world");
  const a = await worldDraft(f.free, t),
    b = await worldDraft(f.free, t, { name: "星海" });
  const next = await worldNext(
    f.free,
    t.conversationId,
    "改写雾海候选，仅预览",
    [f.free.candidates.ref(a)],
  );
  const rewrite = await worldResolve(f.free, next, "draft", "explicit");
  const a2 = await worldDraft(f.free, rewrite, {
    group_id: a.groupId,
    parent_ref: f.free.candidates.ref(a),
    markdown: "新版",
  });
  expect([a.ordinal, b.ordinal, a2.ordinal]).toEqual([1, 1, 2]);
  expect(a2.groupId).toBe(a.groupId);
  expect(a.groupId).not.toBe(b.groupId);
  expect(
    (await f.free.candidates.read(t.conversationId, f.free.candidates.ref(a)))
      .content.markdown,
  ).toBe("完整世界设定\r\n");
  expect(f.content.heads.size).toBe(0);
  const found = await candidateTool(
    f.free,
    rewrite,
    "discover_artifacts",
    { query: "", kind: "world" },
    "discover",
  );
  expect((found.data as { items: unknown[] }).items).toHaveLength(3);
  const save = await worldNext(f.free, t.conversationId, "原样保存旧稿", [
    f.free.candidates.ref(a),
  ]);
  const bound = await worldResolve(f.free, save, "save_current", "explicit");
  expect(bound.binding).toMatchObject({
    action: "create_world",
    target: { kind: "world" },
    selectedDraft: f.free.candidates.ref(a),
  });
  expect(f.content.heads.size).toBe(0);
});
it("world update preview preserves legacy metadata and fixed base while omitting character-only fields", async () => {
  const f = await worldFixture();
  const master = await f.content.commit(
    entity("world", {
      ...worldContent(),
      ageBand: "成年",
      sourceMetadata: {
        legacy: { nested: true },
        era: "古代",
        tags: ["群岛"],
        world: "雾海",
      },
    }),
    null,
  );
  const ref: ExactRef = {
    type: "asset",
    kind: "world",
    asset_id: master.id,
    revision: master.revision,
    version: 1,
    content_hash: freeDigest(master.content),
  };
  const task = await worldNext(f.free, f.conversation.id, "改写雾海，只预览", [
    ref,
  ]);
  const resolved = await worldResolve(f.free, task, "draft", "explicit");
  const d = await worldDraft(f.free, resolved, { name: "雾海新版" });
  expect(d.payload.content).toMatchObject({
    ageBand: "成年",
    sourceMetadata: {
      legacy: { nested: true },
      era: "古代",
      tags: ["群岛"],
      world: "雾海新版",
    },
  });
  expect(d.payload.draftContext).toMatchObject({
    mode: "existing_world",
    target: { kind: "world", asset_id: master.id },
    baseRevision: master.revision,
  });
  expect((await f.content.get(master.id, null))?.revision).toBe(
    master.revision,
  );
  await expect(
    worldDraft(f.free, resolved, { gender: "女" }),
  ).rejects.toThrow();
  await expect(
    worldDraft(f.free, resolved, { genres: ["非法题材"] }),
  ).rejects.toThrow();
  await expect(
    worldDraft(f.free, resolved, { markdown: "文".repeat(17000) }),
  ).rejects.toThrow();
});
it("world target search binds only a complete unique verified master and rejects ambiguity", async () => {
  const f = await worldFixture();
  await f.content.commit(entity("world", worldContent()), null);
  const message = "找到雾海世界观，更新设定并保存";
  const predicates = [
    {
      field: "name",
      operator: "eq",
      value: "雾海",
      evidence: { start: 2, end: 4, text: "雾海" },
    },
  ];
  const t = await worldNext(f.free, f.conversation.id, message);
  const result = await worldResolve(
    f.free,
    t,
    "update_world",
    "search",
    predicates,
  );
  expect(result.binding).toMatchObject({
    action: "update_world",
    target: { kind: "world" },
  });
  await f.free.cancel(t.id);
  await f.content.commit(entity("world", worldContent()), null);
  const next = await worldNext(f.free, f.conversation.id, message);
  const ambiguous = await worldResolve(
    f.free,
    next,
    "update_world",
    "search",
    predicates,
  );
  expect(ambiguous.state).toBe("clarifying");
  expect(ambiguous.binding).toBeUndefined();
});
it("world candidate used as material for a new world never inherits an existing update target", async () => {
  const f = await worldFixture(),
    t = await worldResolve(f.free, f.task);
  const a = await worldDraft(f.free, t);
  const next = await worldNext(
    f.free,
    t.conversationId,
    "参考这个另建全新世界，仅预览",
    [f.free.candidates.ref(a)],
  );
  const resolved = await worldResolve(f.free, next);
  expect(resolved.draftContext).toMatchObject({
    mode: "new_world",
    baseRevision: null,
  });
  expect(resolved.draftContext?.reference).toBeUndefined();
  const b = await worldDraft(f.free, resolved, { name: "新世界" });
  expect(b.groupId).not.toBe(a.groupId);
  const wrong = await f.free.change(resolved.id, (task) => {
    task.draftContext = { mode: "new_character", baseRevision: null };
  });
  await expect(worldDraft(f.free, wrong)).rejects.toThrow("forbidden_scope");
});
