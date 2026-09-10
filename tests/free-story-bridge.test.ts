import { freeDigest } from "../src/server/free-references.js";
import { entity } from "../src/server/entities.js";
import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { FreeSession } from "../src/server/free-session.js";
import { candidateTool } from "../src/server/free-candidate-tools.js";
import type { ExactRef, FreeTask } from "../src/shared/free.js";
import type { Candidate } from "../src/shared/free-candidates.js";
import { MemoryStore } from "./support/memory-store.js";
import { MemoryFreeStore } from "./support/free-store.js";
function fixture() {
  const content = new MemoryStore(),
    records = new MemoryFreeStore(content);
  const free = new FreeSession(
    content,
    records,
    {
      async request() {
        throw Error("No model");
      },
    },
    { autoStart: false },
  );
  return { free, content, records };
}
async function begin(
  free: FreeSession,
  intent: string,
  kind: string,
  refs: ExactRef[] = [],
  conversationId?: string,
  chapter = false,
  mode = "new",
) {
  const message = chapter ? "新建故事并保存首章" : "创作并保存";
  const input = {
    clientRequestId: randomUUID(),
    message,
    provider: "fake",
    model: "fake",
    refs,
  };
  const task = conversationId
    ? await free.submit(conversationId, input)
    : (await free.start(input)).task;
  return free.resolve(
    task.id,
    {
      intent,
      evidence: { start: 0, end: message.length, text: message },
      target: { mode, kind, predicates: [] },
      ...(chapter
        ? { chapterEvidence: { start: 5, end: 9, text: "保存首章" } }
        : {}),
    },
    "classifier",
  );
}
async function draft(
  free: FreeSession,
  t: FreeTask,
  tool: string,
  args: Record<string, unknown>,
) {
  const result = await candidateTool(
    free,
    t,
    tool,
    { mode: "draft", ...args },
    randomUUID(),
  );
  return free.candidates.get(
    t.conversationId,
    (result.data as { draft_id: string }).draft_id,
  );
}
async function commit(
  free: FreeSession,
  t: FreeTask,
  d: Candidate,
  tool = "initialize_story",
) {
  return candidateTool(
    free,
    t,
    tool,
    {
      mode: "commit",
      draft_id: d.id,
      draft_revision: "1",
      draft_hash: d.draftHash,
    },
    randomUUID(),
  );
}
it.each([false, true])(
  "direct initialization binds precisely includes chapter=%s",
  async (chapter) => {
    const { free, content } = fixture(),
      t = await begin(
        free,
        "initialize_story",
        "story",
        [],
        undefined,
        chapter,
      );
    expect(t.binding?.action).toBe(
      chapter ? "save_first_chapter" : "initialize_story",
    );
    const d = await draft(free, t, "initialize_story", {
      title: "新故事",
      assets: [],
      ...(chapter ? { chapter: { title: "首章", body: "正文" } } : {}),
    });
    const r = await commit(free, t, d);
    expect(r).toMatchObject({
      receipt: { kind: chapter ? "first_chapter_saved" : "story_initialized" },
    });
    expect(content.heads.size).toBe(chapter ? 2 : 1);
  },
);
it("previews a new story from an unsaved old character draft without binding or changing its group", async () => {
  const { free, content } = fixture(),
    t = await begin(free, "draft", "character");
  const a = await draft(free, t, "save_character", {
    name: "甲",
    markdown: "旧稿",
    genres: [],
    age_band: "",
  });
  const next = await begin(
    free,
    "draft",
    "story",
    [free.candidates.ref(a)],
    t.conversationId,
  );
  expect(next.state).toBe("authorized");
  expect(next.binding).toBeUndefined();
  expect(next.draftContext?.mode).toBe("new_story");
  const d = await draft(free, next, "initialize_story", {
    title: "新故事",
    assets: [{ kind: "snapshot", candidate_ref: free.candidates.ref(a) }],
  });
  expect(d.groupId).not.toBe(a.groupId);
  expect(d.payload.members?.[0]?.content).toEqual(a.payload.content);
  await expect(commit(free, next, d)).rejects.toThrow("authorization_required");
  const save = await begin(
    free,
    "save_current",
    "story",
    [free.candidates.ref(d)],
    t.conversationId,
  );
  await commit(free, save, d);
  expect(content.heads.size).toBe(2);
});

it("requires explicit derivation explanation when extracting a story member into a master", async () => {
  const { free } = fixture(),
    t = await begin(free, "draft", "story");
  const pack = await draft(free, t, "initialize_story", {
    title: "故事",
    assets: [{ kind: "snapshot", title: "角色", body: "剧情角色" }],
  });
  const source = {
    ...free.candidates.ref(pack),
    member_id: pack.payload.members![0]!.member_id,
  };
  const next = await begin(
    free,
    "draft",
    "character",
    [source],
    t.conversationId,
  );
  await expect(
    draft(free, next, "save_character", {
      name: "角色",
      markdown: "独立正文",
      genres: [],
      age_band: "",
      derived_from: source,
    }),
  ).rejects.toThrow("derivation_required");
});

it("freezes old candidate content across rewrites and independently creates a master from its story snapshot", async () => {
  const { free, content } = fixture(),
    t = await begin(free, "draft", "character");
  const a = await draft(free, t, "save_character", {
    name: "甲",
    markdown: "旧稿",
    genres: [],
    age_band: "",
  });
  const t2 = await begin(
    free,
    "draft",
    "story",
    [free.candidates.ref(a)],
    t.conversationId,
  );
  const d = await draft(free, t2, "initialize_story", {
    title: "故事",
    assets: [{ kind: "snapshot", candidate_ref: free.candidates.ref(a) }],
    chapter: { title: "首章", body: "剧情" },
  });
  const t3 = await begin(
    free,
    "draft",
    "character",
    [free.candidates.ref(a)],
    t.conversationId,
  );
  await draft(free, t3, "save_character", {
    name: "甲",
    markdown: "新稿",
    genres: [],
    age_band: "",
    group_id: a.groupId,
    parent_ref: free.candidates.ref(a),
  });
  const save = await begin(
    free,
    "save_current",
    "story",
    [free.candidates.ref(d)],
    t.conversationId,
  );
  const result = await commit(free, save, d);
  expect(result).toMatchObject({ receipt: { kind: "first_chapter_saved" } });
  const snapshot = [...content.heads.values()].find(
    (e) => e.kind === "snapshot",
  )!;
  expect(snapshot.content).toEqual(a.payload.content);
  expect(snapshot.sourceAssetId).toBeUndefined();
  expect(d.payload.members![0]!.sourceRef).toEqual(free.candidates.ref(a));
  const source = {
    type: "asset" as const,
    kind: "snapshot" as const,
    asset_id: snapshot.id,
    story_id: snapshot.projectId!,
    revision: snapshot.revision,
    version: snapshot.currentVersion,
    content_hash: freeDigest(snapshot.content),
  };
  const reverse = await begin(
    free,
    "draft",
    "character",
    [source],
    t.conversationId,
  );
  const derivation = {
    source_ref: source,
    retained: ["稳定属性"],
    rewritten: ["故事背景改为独立经历"],
    excluded: ["剧情关系"],
  };
  const master = await draft(free, reverse, "save_character", {
    name: "甲",
    markdown: "独立完整角色正文",
    genres: [],
    age_band: "",
    derived_from: source,
    derivation,
  });
  expect(master.payload.business?.derivation).toEqual(derivation);
  const authorized = await begin(
    free,
    "save_current",
    "character",
    [free.candidates.ref(master)],
    t.conversationId,
  );
  await commit(free, authorized, master, "save_character");
  expect(await content.get(snapshot.id, snapshot.projectId)).toEqual(snapshot);
  const story = (await content.get(snapshot.projectId!, snapshot.projectId))!;
  const storyRef = {
    type: "asset" as const,
    kind: "story" as const,
    asset_id: story.id,
    story_id: story.id,
    revision: story.revision,
    version: story.currentVersion,
    content_hash: freeDigest(story.content),
  };
  const continuation = await begin(
    free,
    "create_chapter",
    "story",
    [storyRef],
    t.conversationId,
    false,
    "explicit",
  );
  const ch = await draft(free, continuation, "create_chapter", {
    title: "第二章",
    body: "后续正文",
  });
  const saved = await commit(free, continuation, ch, "create_chapter");
  expect(saved).toMatchObject({
    receipt: {
      kind: "chapter_created",
      chapter: { chapter_id: continuation.draftContext!.chapterId },
    },
  });
  expect(
    (await content.list({ projectId: story.id, kind: "chapter" })).items
      .map((e) => e.order)
      .sort(),
  ).toEqual([1, 2]);
});
it.each(["claim", "ledger", "business", "projection"])(
  "recovers original story OP after lost %s response and rejects another draft",
  async (fault) => {
    const { free, records, content } = fixture(),
      t = await begin(free, "initialize_story", "story");
    const a = await draft(free, t, "initialize_story", {
        title: "甲",
        assets: [],
      }),
      b = await draft(free, t, "initialize_story", { title: "乙", assets: [] });
    const original = records.transaction.bind(records);
    const hook = vi
      .spyOn(records, "transaction")
      .mockImplementation(async (p, w, c, s) => {
        const result = await original(p, w, c, s);
        if (
          (fault === "claim" && w.some((x) => x.record.kind === "claim")) ||
          (fault === "ledger" &&
            p !== "library" &&
            !s &&
            w.some((x) => x.record.kind === "op" && !!x.record.draftRef)) ||
          (fault === "business" && s) ||
          (fault === "projection" &&
            w.some((x) => x.record.kind === "task" && !!x.record.receipt))
        )
          throw Error("lost response");
        return result;
      });
    await commit(free, t, a).catch((e) =>
      expect(e.message).toBe("lost response"),
    );
    hook.mockRestore();
    await expect(commit(free, t, b)).rejects.toThrow("operation_conflict");
    expect(await records.get("library", "claim", b.id)).toBeUndefined();
    const result = await commit(free, t, a);
    expect(result).toMatchObject({
      receipt: { draft_id: a.id, kind: "story_initialized" },
    });
    expect(content.heads.size).toBe(1);
    expect(content.history.size).toBe(1);
    expect((await free.operation(t.operationId)).receipt).toEqual(
      (result as { receipt: unknown }).receipt,
    );
  },
);
it.each(["cancel", "commit"])(
  "story OP CAS resolves concurrent %s winner without partial assets",
  async (winner) => {
    const { free, records, content } = fixture(),
      t = await begin(free, "initialize_story", "story", [], undefined, true);
    const d = await draft(free, t, "initialize_story", {
      title: "故事",
      assets: [{ kind: "setting", title: "设定", body: "内容" }],
      chapter: { title: "首章", body: "正文" },
    });
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => (enter = r)),
      proceed = new Promise<void>((r) => (release = r)),
      original = records.transaction.bind(records);
    vi.spyOn(records, "transaction").mockImplementation(async (p, w, c, s) => {
      if (s) {
        enter();
        await proceed;
      }
      return original(p, w, c, s);
    });
    const pending = commit(free, t, d).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await entered;
    if (winner === "cancel") {
      await free.cancel(t.id);
      release();
    } else {
      release();
      await pending;
      await free.cancel(t.id);
    }
    const result = await pending;
    expect((await free.operation(t.operationId)).status).toBe(
      winner === "cancel" ? "revoked" : "committed",
    );
    expect(content.heads.size).toBe(winner === "cancel" ? 0 : 3);
    if (winner === "cancel")
      expect(result).toMatchObject({
        error: { message: "authorization_revoked" },
      });
  },
);
it("different story drafts competing for one OP freeze only one directory/claim", async () => {
  const { free, records, content } = fixture(),
    t = await begin(free, "initialize_story", "story");
  const a = await draft(free, t, "initialize_story", {
      title: "甲",
      assets: [],
    }),
    b = await draft(free, t, "initialize_story", { title: "乙", assets: [] });
  const results = await Promise.allSettled([
    commit(free, t, a),
    commit(free, t, b),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { message: "operation_conflict" },
  });
  const receipt = (await free.operation(t.operationId)).receipt!;
  expect(
    await records.get(
      "library",
      "claim",
      receipt.draft_id === a.id ? b.id : a.id,
    ),
  ).toBeUndefined();
  expect(content.heads.size).toBe(1);
});
it("copies a read master version completely and never refreshes its frozen snapshot", async () => {
  const { free, content } = fixture();
  const old = await content.commit(
    entity("character", {
      name: "母版",
      markdown: "正文\r\n",
      genres: [],
      ageBand: "",
      sourceMetadata: { legacy: { unknown: 7 }, occupation: "侦探" },
    }),
    null,
  );
  const source = {
    type: "asset" as const,
    kind: "character" as const,
    asset_id: old.id,
    revision: old.revision,
    version: 1,
    content_hash: freeDigest(old.content),
  };
  const t = await begin(free, "initialize_story", "story", [source]);
  await content.commit(
    {
      ...old,
      content: { ...old.content, markdown: "later" },
      currentVersion: 2,
    },
    old.revision,
  );
  const d = await draft(free, t, "initialize_story", {
    title: "故事",
    assets: [
      {
        kind: "snapshot",
        source_id: old.id,
        source_version: 1,
        source_hash: source.content_hash,
      },
    ],
  });
  await commit(free, t, d);
  const copy = [...content.heads.values()].find((e) => e.kind === "snapshot")!;
  expect(copy.content).toEqual(old.content);
  expect(copy.sourceAssetId).toBe(old.id);
  expect(copy.sourceVersion).toBe(1);
  const current = (await content.get(old.id, null))!;
  await content.commit(
    {
      ...current,
      currentVersion: 3,
      content: { ...current.content, markdown: "even later" },
    },
    current.revision,
  );
  expect(await content.get(copy.id, copy.projectId)).toEqual(copy);
});
it("rejects cross-target drafts, changed heads and initializing stories with chapters", async () => {
  const { free, content } = fixture(),
    t = await begin(free, "initialize_story", "story"),
    d = await draft(free, t, "initialize_story", { title: "故事", assets: [] });
  const other = await begin(free, "initialize_story", "story");
  await expect(commit(free, other, d)).rejects.toThrow("forbidden_scope");
  const target = t.binding!.target;
  if (target.kind !== "story") throw Error();
  await content.commit(
    {
      ...entity("story", d.payload.content, target.story_id, target.story_id),
      status: "ready",
    },
    null,
  );
  await expect(commit(free, t, d)).rejects.toThrow("revision_conflict");
  expect((await free.operation(t.operationId)).status).toBe("conflict");
  const story = (await content.get(target.story_id, target.story_id))!;
  await content.commit(
    { ...entity("chapter", d.payload.content, story.id), order: 1 },
    null,
  );
  const ref = {
    type: "asset" as const,
    kind: "story" as const,
    asset_id: story.id,
    story_id: story.id,
    revision: story.revision,
    version: 1,
    content_hash: freeDigest(story.content),
  };
  const preview = await begin(
    free,
    "draft",
    "story",
    [ref],
    undefined,
    false,
    "explicit",
  );
  await expect(
    draft(free, preview, "initialize_story", {
      title: "bad",
      assets: [],
      chapter: { title: "chapter", body: "body" },
    }),
  ).rejects.toThrow("forbidden_scope");
});
it("Cosmos story batch contains only target OP and complete business versions/heads; library owns claim", async () => {
  const { free, records } = fixture(),
    t = await begin(free, "initialize_story", "story", [], undefined, true);
  const d = await draft(free, t, "initialize_story", {
    title: "故事",
    assets: [{ kind: "snapshot", title: "角色", body: "资料" }],
    chapter: { title: "首章", body: "正文" },
  });
  const original = records.transaction.bind(records);
  let observed: Parameters<typeof records.transaction> | undefined;
  vi.spyOn(records, "transaction").mockImplementation(async (...args) => {
    if (args[3]) observed = args;
    return original(...args);
  });
  await commit(free, t, d);
  const { freeOperations, CosmosFreeStore } =
    await import("../src/server/free-store.js");
  const [partition, writes, character, business] = observed!,
    ops = freeOperations(partition, writes, character, business);
  expect(ops).toHaveLength(7);
  expect(ops[0]).toMatchObject({
    operationType: "Replace",
    id: `free:op:${t.operationId}`,
    ifMatch: writes[0]!.revision,
  });
  expect(JSON.stringify(ops)).not.toContain("free:claim:");
  expect(JSON.stringify(ops)).not.toContain("free:task:");
  const batch = vi.fn(async () => ({
      code: 200,
      result: ops.map(() => ({ statusCode: 200, eTag: "etag" })),
    })),
    container = vi.fn(() => ({ items: { batch } }));
  await new CosmosFreeStore({
    container,
  } as unknown as import("@azure/cosmos").Database).transaction(
    partition,
    writes,
    undefined,
    business,
  );
  expect(container).toHaveBeenCalledWith("stories");
  expect(batch).toHaveBeenCalledWith(ops, partition);
  expect(() => freeOperations("library", writes, undefined, business)).toThrow(
    "invalid_free_transaction",
  );
  const forged = structuredClone(writes);
  const op = forged[0]!.record;
  if (op.kind !== "op") throw Error();
  op.receipt!.assets = [];
  expect(() =>
    freeOperations(partition, forged, undefined, business),
  ).toThrow();
});
