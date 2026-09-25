import { FakeCreativeMochi } from "./support/creative-mochi.js";
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Creative, wireId } from "../src/server/creative.js";
import { AppError } from "../src/shared/model.js";
import type { CreativeTask } from "../src/shared/creative.js";
import { entity, hash } from "../src/server/entities.js";
import { MemoryStore } from "./support/memory-store.js";
import { MemoryCreativeStore } from "./support/creative-store.js";

const cleanup: Creative[] = [];

it("legacy creative runs include story guidance but intent runs do not", async () => {
  const f = await fixture();
  const story = (await f.content.get(f.storyId, f.storyId))!;
  f.content.heads.set(`${story.id}:${story.id}`, {
    ...story,
    guidance: "慢热",
  });
  const task = await f.submit();
  await waitTask(f.service, task, (t) => !!t.runId);
  const prompts = f.mochi.calls
    .filter((c) => c.path.endsWith("/runs") && c.body)
    .map((c) => JSON.parse(c.body!.prompt as string));
  expect(prompts.find((p) => p.task)?.story_guidance.text).toBe("慢热");
  expect(prompts.find((p) => !p.task)).not.toHaveProperty("story_guidance");
});
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((service) => service.close()));
});
async function fixture() {
  const content = new MemoryStore();
  const storyId = randomUUID();
  await content.commit(
    {
      ...entity(
        "story",
        {
          name: "Story",
          markdown: "PRIVATE-STORY-CONTENT",
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
  const records = new MemoryCreativeStore(content);
  const mochi = new FakeCreativeMochi();
  const service = new Creative(content, records, mochi, { pollMs: 1 });
  cleanup.push(service);
  const conversation = await service.createConversation(storyId);
  const submit = (
    message = "写一章给我看看",
    extra: Record<string, unknown> = {},
  ) =>
    service.submit(storyId, {
      clientRequestId: randomUUID(),
      conversationId: conversation.id,
      provider: "deepseek",
      model: "test",
      message,
      ...extra,
    });
  return { content, records, mochi, service, storyId, conversation, submit };
}
async function waitTask(
  service: Creative,
  task: CreativeTask,
  condition: (task: CreativeTask) => boolean,
) {
  for (let i = 0; i < 300; i++) {
    const current = await service.task(task.storyId, task.id);
    if (condition(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(
    "Task condition not reached: " +
      JSON.stringify(await service.task(task.storyId, task.id)),
  );
}
async function context(
  f: Awaited<ReturnType<typeof fixture>>,
  task: CreativeTask,
) {
  const current = await waitTask(
    f.service,
    task,
    (task) => task.status === "running" && Boolean(task.runId),
  );
  const context = (await f.service.resolveTask(wireId(f.storyId, task.id)))!;
  await context.bindRun(current.runId!);
  return context;
}
async function makeDraft(
  f: Awaited<ReturnType<typeof fixture>>,
  task: CreativeTask,
  body = " Exact正文\r\n末尾空白  \n",
) {
  const ctx = await context(f, task);
  const result = await f.service.createChapter(
    ctx,
    { mode: "draft", title: "第一章", body },
    randomUUID(),
  );
  return {
    ctx,
    data: result.data as {
      draft_id: string;
      draft_revision: "1";
      draft_hash: string;
      body: string;
    },
  };
}
function commit(data: {
  draft_id: string;
  draft_revision: string;
  draft_hash: string;
}) {
  return {
    mode: "commit",
    draft_id: data.draft_id,
    draft_revision: data.draft_revision,
    draft_hash: data.draft_hash,
  };
}

describe("creative workflow", () => {
  it("uses an independent no-tool intent session and stores a draft separately from the final reply", async () => {
    const f = await fixture();
    const task = await f.submit();
    const draft = await makeDraft(f, task);
    const current = await f.service.task(f.storyId, task.id);
    expect(current.authorization).toBeUndefined();
    await expect(
      f.service.createChapter(draft.ctx, commit(draft.data), randomUUID()),
    ).rejects.toMatchObject({ code: "authorization_required" });
    expect(
      (await f.content.list({ projectId: f.storyId, kind: "chapter" })).items,
    ).toHaveLength(0);
    f.mochi.finish(current.runId!);
    const finished = await waitTask(
      f.service,
      task,
      (task) => task.status === "succeeded",
    );
    expect(finished.output).toBe("会话回复，不是正文");
    expect(
      (await f.service.drafts(f.storyId, f.conversation.id))[0]?.body,
    ).toBe(draft.data.body);
    const intentSession = f.mochi.sessions.get(current.intentSessionId!);
    expect(intentSession?.tools).toBeUndefined();
    const intentPost = f.mochi.calls.find(
      (call) => call.path === `/v1/sessions/${current.intentSessionId}/runs`,
    )!;
    expect(JSON.stringify(intentPost.body)).not.toContain(
      "PRIVATE-STORY-CONTENT",
    );
  });
  it("direct authorization creates one exact chapter and changing tool invocation ID returns the same receipt", async () => {
    const f = await fixture();
    f.mochi.intent = "create_and_save";
    const task = await f.submit("写一章并保存");
    const draft = await makeDraft(f, task);
    const first = await f.service.createChapter(
      draft.ctx,
      commit(draft.data),
      randomUUID(),
    );
    const repeated = await f.service.createChapter(
      draft.ctx,
      commit(draft.data),
      randomUUID(),
    );
    expect(repeated.receipt).toEqual(first.receipt);
    const chapters = (
      await f.content.list({ projectId: f.storyId, kind: "chapter" })
    ).items;
    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.content.markdown).toBe(draft.data.body);
    expect(first.receipt?.content_hash).toBe(`sha256:${hash(draft.data.body)}`);
    expect(
      (await f.service.task(f.storyId, task.id)).authorization?.status,
    ).toBe("consumed");
    expect((await f.service.operation(task.operationId)).status).toBe(
      "committed",
    );
  });
  it("saving a selected draft binds the original version instead of regenerating it", async () => {
    const f = await fixture();
    const first = await f.submit();
    const draft = await makeDraft(f, first);
    const current = await f.service.task(f.storyId, first.id);
    f.mochi.finish(current.runId!);
    await waitTask(f.service, first, (task) => task.status === "succeeded");
    f.mochi.intent = "save_current";
    const second = await f.submit("保存这个版本", {
      selectedDraft: {
        draft_id: draft.data.draft_id,
        draft_revision: "1",
        draft_hash: draft.data.draft_hash,
      },
    });
    const ctx = await context(f, second);
    await expect(
      f.service.createChapter(
        ctx,
        { ...commit(draft.data), draft_hash: `sha256:${"b".repeat(64)}` },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "draft_conflict" });
    const saved = await f.service.createChapter(
      ctx,
      commit(draft.data),
      randomUUID(),
    );
    expect(saved.receipt?.content_hash).toBe(draft.data.draft_hash);
  });
  it("revokes the previous grant before a slow or failed model-directory request for a new user message", async () => {
    const f = await fixture();
    f.mochi.intent = "create_and_save";
    const first = await f.submit("写一章并保存");
    const draft = await makeDraft(f, first);
    let entered!: () => void;
    let release!: () => void;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.mochi.modelBarrier = async () => {
      entered();
      await waiting;
      throw new AppError(503, "directory down");
    };
    const submitted = await f.submit("别保存");
    await entry;
    try {
      await expect(
        f.service.createChapter(draft.ctx, commit(draft.data), randomUUID()),
      ).rejects.toMatchObject({ code: "authorization_revoked" });
    } finally {
      release();
      await waitTask(f.service, submitted, (task) => task.status === "failed");
    }
    expect(
      (await f.service.task(f.storyId, first.id)).authorization?.status,
    ).toBe("revoked");
  });
  it("does not create a second chapter when the already-saved exact draft is selected in a new task", async () => {
    const f = await fixture();
    f.mochi.intent = "create_and_save";
    const first = await f.submit("写一章并保存");
    const draft = await makeDraft(f, first);
    await f.service.createChapter(draft.ctx, commit(draft.data), randomUUID());
    const current = await f.service.task(f.storyId, first.id);
    f.mochi.finish(current.runId!);
    await waitTask(f.service, first, (task) => task.status === "succeeded");
    f.mochi.intent = "save_current";
    const next = await f.submit("保存这个版本", {
      selectedDraft: {
        draft_id: draft.data.draft_id,
        draft_revision: "1",
        draft_hash: draft.data.draft_hash,
      },
    });
    const ctx = await context(f, next);
    await expect(
      f.service.createChapter(ctx, commit(draft.data), randomUUID()),
    ).rejects.toMatchObject({ code: "operation_conflict" });
    expect(
      (await f.content.list({ projectId: f.storyId, kind: "chapter" })).items,
    ).toHaveLength(1);
  });
});

describe("creative transactional boundaries", () => {
  it("rechecks task, draft and conversation revisions when cancellation wins a concurrent commit", async () => {
    const f = await fixture();
    f.mochi.intent = "create_and_save";
    const task = await f.submit("写一章并保存");
    const draft = await makeDraft(f, task);
    const other = new Creative(f.content, f.records, f.mochi, { pollMs: 1 });
    cleanup.push(other);
    const original = f.records.transaction.bind(f.records);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.records.transaction = async (...args) => {
      if (args[2]) {
        enter();
        await waiting;
      }
      return original(...args);
    };
    const saving = f.service.createChapter(
      draft.ctx,
      commit(draft.data),
      randomUUID(),
    );
    const rejected = expect(saving).rejects.toMatchObject({
      code: "authorization_revoked",
    });
    await entered;
    await other.cancel(f.storyId, task.id);
    release();
    await rejected;
    expect(
      (await f.content.list({ projectId: f.storyId, kind: "chapter" })).items,
    ).toHaveLength(0);
    expect((await f.service.operation(task.operationId)).status).toBe(
      "rejected",
    );
  });
  it("keeps a committed chapter on later cancellation and rejects changed draft content under one invocation", async () => {
    const f = await fixture();
    f.mochi.intent = "create_and_save";
    const task = await f.submit("写一章并保存");
    const ctx = await context(f, task);
    const id = randomUUID();
    const args = { mode: "draft", title: "Chapter", body: "Exact body" };
    const first = await f.service.createChapter(ctx, args, id);
    expect(await f.service.createChapter(ctx, args, id)).toEqual(first);
    await expect(
      f.service.createChapter(ctx, { ...args, body: "Changed" }, id),
    ).rejects.toMatchObject({ code: "operation_conflict" });
    const data = first.data as {
      draft_id: string;
      draft_revision: string;
      draft_hash: string;
    };
    const saved = await f.service.createChapter(
      ctx,
      commit(data),
      randomUUID(),
    );
    await f.service.cancel(f.storyId, task.id);
    expect((await f.service.task(f.storyId, task.id)).receipt).toEqual(
      saved.receipt,
    );
    expect((await f.service.operation(task.operationId)).status).toBe(
      "committed",
    );
    expect(
      (await f.content.list({ projectId: f.storyId, kind: "chapter" })).items,
    ).toHaveLength(1);
  });
  it("rejects changed request payloads and cross-story callback context without additional model submissions", async () => {
    const f = await fixture();
    const clientRequestId = randomUUID();
    const first = await f.submit("先讨论", { clientRequestId });
    const repeated = await f.submit("先讨论", { clientRequestId });
    expect(repeated.id).toBe(first.id);
    await expect(
      f.submit("直接保存", { clientRequestId }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const ctx = await context(f, first);
    await expect(
      f.service.createChapter(
        { ...ctx, storyId: randomUUID() },
        { mode: "draft", title: "X", body: "X" },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: "forbidden_scope" });
    expect(f.mochi.creativePosts()).toHaveLength(1);
  });
  it("does not grant save-current permission without one exact selected draft", async () => {
    const f = await fixture();
    f.mochi.intent = "save_current";
    const task = await f.submit("保存这个版本");
    const result = await waitTask(
      f.service,
      task,
      (current) => current.status === "unclear",
    );
    expect(result.authorization).toBeUndefined();
    expect(f.mochi.creativePosts()).toHaveLength(0);
  });
});

it("a later stop message cancels a registered earlier submission even when both model lookups overlap and the later lookup fails", async () => {
  const f = await fixture();
  f.mochi.intent = "create_and_save";
  let enterA!: () => void;
  let enterB!: () => void;
  let releaseA!: () => void;
  let releaseB!: () => void;
  let lookups = 0;
  const enteredA = new Promise<void>((resolve) => {
    enterA = resolve;
  });
  const enteredB = new Promise<void>((resolve) => {
    enterB = resolve;
  });
  const waitA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  const waitB = new Promise<void>((resolve) => {
    releaseB = resolve;
  });
  f.mochi.modelBarrier = async () => {
    if (++lookups === 1) {
      enterA();
      await waitA;
    } else {
      enterB();
      await waitB;
      throw new AppError(503, "later directory failed");
    }
  };
  const requestA = f.submit("写一章并保存");
  await enteredA;
  const requestB = f.submit("别保存");
  await enteredB;
  releaseA();
  const taskA = await requestA;
  try {
    const latestA = await waitTask(
      f.service,
      taskA,
      (task) => task.status === "cancelled" || Boolean(task.authorization),
    );
    expect(latestA.status).toBe("cancelled");
    expect(latestA.authorization?.status).not.toBe("active");
    expect(f.mochi.creativePosts()).toHaveLength(0);
  } finally {
    releaseB();
    const taskB = await requestB;
    await waitTask(f.service, taskB, (task) => task.status === "failed");
  }
  expect((await f.service.task(f.storyId, taskA.id)).status).toBe("cancelled");
  expect(f.mochi.creativePosts()).toHaveLength(0);
});
