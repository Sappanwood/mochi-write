import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { FreeSession } from "../src/server/free-session.js";
import { candidateTool } from "../src/server/free-candidate-tools.js";
import { Library } from "../src/server/library.js";
import { entity } from "../src/server/entities.js";
import { freeDigest } from "../src/server/free-references.js";
import type { FreeTask, ExactRef, ReceiptV2 } from "../src/shared/free.js";
import type { Candidate } from "../src/shared/free-candidates.js";
import { MemoryStore } from "./support/memory-store.js";
import { MemoryFreeStore } from "./support/free-store.js";
const body = (name = "甲") => ({
  name,
  markdown: "精确正文\r\n\n",
  genres: [],
  ageBand: "",
  sourceMetadata: {},
});
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
  intent = "draft",
  refs: ExactRef[] = [],
  conversationId?: string,
  mode = "new",
) {
  const message =
    intent === "update_world" ? "修改世界观时代并保存" : "创作世界观并保存";
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
      target: { mode, kind: "world", predicates: [] },
      ...(intent === "update_world"
        ? { changeEvidence: { start: 0, end: 7, text: "修改世界观时代" } }
        : {}),
    },
    "classifier",
  );
}
async function draft(
  free: FreeSession,
  task: FreeTask,
  name = "甲",
  args = {},
  invocation: string = randomUUID(),
) {
  const result = await candidateTool(
    free,
    task,
    "save_world",
    {
      mode: "draft",
      name,
      markdown: body().markdown,
      genres: [],
      age_band: "",
      ...args,
    },
    invocation,
  );
  return free.candidates.get(
    task.conversationId,
    (result.data as { draft_id: string }).draft_id,
  );
}
async function commit(free: FreeSession, task: FreeTask, d: Candidate) {
  return candidateTool(
    free,
    task,
    "save_world",
    {
      mode: "commit",
      draft_id: d.id,
      draft_revision: "1",
      draft_hash: d.draftHash,
    },
    randomUUID(),
  ) as Promise<{ data: unknown; receipt: ReceiptV2 }>;
}
const ref = (d: Awaited<ReturnType<MemoryStore["commit"]>>): ExactRef => ({
  type: "asset",
  kind: "world",
  asset_id: d.id,
  revision: d.revision,
  version: d.currentVersion,
  content_hash: freeDigest(d.content),
});

it("saves selected old draft exactly among interleaved groups and restores the same OP receipt", async () => {
  const { free, content } = fixture(),
    t = await begin(free);
  const a = await draft(free, t, " 甲 "),
    b = await draft(free, t, "乙");
  const a2 = await draft(free, t, "甲新版", {
    group_id: a.groupId,
    parent_ref: free.candidates.ref(a),
  });
  const save = await begin(
    free,
    "save_current",
    [free.candidates.ref(a)],
    t.conversationId,
  );
  const result = await commit(free, save, a);
  expect(result.receipt).toMatchObject({
    kind: "world_created",
    content_hash: freeDigest(a.payload.content),
    revision: "1",
    draft_id: a.id,
  });
  const id =
    save.binding!.target.kind === "world" ? save.binding!.target.asset_id : "";
  expect((await content.get(id, null))?.content).toEqual(a.payload.content);
  expect(content.heads.size).toBe(1);
  expect((await commit(free, save, a)).receipt).toEqual(result.receipt);
  await expect(commit(free, save, b)).rejects.toThrow("operation_conflict");
  expect([a.ordinal, b.ordinal, a2.ordinal]).toEqual([1, 1, 2]);
});

it("direct update retains legacy metadata, entity source and snapshots; next round reads current head", async () => {
  const { free, content } = fixture();
  const original = await content.commit(
    {
      ...entity("world", {
        ...body(),
        sourceMetadata: {
          legacy: { value: 7 },
          era: "侦探",
          tags: ["old"],
          world: "甲",
        },
      }),
      source: { path: "legacy/a.md", hash: "hash", raw: "original" },
    },
    null,
  );
  const storyId = randomUUID();
  const snapshot = await content.commit(
    {
      ...entity("snapshot", original.content, storyId),
      sourceAssetId: original.id,
      sourceVersion: 1,
    },
    null,
  );
  const t = await begin(
    free,
    "update_world",
    [ref(original)],
    undefined,
    "explicit",
  );
  const a = await draft(
    free,
    t,
    " 新名 ",
    { era: "", tags: [] },
    "stable-invocation",
  );
  const result = await commit(free, t, a),
    current = (await content.get(original.id, null))!;
  expect(result.receipt.revision).toBe("2");
  expect(current.content).toEqual(a.payload.content);
  expect(current.content.sourceMetadata).toMatchObject({
    legacy: { value: 7 },
    era: "",
    tags: [],
    world: "新名",
  });
  expect(current.source).toEqual(original.source);
  expect(await content.get(snapshot.id, storyId)).toEqual(snapshot);
  expect(
    (await draft(free, t, " 新名 ", { era: "", tags: [] }, "stable-invocation"))
      .id,
  ).toBe(a.id);
  const next = await begin(
    free,
    "update_world",
    [ref(current)],
    t.conversationId,
    "explicit",
  );
  expect(next.binding!.baseRevision).toBe(current.revision);
  const newer = await draft(free, next, "新名2");
  await commit(free, next, newer);
  expect((await content.get(original.id, null))?.currentVersion).toBe(3);
});

it.each(["edit", "delete"])(
  "closes OP on concurrent %s without overwriting or losing candidate",
  async (action) => {
    const { free, content } = fixture();
    const old = await new Library(content).create("world", body());
    const t = await begin(
        free,
        "update_world",
        [ref(old)],
        undefined,
        "explicit",
      ),
      d = await draft(free, t);
    if (action === "edit")
      await new Library(content).save(old.id, old.revision, body("人工"));
    else await new Library(content).remove(old.id, old.revision);
    const current = await content.get(old.id, null);
    await expect(commit(free, t, d)).rejects.toThrow("revision_conflict");
    expect(await content.get(old.id, null)).toEqual(current);
    expect((await free.operation(t.operationId)).status).toBe("conflict");
    expect((await free.candidates.get(t.conversationId, d.id)).draftHash).toBe(
      d.draftHash,
    );
  },
);

it("rejects saving without authority and binding substitution or a candidate from another operation", async () => {
  const { free, content } = fixture(),
    preview = await begin(free),
    d = await draft(free, preview);
  await expect(commit(free, preview, d)).rejects.toThrow(
    "authorization_required",
  );
  const save = await begin(free, "create_world", [], preview.conversationId),
    own = await draft(free, save);
  await expect(commit(free, save, d)).rejects.toThrow("forbidden_scope");
  await free.change(save.id, (t) => {
    t.binding!.target = { kind: "world", asset_id: randomUUID() };
  });
  await expect(commit(free, await free.task(save.id), own)).rejects.toThrow(
    "operation_conflict",
  );
  expect(content.heads.size).toBe(0);
});

it("keeps receipt authoritative if projection fails or transaction response is lost", async () => {
  for (const fault of ["projection", "response"]) {
    const { free, records, content } = fixture(),
      t = await begin(free, "create_world"),
      d = await draft(free, t);
    if (fault === "projection")
      vi.spyOn(free.operations, "reconcile").mockRejectedValue(
        Error("projection unavailable"),
      );
    else {
      const original = records.transaction.bind(records);
      vi.spyOn(records, "transaction").mockImplementation(async (p, w, b) => {
        const result = await original(p, w, b);
        if (b) throw Error("lost response");
        return result;
      });
    }
    try {
      await commit(free, t, d);
    } catch {
      /* The OP, not the transport, decides. */
    }
    const receipt = (await free.operation(t.operationId)).receipt;
    expect(receipt?.kind).toBe("world_created");
    expect((await commit(free, t, d)).receipt).toEqual(receipt);
    expect(content.history.size).toBe(1);
  }
});

it("cancel before commit revokes; commit before cancel preserves receipt", async () => {
  for (const cancelFirst of [true, false]) {
    const { free, content } = fixture(),
      t = await begin(free, "create_world"),
      d = await draft(free, t);
    if (cancelFirst) {
      await free.cancel(t.id);
      await expect(commit(free, t, d)).rejects.toThrow("authorization_revoked");
      expect(content.heads.size).toBe(0);
    } else {
      const r = await commit(free, t, d);
      await free.cancel(t.id);
      expect((await free.operation(t.operationId)).receipt).toEqual(r.receipt);
    }
  }
});

it("create-only rejects existing or deleted target, including a write racing after the precheck", async () => {
  for (const deleted of [false, true]) {
    const { free, records, content } = fixture(),
      t = await begin(free, "create_world"),
      d = await draft(free, t);
    const target = t.binding!.target;
    if (target.kind !== "world") throw Error();
    const original = records.transaction.bind(records);
    let competing = false;
    vi.spyOn(records, "transaction").mockImplementation(async (p, w, b) => {
      if (b && !competing) {
        competing = true;
        await content.commit(
          {
            ...entity("world", body("竞争"), null, target.asset_id),
            ...(deleted ? { deleted: true } : {}),
          },
          null,
        );
      }
      return original(p, w, b);
    });
    await expect(commit(free, t, d)).rejects.toThrow("revision_conflict");
    expect((await content.get(target.asset_id, null))?.content.name).toBe(
      "竞争",
    );
    expect((await free.operation(t.operationId)).status).toBe("conflict");
    expect(content.history.size).toBe(1);
  }
});

it("Cosmos commits the OP, immutable version and head in one library batch with independent CAS", async () => {
  const { free, records, content } = fixture(),
    old = await new Library(content).create("world", body());
  const t = await begin(
      free,
      "update_world",
      [ref(old)],
      undefined,
      "explicit",
    ),
    d = await draft(free, t);
  const original = records.transaction.bind(records);
  let observed: Parameters<typeof records.transaction> | undefined;
  vi.spyOn(records, "transaction").mockImplementation(async (...args) => {
    if (args[2]) observed = args;
    return original(...args);
  });
  await commit(free, t, d);
  const { freeOperations, CosmosFreeStore } =
    await import("../src/server/free-store.js");
  const [partition, writes, business] = observed!;
  const ops = freeOperations(partition, writes, business);
  expect(ops).toHaveLength(3);
  expect(ops[0]).toMatchObject({
    operationType: "Replace",
    id: `free:op:${t.operationId}`,
    ifMatch: writes[0]!.revision,
  });
  expect(ops[1]).toMatchObject({
    operationType: "Create",
    resourceBody: {
      id: `version:${old.id}:2`,
      scopeId: "library",
      content: { content: d.payload.content },
    },
  });
  expect(ops[2]).toMatchObject({
    operationType: "Replace",
    id: old.id,
    ifMatch: old.revision,
    resourceBody: { recordType: "head" },
  });
  const batch = vi.fn(async () => ({
    code: 200,
    result: ops.map(() => ({ statusCode: 200, eTag: "etag" })),
  }));
  const container = vi.fn(() => ({ items: { batch } }));
  const store = new CosmosFreeStore({
    container,
  } as unknown as import("@azure/cosmos").Database);
  await store.transaction(partition, writes, business);
  expect(container).toHaveBeenCalledWith("library");
  expect(batch).toHaveBeenCalledWith(ops, "library");
  expect(() =>
    freeOperations("library", writes, { ...business!, revision: null }),
  ).toThrow("invalid_world_transaction");
  expect(() =>
    freeOperations("library", writes, {
      ...business!,
      entity: { ...business!.entity, id: randomUUID() },
    }),
  ).toThrow("invalid_world_transaction");
  batch.mockResolvedValueOnce({
    code: 412,
    result: ops.map(() => ({ statusCode: 424, eTag: "" })),
  });
  await expect(store.transaction(partition, writes, business)).rejects.toThrow(
    "free_revision_conflict",
  );
});
