import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { creativeOperations } from "../src/server/creative-store.js";
import { Creative, wireId } from "../src/server/creative.js";
import type {
  CreativeIntent,
  CreativeTask,
  DraftRef,
} from "../src/shared/creative.js";
import { Library } from "../src/server/library.js";
import {
  LibraryTools,
  libraryContentHash,
} from "../src/server/library-tools.js";
import { clean } from "../src/server/entities.js";
import { MemoryStore } from "./support/memory-store.js";
import { MemoryCreativeStore } from "./support/creative-store.js";
import { FakeCreativeMochi } from "./support/creative-mochi.js";
const hosts: Creative[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
});
async function fixture(intent: CreativeIntent = "draft") {
  const content = new MemoryStore(),
    records = new MemoryCreativeStore(content),
    mochi = new FakeCreativeMochi();
  mochi.intent = intent;
  const host = new Creative(content, records, mochi, { pollMs: 1 });
  hosts.push(host);
  const first = await host.startConversation({
    clientRequestId: randomUUID(),
    message: "本轮明确要求",
    provider: "deepseek",
    model: "test",
  });
  const task = first.task,
    storyId = task.storyId,
    conversationId = task.conversationId;
  const context = async (t: CreativeTask) => {
    await expect
      .poll(async () => (await host.task(storyId, t.id)).status)
      .toBe("running");
    const current = await host.task(storyId, t.id);
    const c = (await host.resolveTask(wireId(storyId, t.id)))!;
    await c.bindRun(current.runId!);
    return c;
  };
  const next = async (intent: CreativeIntent, selectedDraft?: DraftRef) => {
    const current = await host.task(
      storyId,
      (await host.requireConversation(storyId, conversationId)).activeTaskId!,
    );
    mochi.finish(current.runId!);
    await expect
      .poll(async () => (await host.task(storyId, current.id)).status)
      .toBe("succeeded");
    mochi.intent = intent;
    const t = await host.submit(storyId, {
      clientRequestId: randomUUID(),
      conversationId,
      message: "下一轮明确要求",
      provider: "deepseek",
      model: "test",
      ...(selectedDraft ? { selectedDraft } : {}),
    });
    return { task: t, ctx: await context(t) };
  };
  return {
    host,
    content,
    records,
    mochi,
    task,
    storyId,
    conversationId,
    context,
    next,
    ctx: await context(task),
  };
}
const args = {
  mode: "draft",
  title: "灯塔",
  body: "雾海故事",
  assets: [{ kind: "setting", title: "设定", body: "永夜" }],
  chapter: { title: "第一章", body: " Exact 首章\r\n末尾空白  \n" },
};
const ref = (data: unknown) => {
  const d = data as DraftRef;
  return {
    draft_id: d.draft_id,
    draft_revision: d.draft_revision,
    draft_hash: d.draft_hash,
  };
};
const commit = (data: unknown) => ({ mode: "commit", ...ref(data) });
it("freezes rewritten initialization packages and saves the selected exact version with one receipt", async () => {
  const f = await fixture();
  const first = await f.host.initializeStory(f.ctx, args, randomUUID());
  const second = await f.host.initializeStory(
    f.ctx,
    { ...args, chapter: { title: "改稿", body: "另一份正文" } },
    randomUUID(),
  );
  expect(ref(first.data).draft_hash).not.toBe(ref(second.data).draft_hash);
  expect(await f.content.get(f.storyId, f.storyId)).toBeUndefined();
  await expect(
    f.host.initializeStory(f.ctx, commit(first.data), randomUUID()),
  ).rejects.toMatchObject({ code: "authorization_required" });
  const save = await f.next("save_current", ref(first.data));
  await expect(
    f.host.initializeStory(save.ctx, commit(second.data), randomUUID()),
  ).rejects.toMatchObject({ code: "draft_conflict" });
  const saved = await f.host.initializeStory(
    save.ctx,
    commit(first.data),
    randomUUID(),
  );
  expect(saved.receipt).toMatchObject({
    kind: "first_chapter_saved",
    draft_hash: ref(first.data).draft_hash,
    content_hash: ref(first.data).draft_hash,
  });
  expect(
    (await f.content.list({ projectId: f.storyId, kind: "chapter" })).items[0]
      ?.content.markdown,
  ).toBe(args.chapter.body);
  expect((await f.content.get(f.storyId, f.storyId))?.status).toBe("ready");
  expect(
    (await f.host.initializeStory(save.ctx, commit(first.data), randomUUID()))
      .receipt,
  ).toEqual(saved.receipt);
});
it("initializes without a chapter then atomically saves the first chapter and related asset changes in the same session", async () => {
  const f = await fixture("initialize_only");
  const draft = await f.host.initializeStory(
    f.ctx,
    { mode: "draft", title: "灯塔", assets: args.assets },
    randomUUID(),
  );
  const saved = await f.host.initializeStory(
    f.ctx,
    commit(draft.data),
    randomUUID(),
  );
  expect(saved.receipt).toMatchObject({ kind: "story_initialized" });
  expect(saved.receipt).not.toHaveProperty("chapter");
  expect(
    (await f.content.get(f.storyId, f.storyId))?.initializationPending,
  ).toBe(true);
  const setting = (
    await f.content.list({ projectId: f.storyId, kind: "setting" })
  ).items[0]!;
  const next = await f.next("create_and_save");
  const first = await f.host.initializeStory(
    next.ctx,
    {
      ...args,
      assets: [
        {
          kind: "setting",
          asset_id: setting.id,
          base_revision: setting.revision,
          title: "更新设定",
          body: "极夜",
        },
      ],
    },
    randomUUID(),
  );
  await f.host.initializeStory(next.ctx, commit(first.data), randomUUID());
  expect((await f.content.get(setting.id, f.storyId))?.content.markdown).toBe(
    "极夜",
  );
  expect(
    (await f.content.get(f.storyId, f.storyId))?.initializationPending,
  ).toBeUndefined();
  expect(
    (await f.host.requireConversation(f.storyId, f.conversationId)).sessionId,
  ).toBe(f.ctx.sessionId);
});

it("copies only an actually-read immutable mother version as complete Content after edits and deletion", async () => {
  const f = await fixture("create_and_save"),
    library = new Library(f.content),
    tools = new LibraryTools(f.content);
  const original = {
    name: "林舟",
    markdown: "原始正文",
    genres: ["悬疑"],
    ageBand: "青年",
    sourceMetadata: { occupation: "侦探", custom: { nested: ["保留"] } },
  };
  const master = await library.create("character", original);
  const read = await tools.read(f.ctx, {
    asset_id: master.id,
    revision: master.revision,
  });
  const newer = await library.save(master.id, master.revision, {
    ...original,
    markdown: "后来修改",
  });
  await library.remove(master.id, newer.revision);
  const draft = await f.host.initializeStory(
    f.ctx,
    {
      ...args,
      assets: [
        {
          kind: "snapshot",
          source_id: master.id,
          source_version: read.version,
          source_hash: read.content_hash,
        },
      ],
    },
    randomUUID(),
  );
  const expanded = await f.host.draft(f.storyId, ref(draft.data).draft_id);
  expect(expanded.initialization?.assets[0]?.entity.content).toEqual(
    master.content,
  );
  expect(JSON.stringify(draft.data)).not.toContain("原始正文");
  const saved = await f.host.initializeStory(
    f.ctx,
    commit(draft.data),
    randomUUID(),
  );
  const snapshot = (
    await f.content.list({ projectId: f.storyId, kind: "snapshot" })
  ).items[0]!;
  expect(snapshot.content).toEqual(master.content);
  expect(snapshot.sourceAssetId).toBe(master.id);
  expect(snapshot.sourceVersion).toBe(1);
  expect(saved.receipt?.assets).toHaveLength(1);
});
it("does not let initialize-only authorize a chapter and preserves its independent success after a later failure", async () => {
  const f = await fixture("initialize_only");
  const withChapter = await f.host.initializeStory(f.ctx, args, randomUUID());
  await expect(
    f.host.initializeStory(f.ctx, commit(withChapter.data), randomUUID()),
  ).rejects.toMatchObject({ code: "forbidden_scope" });
  const only = await f.host.initializeStory(
    f.ctx,
    { mode: "draft", title: "灯塔", assets: [] },
    randomUUID(),
  );
  const saved = await f.host.initializeStory(
    f.ctx,
    commit(only.data),
    randomUUID(),
  );
  await expect(
    f.host.initializeStory(f.ctx, commit(withChapter.data), randomUUID()),
  ).rejects.toMatchObject({ code: "operation_conflict" });
  const next = await f.next("create_and_save");
  await f.host.cancel(f.storyId, next.task.id);
  expect((await f.host.task(f.storyId, f.task.id)).receipt).toEqual(
    saved.receipt,
  );
  expect(
    (await f.content.get(f.storyId, f.storyId))?.initializationPending,
  ).toBe(true);
});
it("rejects stale related assets without publishing any chapter or consuming the grant", async () => {
  const f = await fixture("initialize_only");
  const initial = await f.host.initializeStory(
    f.ctx,
    { mode: "draft", title: "灯塔", assets: args.assets },
    randomUUID(),
  );
  await f.host.initializeStory(f.ctx, commit(initial.data), randomUUID());
  const setting = (
    await f.content.list({ projectId: f.storyId, kind: "setting" })
  ).items[0]!;
  const next = await f.next("create_and_save");
  const draft = await f.host.initializeStory(
    next.ctx,
    {
      ...args,
      assets: [
        {
          kind: "setting",
          asset_id: setting.id,
          base_revision: setting.revision,
          title: "更新",
          body: "新的",
        },
      ],
    },
    randomUUID(),
  );
  await f.content.commit(
    {
      ...clean(setting),
      content: { ...setting.content, markdown: "并发变化" },
      currentVersion: 2,
    },
    setting.revision,
  );
  await expect(
    f.host.initializeStory(next.ctx, commit(draft.data), randomUUID()),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(
    (await f.content.list({ projectId: f.storyId, kind: "chapter" })).items,
  ).toHaveLength(0);
  expect(
    (await f.host.task(f.storyId, next.task.id)).authorization?.status,
  ).toBe("active");
  expect(
    (await f.content.get(f.storyId, f.storyId))?.initializationPending,
  ).toBe(true);
});
it("returns the committed receipt after a lost batch response without a second publication", async () => {
  const f = await fixture("create_and_save"),
    draft = await f.host.initializeStory(f.ctx, args, randomUUID());
  const original = f.records.transaction.bind(f.records);
  let lose = true;
  f.records.transaction = async (...args) => {
    const result = await original(...args);
    if (args[2] && lose) {
      lose = false;
      throw Error("response lost");
    }
    return result;
  };
  await expect(
    f.host.initializeStory(f.ctx, commit(draft.data), randomUUID()),
  ).rejects.toThrow("response lost");
  const saved = await f.host.initializeStory(
    f.ctx,
    commit(draft.data),
    randomUUID(),
  );
  expect(saved.receipt?.kind).toBe("first_chapter_saved");
  expect(
    (await f.content.list({ projectId: f.storyId, kind: "chapter" })).items,
  ).toHaveLength(1);
  expect(await f.host.operation(f.task.operationId)).toMatchObject({
    receipt: saved.receipt,
  });
});
it("rejects mixed source/target fields, excess objects, escaped byte budgets and cross-story targets", async () => {
  const f = await fixture();
  for (const extra of [
    {
      assets: [
        {
          kind: "snapshot",
          source_id: randomUUID(),
          source_version: 1,
          source_hash: "sha256:" + "a".repeat(64),
          title: "混合",
          body: "正文",
        },
      ],
    },
    {
      assets: Array.from({ length: 9 }, () => ({
        kind: "snapshot",
        title: "角色",
        body: "正文",
      })),
    },
    {
      assets: [
        { kind: "setting", title: "一", body: "正文" },
        { kind: "setting", title: "二", body: "正文" },
      ],
    },
    { assets: [{ kind: "outline", title: "过大", body: "中".repeat(2800) }] },
    { chapter: { title: "首章", body: "中".repeat(17000) } },
    { story_id: randomUUID() },
  ])
    await expect(
      f.host.initializeStory(f.ctx, { ...args, ...extra }, randomUUID()),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
  await expect(
    f.host.initializeStory(
      f.ctx,
      {
        ...args,
        assets: [
          {
            kind: "snapshot",
            asset_id: randomUUID(),
            base_revision: "rev",
            title: "别处",
            body: "正文",
          },
        ],
      },
      randomUUID(),
    ),
  ).rejects.toMatchObject({ code: "forbidden_scope" });
  await expect(
    f.host.initializeStory(
      f.ctx,
      {
        ...args,
        assets: Array.from({ length: 8 }, () => ({
          kind: "snapshot",
          title: "角色",
          body: "\\".repeat(8000),
        })),
        chapter: { title: "首章", body: "\\".repeat(48000) },
      },
      randomUUID(),
    ),
  ).rejects.toMatchObject({ code: "result_too_large" });
  expect(await f.host.drafts(f.storyId, f.conversationId)).toHaveLength(0);
});
it("keeps the frozen package and receipt hashes identical to persisted Content when titles need normalization", async () => {
  const f = await fixture("create_and_save");
  const draft = await f.host.initializeStory(
    f.ctx,
    {
      ...args,
      title: "  故事  ",
      assets: [{ kind: "snapshot", title: "  人物  ", body: "正文" }],
      chapter: { title: "  首章  ", body: "正文" },
    },
    randomUUID(),
  );
  const frozen = await f.host.draft(f.storyId, ref(draft.data).draft_id);
  const saved = await f.host.initializeStory(
    f.ctx,
    commit(draft.data),
    randomUUID(),
  );
  const snapshot = (
    await f.content.list({ projectId: f.storyId, kind: "snapshot" })
  ).items[0]!;
  expect(snapshot.content).toEqual(
    frozen.initialization?.assets[0]?.entity.content,
  );
  expect(saved.receipt?.assets[0]?.content_hash).toBe(
    libraryContentHash(snapshot.content),
  );
});
it("allows one of two different initialization packages racing on the same task and story CAS", async () => {
  const f = await fixture("create_and_save");
  await f.host.workflow.close();
  const first = await f.host.initializeStory(f.ctx, args, randomUUID()),
    second = await f.host.initializeStory(
      f.ctx,
      { ...args, title: "另一个" },
      randomUUID(),
    );
  const other = new Creative(f.content, f.records, f.mochi, { pollMs: 1 });
  hosts.push(other);
  const original = f.records.transaction.bind(f.records);
  let entered = 0;
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  f.records.transaction = async (...args) => {
    if (args[2] && "story" in args[2]) {
      entered++;
      if (entered === 2) release();
      await wait;
    }
    return original(...args);
  };
  const outcomes = await Promise.allSettled([
    f.host.initializeStory(f.ctx, commit(first.data), randomUUID()),
    other.initializeStory(f.ctx, commit(second.data), randomUUID()),
  ]);
  expect(outcomes.map((r) => r.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(
    (await f.content.list({ projectId: f.storyId, kind: "chapter" })).items,
  ).toHaveLength(1);
  expect(
    (await f.content.list({ projectId: f.storyId, kind: "setting" })).items,
  ).toHaveLength(1);
});
it("leaves no partial objects when cancellation wins initialization CAS", async () => {
  const f = await fixture("create_and_save");
  await f.host.workflow.close();
  const draft = await f.host.initializeStory(f.ctx, args, randomUUID());
  const other = new Creative(f.content, f.records, f.mochi, { pollMs: 1 });
  hosts.push(other);
  const original = f.records.transaction.bind(f.records);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => {
      enter = r;
    }),
    wait = new Promise<void>((r) => {
      release = r;
    });
  f.records.transaction = async (...args) => {
    if (args[2] && "story" in args[2]) {
      enter();
      await wait;
    }
    return original(...args);
  };
  const saving = f.host.initializeStory(
    f.ctx,
    commit(draft.data),
    randomUUID(),
  );
  const rejected = expect(saving).rejects.toMatchObject({
    code: "authorization_revoked",
  });
  await entered;
  await other.cancel(f.storyId, f.task.id);
  release();
  await rejected;
  expect(await f.content.get(f.storyId, f.storyId)).toBeUndefined();
  expect((await f.content.list({ projectId: f.storyId })).items).toHaveLength(
    0,
  );
});
it("rejects expanded-source packages over 256 KiB and complete batches over 1 MiB without truncation", async () => {
  const f = await fixture("create_and_save"),
    library = new Library(f.content),
    tools = new LibraryTools(f.content);
  await f.host.workflow.close();
  const sources = [];
  for (let i = 0; i < 5; i++) {
    const master = await library.create("character", {
      name: "角色" + i,
      markdown: "x".repeat(57000),
      genres: [],
      ageBand: "",
      sourceMetadata: {},
    });
    const read = await tools.read(f.ctx, {
      asset_id: master.id,
      revision: master.revision,
    });
    sources.push({
      kind: "snapshot",
      source_id: master.id,
      source_version: read.version,
      source_hash: read.content_hash,
    });
  }
  await expect(
    f.host.initializeStory(f.ctx, { ...args, assets: sources }, randomUUID()),
  ).rejects.toMatchObject({ code: "result_too_large" });
  expect(await f.host.drafts(f.storyId, f.conversationId)).toHaveLength(0);
  const draft = await f.host.initializeStory(f.ctx, args, randomUUID());
  await f.host.change(f.storyId, f.task.id, (t) => {
    t.output = "x".repeat(1024 * 1024);
  });
  await expect(
    f.host.initializeStory(f.ctx, commit(draft.data), randomUUID()),
  ).rejects.toMatchObject({ code: "result_too_large" });
  expect(await f.content.get(f.storyId, f.storyId)).toBeUndefined();
  expect((await f.host.task(f.storyId, f.task.id)).authorization?.status).toBe(
    "active",
  );
});

it("writes the maximal package as exactly 23 same-partition operations with conditional business records and immutable object creates", async () => {
  const f = await fixture("create_and_save");
  await f.host.workflow.close();
  const draft = await f.host.initializeStory(
    f.ctx,
    {
      ...args,
      assets: Array.from({ length: 8 }, (_, i) => ({
        kind: "snapshot",
        title: "角色" + i,
        body: "正文",
      })),
    },
    randomUUID(),
  );
  const original = f.records.transaction.bind(f.records);
  let operations: ReturnType<typeof creativeOperations> = [];
  f.records.transaction = async (...args) => {
    if (args[2] && "story" in args[2]) operations = creativeOperations(...args);
    return original(...args);
  };
  await f.host.initializeStory(f.ctx, commit(draft.data), randomUUID());
  expect(operations).toHaveLength(23);
  expect(operations.slice(0, 3).map((o) => o.operationType)).toEqual([
    "Replace",
    "Replace",
    "Replace",
  ]);
  expect(
    operations
      .slice(3)
      .every(
        (o) =>
          o.operationType === "Create" &&
          o.resourceBody?.projectId === f.storyId,
      ),
  ).toBe(true);
  expect(
    operations.filter(
      (o) => o.operationType === "Create" && o.resourceBody?.kind === "version",
    ),
  ).toHaveLength(10);
});

it("accepts a Unicode title within both the 200-codepoint and 512-byte limits without changing it at commit", async () => {
  const f = await fixture("create_and_save"),
    title = "😀".repeat(120);
  const draft = await f.host.initializeStory(
    f.ctx,
    { ...args, title, assets: [{ kind: "snapshot", title, body: "正文" }] },
    randomUUID(),
  );
  await f.host.initializeStory(f.ctx, commit(draft.data), randomUUID());
  expect((await f.content.get(f.storyId, f.storyId))?.content.name).toBe(title);
});
