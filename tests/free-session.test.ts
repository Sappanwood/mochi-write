import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { FreeSession } from "../src/server/free-session.js";
import { MemoryFreeStore } from "./support/free-store.js";
import { MemoryStore } from "./support/memory-store.js";
import { libraryContentHash } from "../src/server/library-tools.js";
import type { Mochi } from "../src/server/mochi-client.js";

const input = () => ({
  clientRequestId: randomUUID(),
  message: "讨论角色",
  provider: "fake",
  model: "fake",
});
const mochi: Mochi = {
  async request<T>() {
    throw new Error("No dispatch from read APIs");
    return {} as T;
  },
};
function fixture() {
  const records = new MemoryFreeStore(),
    content = new MemoryStore();
  return {
    records,
    content,
    free: new FreeSession(content, records, mochi, { autoStart: false }),
  };
}
async function character(content: MemoryStore, occupation = "侦探") {
  const id = randomUUID(),
    now = new Date().toISOString();
  const doc = await content.commit(
    {
      schemaVersion: 1,
      id,
      kind: "character",
      projectId: null,
      scopeId: "library",
      createdAt: now,
      updatedAt: now,
      currentVersion: 1,
      content: {
        name: "林舟",
        markdown: "合成角色",
        genres: [],
        ageBand: "",
        sourceMetadata: { occupation },
      },
    },
    null,
  );
  return {
    type: "asset" as const,
    kind: "character" as const,
    asset_id: id,
    revision: doc.revision,
    version: 1,
    content_hash: libraryContentHash(doc.content),
  };
}
function classification(message: string) {
  const text = "侦探",
    start = message.indexOf(text),
    change = "职业改成记者",
    cs = message.indexOf(change);
  return {
    intent: "update_character",
    evidence: { start: 0, end: message.length, text: message },
    target: {
      mode: "search",
      kind: "character",
      predicates: [
        {
          field: "occupation",
          operator: "contains",
          value: text,
          evidence: { start, end: start + text.length, text },
        },
      ],
    },
    changeEvidence: { start: cs, end: cs + change.length, text: change },
  };
}
describe("free conversation and target authority", () => {
  it("creates the same untyped identity from blank or refs, no business head; retries recover original", async () => {
    const f = fixture(),
      request = input();
    const first = await f.free.start(request);
    expect(first.conversation).not.toHaveProperty("storyId");
    expect(first.conversation.protocolVersion).toBe(2);
    expect((await f.free.start(request)).task.id).toBe(first.task.id);
    expect(
      (await f.free.byRequest(request.clientRequestId)).conversation.id,
    ).toBe(first.conversation.id);
    await expect(
      f.free.start({ ...request, message: "不同输入" }),
    ).rejects.toThrow();
    expect(f.content.heads.size).toBe(0);
  });
  it("pins explicit sources and does not reuse initial context as authorization", async () => {
    const f = fixture(),
      ref = await character(f.content);
    const first = await f.free.start({ ...input(), initialRefs: [ref] });
    expect(first.conversation.initialRefs).toEqual([ref]);
    await f.free.resolve(
      first.task.id,
      {
        intent: "discuss",
        evidence: { start: 0, end: 4, text: "讨论角色" },
        target: { mode: "unclear", kind: "character", predicates: [] },
      },
      "classifier",
    );
    expect((await f.free.task(first.task.id)).binding).toBeUndefined();
  });
  it("independently binds the historical unique detective and records complete evidence", async () => {
    const f = fixture(),
      ref = await character(f.content),
      message = "找到之前那个侦探角色，把职业改成记者并保存";
    const { task } = await f.free.start({
      ...input(),
      message,
      initialRefs: [ref],
    });
    await f.free.resolve(task.id, classification(message), "classifier");
    const bound = await f.free.task(task.id);
    expect(bound.binding?.target).toEqual({
      kind: "character",
      asset_id: ref.asset_id,
    });
    expect(bound.resolutionEvidence?.candidateIds).toEqual([ref.asset_id]);
    expect(bound.resolutionEvidence?.complete).toBe(true);
    expect((await f.free.operation(task.operationId)).status).toBe("unknown");
    expect(
      (
        await f.records.get<import("../src/shared/free.js").Ledger>(
          "library",
          "op",
          task.operationId,
        )
      )?.status,
    ).toBe("active");
  });
  it("one match without history or two plausible matches cannot authorize", async () => {
    for (const count of [1, 2]) {
      const f = fixture(),
        ref = await character(f.content);
      if (count === 2) await character(f.content);
      const message = "找到之前那个侦探角色，把职业改成记者并保存";
      const { task } = await f.free.start({
        ...input(),
        message,
        ...(count === 2 ? { initialRefs: [ref] } : {}),
      });
      await f.free.resolve(task.id, classification(message), "classifier");
      expect((await f.free.task(task.id)).state).toBe("clarifying");
      expect((await f.free.task(task.id)).binding).toBeUndefined();
    }
  });
  it("cancel prevents late resolution from creating an operation", async () => {
    const f = fixture(),
      ref = await character(f.content),
      message = "找到之前那个侦探角色，把职业改成记者并保存";
    const { task } = await f.free.start({
      ...input(),
      message,
      initialRefs: [ref],
    });
    await f.free.cancel(task.id);
    await expect(
      f.free.resolve(task.id, classification(message), "classifier"),
    ).rejects.toThrow();
    expect(
      await f.records.get("library", "directory", task.operationId),
    ).toBeUndefined();
  });
  it("reads frozen versions after edits, but new references reject changed heads", async () => {
    const f = fixture(),
      ref = await character(f.content);
    const { conversation } = await f.free.start({
      ...input(),
      initialRefs: [ref],
    });
    const head = (await f.content.get(ref.asset_id, null))!;
    await f.content.commit(
      {
        ...head,
        currentVersion: 2,
        content: { ...head.content, markdown: "新版" },
      },
      head.revision,
    );
    expect(
      (await f.free.references.read(conversation.id, ref)).content.markdown,
    ).toBe("合成角色");
    await expect(
      f.free.start({ ...input(), initialRefs: [ref] }),
    ).rejects.toThrow("reference_changed");
  });
});
it("a complete first page is not assumed while continuation remains", async () => {
  const f = fixture(),
    ref = await character(f.content),
    message = "找到之前那个侦探角色，把职业改成记者并保存";
  const original = f.content.searchLibrary.bind(f.content);
  f.content.searchLibrary = async (filter) => ({
    ...(await original(filter)),
    cursor: "another-page",
  });
  const { task } = await f.free.start({
    ...input(),
    message,
    initialRefs: [ref],
  });
  await f.free.resolve(task.id, classification(message), "classifier");
  expect((await f.free.task(task.id)).state).toBe("clarifying");
  expect((await f.free.task(task.id)).binding).toBeUndefined();
});
it("search metadata is rechecked against current head before authorization", async () => {
  const f = fixture(),
    ref = await character(f.content),
    message = "找到之前那个侦探角色，把职业改成记者并保存";
  const original = f.content.searchLibrary.bind(f.content);
  f.content.searchLibrary = async (filter) => {
    const page = await original(filter);
    const head = (await f.content.get(ref.asset_id, null))!;
    await f.content.commit(
      {
        ...head,
        currentVersion: 2,
        content: { ...head.content, sourceMetadata: { occupation: "医生" } },
      },
      head.revision,
    );
    return page;
  };
  const { task } = await f.free.start({
    ...input(),
    message,
    initialRefs: [ref],
  });
  await f.free.resolve(task.id, classification(message), "classifier");
  expect((await f.free.task(task.id)).state).toBe("clarifying");
  expect((await f.free.task(task.id)).binding).toBeUndefined();
});
it("cancellation during the independent query rejects the stale epoch", async () => {
  const f = fixture(),
    ref = await character(f.content),
    message = "找到之前那个侦探角色，把职业改成记者并保存";
  let release!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const original = f.content.searchLibrary.bind(f.content);
  f.content.searchLibrary = async (filter) => {
    entered();
    await barrier;
    return original(filter);
  };
  const { task } = await f.free.start({
    ...input(),
    message,
    initialRefs: [ref],
  });
  const resolving = f.free.resolve(
    task.id,
    classification(message),
    "classifier",
  );
  await started;
  await f.free.cancel(task.id);
  release();
  await expect(resolving).rejects.toThrow("authorization_revoked");
  expect(
    await f.records.get("library", "directory", task.operationId),
  ).toBeUndefined();
});
it("a fixed old reference is distinct from the next operation current head", async () => {
  const f = fixture(),
    ref = await character(f.content);
  const first = await f.free.start({ ...input(), initialRefs: [ref] });
  const head = (await f.content.get(ref.asset_id, null))!;
  const current = await f.content.commit(
    {
      ...head,
      currentVersion: 2,
      content: { ...head.content, markdown: "正式新版" },
    },
    head.revision,
  );
  const message = "把角色职业改成记者并保存";
  const task = await f.free.submit(first.conversation.id, {
    ...input(),
    message,
    refs: [ref],
  });
  const classified = {
    ...classification(message),
    target: { mode: "explicit", kind: "character", predicates: [] },
  };
  await f.free.resolve(task.id, classified, "classifier");
  expect((await f.free.task(task.id)).binding?.baseRevision).toBe(
    current.revision,
  );
  expect(
    (await f.free.references.read(first.conversation.id, ref)).content.markdown,
  ).toBe("合成角色");
});
it("explicit references must satisfy every frozen target predicate", async () => {
  for (const occupation of ["医生", "侦探"]) {
    const f = fixture(),
      ref = await character(f.content, occupation),
      message = "把侦探角色的职业改成记者并保存";
    const { task } = await f.free.start({ ...input(), message, refs: [ref] });
    const classified = classification(message);
    classified.target.mode = "explicit";
    await f.free.resolve(task.id, classified, "classifier");
    const current = await f.free.task(task.id);
    expect(current.state).toBe(
      occupation === "医生" ? "clarifying" : "authorized",
    );
    if (occupation === "医生") {
      expect(current.binding).toBeUndefined();
      expect(
        await f.records.get("library", "directory", task.operationId),
      ).toBeUndefined();
      expect(
        await f.records.get("library", "op", task.operationId),
      ).toBeUndefined();
    }
  }
});
it("explicit target predicates reject unsupported operators and vocabulary", async () => {
  for (const invalid of [
    { field: "gender", operator: "contains", value: "侦探" },
    { field: "genre", operator: "eq", value: "侦探" },
  ]) {
    const f = fixture(),
      ref = await character(f.content),
      message = "把侦探角色的职业改成记者并保存";
    const { task } = await f.free.start({ ...input(), message, refs: [ref] });
    const classified = classification(message);
    classified.target.mode = "explicit";
    Object.assign(classified.target.predicates[0]!, invalid);
    await f.free.resolve(task.id, classified, "classifier");
    expect((await f.free.task(task.id)).state).toBe("clarifying");
    expect(
      await f.records.get("library", "directory", task.operationId),
    ).toBeUndefined();
  }
});
