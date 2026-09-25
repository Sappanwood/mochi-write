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
    intent === "update_character" ? "修改角色职业并保存" : "创作角色并保存";
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
      target: { mode, kind: "character", predicates: [] },
      ...(intent === "update_character"
        ? { changeEvidence: { start: 0, end: 6, text: "修改角色职业" } }
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
    "save_character",
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
    "save_character",
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
  kind: "character",
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
    kind: "character_created",
    content_hash: freeDigest(a.payload.content),
    revision: "1",
    draft_id: a.id,
  });
  const id =
    save.binding!.target.kind === "character"
      ? save.binding!.target.asset_id
      : "";
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
      ...entity("character", {
        ...body(),
        sourceMetadata: {
          legacy: { value: 7 },
          occupation: "侦探",
          tags: ["old"],
          world: "甲",
        },
      }),
      source: { path: "legacy/a.md", hash: "hash", raw: "original" },
      portrait: { imageId: "a".repeat(64), prompt: "2.5D，银发" },
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
    "update_character",
    [ref(original)],
    undefined,
    "explicit",
  );
  const a = await draft(
    free,
    t,
    " 新名 ",
    { occupation: "", tags: [] },
    "stable-invocation",
  );
  const result = await commit(free, t, a),
    current = (await content.get(original.id, null))!;
  expect(result.receipt.revision).toBe("2");
  expect(current.content).toEqual(a.payload.content);
  expect(current.content.sourceMetadata).toMatchObject({
    legacy: { value: 7 },
    occupation: "",
    tags: [],
    world: "新名",
  });
  expect(current.source).toEqual(original.source);
  expect(current.portrait).toEqual(original.portrait);
  expect(await content.get(snapshot.id, storyId)).toEqual(snapshot);
  expect(
    (
      await draft(
        free,
        t,
        " 新名 ",
        { occupation: "", tags: [] },
        "stable-invocation",
      )
    ).id,
  ).toBe(a.id);
  const next = await begin(
    free,
    "update_character",
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
    const old = await new Library(content).create("character", body());
    const t = await begin(
        free,
        "update_character",
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
  const save = await begin(
      free,
      "create_character",
      [],
      preview.conversationId,
    ),
    own = await draft(free, save);
  await expect(commit(free, save, d)).rejects.toThrow("forbidden_scope");
  await free.change(save.id, (t) => {
    t.binding!.target = { kind: "character", asset_id: randomUUID() };
  });
  await expect(commit(free, await free.task(save.id), own)).rejects.toThrow(
    "operation_conflict",
  );
  expect(content.heads.size).toBe(0);
});
it("keeps receipt authoritative if projection fails or transaction response is lost", async () => {
  for (const fault of ["projection", "response"]) {
    const { free, records, content } = fixture(),
      t = await begin(free, "create_character"),
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
    expect(receipt?.kind).toBe("character_created");
    expect((await commit(free, t, d)).receipt).toEqual(receipt);
    expect(content.history.size).toBe(1);
  }
});
it("cancel before commit revokes; commit before cancel preserves receipt", async () => {
  for (const cancelFirst of [true, false]) {
    const { free, content } = fixture(),
      t = await begin(free, "create_character"),
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
it("a committed candidate cannot be claimed by a new OP", async () => {
  const { free, content } = fixture(),
    t = await begin(free),
    d = await draft(free, t);
  const save = await begin(
    free,
    "save_current",
    [free.candidates.ref(d)],
    t.conversationId,
  );
  await commit(free, save, d);
  const again = await begin(
    free,
    "save_current",
    [free.candidates.ref(d)],
    t.conversationId,
  );
  await expect(commit(free, again, d)).rejects.toThrow("draft_conflict");
  expect(content.heads.size).toBe(1);
});
it("ignores legacy metadata identity fields when independently verifying the target", async () => {
  const { free, content } = fixture();
  const victim = await new Library(content).create("character", body("乙"));
  const old = await content.commit(
    entity("character", {
      ...body("甲"),
      sourceMetadata: {
        asset_id: victim.id,
        name: "乙",
        revision: victim.revision,
      },
    }),
    null,
  );
  const message = "修改乙的职业并保存";
  const { task } = await free.start({
    clientRequestId: randomUUID(),
    message,
    provider: "fake",
    model: "fake",
    refs: [ref(old)],
  });
  const result = await free.resolve(
    task.id,
    {
      intent: "update_character",
      evidence: { start: 0, end: message.length, text: message },
      changeEvidence: { start: 0, end: 6, text: "修改乙的职业" },
      target: {
        mode: "explicit",
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
    "classifier",
  );
  expect(result.state).toBe("clarifying");
  expect(result.binding).toBeUndefined();
});
it("revalidates persisted binding against the directory even when a changed binding asks for an existing receipt", async () => {
  const { free } = fixture(),
    t = await begin(free, "create_character"),
    d = await draft(free, t);
  await commit(free, t, d);
  const { FreeCallback } = await import("../src/server/free-callback.js");
  const { freeScope } = await import("../src/server/free-workflow.js");
  const c = await free.conversation(t.conversationId),
    sessionId = randomUUID(),
    runId = randomUUID();
  await free.records.transaction("library", [
    { record: { ...c, sessionId }, revision: c.revision },
  ]);
  const changed = await free.change(t.id, (t) => {
    t.binding!.target = { kind: "character", asset_id: randomUUID() };
    t.executionRun = {
      sessionId,
      key: "key",
      payload: {},
      dispatchStarted: true,
      runId,
    };
  });
  const { task_id: _id, ...scope } = freeScope(changed, "execute");
  void _id;
  const response = await new FreeCallback(free).invoke({
    protocol_version: 2,
    app_id: "mochi-write",
    session_id: sessionId,
    run_id: runId,
    task_id: t.id,
    scope,
    invocation_id: "retry",
    tool_call_id: "retry",
    tool: { name: "save_character", version: "2" },
    arguments: {
      mode: "commit",
      draft_id: d.id,
      draft_revision: "1",
      draft_hash: d.draftHash,
    },
  });
  expect(response).toMatchObject({
    outcome: "error",
    error: { code: "operation_conflict" },
  });
});
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
it.each(["commit", "cancel"])(
  "CAS %s winner determines a simultaneously in-flight commit/cancel",
  async (winner) => {
    const { free, records, content } = fixture(),
      t = await begin(free, "create_character"),
      d = await draft(free, t);
    const entered = barrier(),
      proceed = barrier(),
      original = records.transaction.bind(records);
    vi.spyOn(records, "transaction").mockImplementation(async (p, w, b) => {
      if (b) {
        entered.release();
        await proceed.promise;
      }
      return original(p, w, b);
    });
    const pending = commit(free, t, d).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await entered.promise;
    if (winner === "cancel") {
      await free.cancel(t.id);
      proceed.release();
    } else {
      proceed.release();
      await pending;
      await free.cancel(t.id);
    }
    const result = await pending;
    expect((await free.operation(t.operationId)).status).toBe(
      winner === "cancel" ? "revoked" : "committed",
    );
    expect(content.heads.size).toBe(winner === "cancel" ? 0 : 1);
    if (winner === "cancel")
      expect(result).toMatchObject({
        error: { message: "authorization_revoked" },
      });
  },
);
it("two sessions racing an update leave one version and one committed OP", async () => {
  const { free, content } = fixture(),
    old = await new Library(content).create("character", body());
  const a = await begin(
      free,
      "update_character",
      [ref(old)],
      undefined,
      "explicit",
    ),
    b = await begin(
      free,
      "update_character",
      [ref(old)],
      undefined,
      "explicit",
    );
  const da = await draft(free, a, "甲a"),
    db = await draft(free, b, "甲b");
  const results = await Promise.allSettled([
    commit(free, a, da),
    commit(free, b, db),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect((await content.get(old.id, null))?.currentVersion).toBe(2);
  expect(content.history.size).toBe(2);
  expect(
    [
      (await free.operation(a.operationId)).status,
      (await free.operation(b.operationId)).status,
    ].sort(),
  ).toEqual(["committed", "conflict"]);
});
it("the same OP racing itself returns one receipt and consumes only one version", async () => {
  const { free, content } = fixture(),
    t = await begin(free, "create_character"),
    d = await draft(free, t);
  const results = await Promise.all([commit(free, t, d), commit(free, t, d)]);
  expect(results[0].receipt).toEqual(results[1].receipt);
  expect(content.history.size).toBe(1);
});
it("a claimed candidate stays locked while unknown; only confirmed revoke allows a new OP", async () => {
  const { free, records, content } = fixture(),
    t = await begin(free),
    d = await draft(free, t);
  const save = await begin(
    free,
    "save_current",
    [free.candidates.ref(d)],
    t.conversationId,
  );
  const original = records.transaction.bind(records);
  const hook = vi
    .spyOn(records, "transaction")
    .mockImplementation(async (p, w, b) => {
      if (b) throw Error("unavailable before batch");
      return original(p, w, b);
    });
  await expect(commit(free, save, d)).rejects.toThrow(
    "unavailable before batch",
  );
  expect((await free.operation(save.operationId)).status).toBe("unknown");
  const claim = await records.get<import("../src/shared/free.js").DraftClaim>(
    "library",
    "claim",
    d.id,
  );
  expect(claim?.operationId).toBe(save.operationId);
  const { claimDraft } = await import("../src/server/free-library-save.js");
  await expect(
    claimDraft(
      free,
      { ...save, operationId: randomUUID() },
      d,
      claim!.payloadHash,
    ),
  ).rejects.toThrow("draft_conflict");
  hook.mockRestore();
  await free.cancel(save.id);
  const next = await begin(
    free,
    "save_current",
    [free.candidates.ref(d)],
    t.conversationId,
  );
  await commit(free, next, d);
  expect(content.history.size).toBe(1);
  expect(
    (
      await records.get<import("../src/shared/free.js").DraftClaim>(
        "library",
        "claim",
        d.id,
      )
    )?.operationId,
  ).toBe(next.operationId);
});
it("create-only rejects existing or deleted target, including a write racing after the precheck", async () => {
  for (const deleted of [false, true]) {
    const { free, records, content } = fixture(),
      t = await begin(free, "create_character"),
      d = await draft(free, t);
    const target = t.binding!.target;
    if (target.kind !== "character") throw Error();
    const original = records.transaction.bind(records);
    let competing = false;
    vi.spyOn(records, "transaction").mockImplementation(async (p, w, b) => {
      if (b && !competing) {
        competing = true;
        await content.commit(
          {
            ...entity("character", body("竞争"), null, target.asset_id),
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
it("rejects forged hash, extra targets, illegal vocabulary and oversized legacy packages", async () => {
  const { free, content } = fixture(),
    t = await begin(free, "create_character"),
    d = await draft(free, t);
  await expect(
    commit(free, t, { ...d, draftHash: "sha256:" + "0".repeat(64) }),
  ).rejects.toThrow("draft_conflict");
  await expect(
    candidateTool(
      free,
      t,
      "save_character",
      {
        mode: "commit",
        draft_id: d.id,
        draft_revision: "1",
        draft_hash: d.draftHash,
        target: { kind: "character", asset_id: randomUUID() },
      },
      "bad",
    ),
  ).rejects.toThrow();
  await expect(
    draft(free, t, "甲", { genres: ["not-a-genre"] }),
  ).rejects.toThrow();
  await expect(
    draft(free, t, "甲", { sourceMetadata: { deleted: true } }),
  ).rejects.toThrow();
  const old = await content.commit(
    entity("character", {
      ...body(),
      sourceMetadata: { legacy: "x".repeat(61 * 1024) },
    }),
    null,
  );
  // Resolve through the independent library query, without pretending the oversized content was referenced.
  const message = "修改甲职业并保存",
    task = (
      await free.start({
        clientRequestId: randomUUID(),
        message,
        provider: "fake",
        model: "fake",
      })
    ).task;
  const resolved = await free.resolve(
    task.id,
    {
      intent: "update_character",
      evidence: { start: 0, end: message.length, text: message },
      changeEvidence: { start: 0, end: 5, text: "修改甲职业" },
      target: {
        kind: "character",
        mode: "search",
        predicates: [
          {
            field: "name",
            operator: "eq",
            value: "甲",
            evidence: { start: 2, end: 3, text: "甲" },
          },
        ],
      },
    },
    "classifier",
  );
  expect(resolved.binding!.target).toEqual({
    kind: "character",
    asset_id: old.id,
  });
  await expect(draft(free, resolved)).rejects.toThrow("result_too_large");
});
it("Cosmos commits the OP, immutable version and head in one library batch with independent CAS", async () => {
  const { free, records, content } = fixture(),
    old = await new Library(content).create("character", body());
  const t = await begin(
      free,
      "update_character",
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
  ).toThrow("invalid_character_transaction");
  expect(() =>
    freeOperations("library", writes, {
      ...business!,
      entity: { ...business!.entity, id: randomUUID() },
    }),
  ).toThrow("invalid_character_transaction");
  batch.mockResolvedValueOnce({
    code: 412,
    result: ops.map(() => ({ statusCode: 424, eTag: "" })),
  });
  await expect(store.transaction(partition, writes, business)).rejects.toThrow(
    "free_revision_conflict",
  );
});
it.each(["succeeded", "failed"])(
  "runtime %s refresh cannot overwrite a committed OP projection",
  async (status) => {
    const { free } = fixture(),
      t = await begin(free, "create_character"),
      d = await draft(free, t);
    const result = await commit(free, t, d),
      sessionId = randomUUID(),
      runId = randomUUID();
    await free.change(t.id, (t) => {
      t.executionRun = {
        key: "key",
        sessionId,
        runId,
        dispatchStarted: true,
        status: "running",
        payload: {},
      };
    });
    vi.spyOn(free.mochi, "request").mockResolvedValue({
      run_id: runId,
      session_id: sessionId,
      status,
      result: { text: "runtime final" },
    });
    await free.workflow.refresh(t.id);
    expect((await free.task(t.id)).state).toBe("committed");
    expect((await free.task(t.id)).receipt).toEqual(result.receipt);
  },
);
it("freezes one exact OP input before a lost claim response and rejects switching drafts", async () => {
  const { free, records, content } = fixture(),
    t = await begin(free, "create_character"),
    a = await draft(free, t, "甲"),
    b = await draft(free, t, "乙");
  const original = records.transaction.bind(records);
  const fault = vi
    .spyOn(records, "transaction")
    .mockImplementation(async (p, w, business) => {
      const result = await original(p, w, business);
      if (w.some((w) => w.record.kind === "claim"))
        throw Error("claim response unknown");
      return result;
    });
  await expect(commit(free, t, a)).rejects.toThrow("claim response unknown");
  expect((await free.operation(t.operationId)).status).toBe("unknown");
  expect(content.heads.size).toBe(0);
  fault.mockRestore();
  await expect(commit(free, t, b)).rejects.toThrow("operation_conflict");
  expect(await records.get("library", "claim", b.id)).toBeUndefined();
  const result = await commit(free, t, a);
  expect(result.receipt.draft_id).toBe(a.id);
  expect(content.heads.size).toBe(1);
});
it("concurrent different drafts claim only one exact input for the same OP", async () => {
  const { free, records, content } = fixture(),
    t = await begin(free, "create_character"),
    a = await draft(free, t, "甲"),
    b = await draft(free, t, "乙");
  const results = await Promise.allSettled([
    commit(free, t, a),
    commit(free, t, b),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.find((r) => r.status === "rejected")).toMatchObject({
    reason: { message: "operation_conflict" },
  });
  const receipt = (await free.operation(t.operationId)).receipt!;
  const loser = receipt.draft_id === a.id ? b : a;
  expect(await records.get("library", "claim", loser.id)).toBeUndefined();
  expect(content.heads.size).toBe(1);
});
it("draft API rejects an inconsistent claim instead of showing another draft's receipt", async () => {
  const { free, records } = fixture(),
    t = await begin(free, "create_character"),
    a = await draft(free, t, "甲"),
    b = await draft(free, t, "乙");
  await commit(free, t, a);
  const claim = (await records.get<import("../src/shared/free.js").DraftClaim>(
    "library",
    "claim",
    a.id,
  ))!;
  await records.transaction("library", [
    {
      record: {
        ...claim,
        id: b.id,
        draftId: b.id,
        payloadHash: freeDigest({
          draftRef: free.candidates.ref(b),
          content: b.payload.content,
        }),
      },
      revision: null,
    },
  ]);
  const { default: Fastify } = await import("fastify"),
    { registerFree } = await import("../src/server/free-routes.js");
  const app = Fastify();
  registerFree(app, free);
  try {
    const response = await app.inject({
      method: "GET",
      url: `/api/creative/free/conversations/${t.conversationId}/drafts/${b.id}`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).not.toHaveProperty("receipt");
  } finally {
    await app.close();
  }
});
it("same input recovers if a concurrent commit completes after a stale claim read", async () => {
  const { free, records } = fixture(),
    t = await begin(free, "create_character"),
    d = await draft(free, t);
  const entered = barrier(),
    proceed = barrier(),
    original = records.get.bind(records);
  let paused = false;
  vi.spyOn(records, "get").mockImplementation(async (...args) => {
    const result = await original(...args);
    if (args[1] === "claim" && !paused) {
      paused = true;
      entered.release();
      await proceed.promise;
    }
    return result;
  });
  const pending = commit(free, t, d);
  await entered.promise;
  const completed = await commit(free, t, d);
  proceed.release();
  expect((await pending).receipt).toEqual(completed.receipt);
});

it("returns a protocol error for invalid model vocabulary without freezing a candidate", async () => {
  const { free } = fixture(),
    t = await begin(free);
  const { FreeCallback } = await import("../src/server/free-callback.js");
  const { freeScope } = await import("../src/server/free-workflow.js");
  const c = await free.conversation(t.conversationId),
    sessionId = randomUUID(),
    runId = randomUUID();
  await free.records.transaction("library", [
    { record: { ...c, sessionId }, revision: c.revision },
  ]);
  const current = await free.change(t.id, (task) => {
    task.executionRun = {
      sessionId,
      key: "key",
      payload: {},
      dispatchStarted: true,
      runId,
    };
  });
  const { task_id: _id, ...scope } = freeScope(current, "execute");
  void _id;
  const response = await new FreeCallback(free).invoke({
    protocol_version: 2,
    app_id: "mochi-write",
    session_id: sessionId,
    run_id: runId,
    task_id: t.id,
    scope,
    invocation_id: "vocabulary-error",
    tool_call_id: "vocabulary-error",
    tool: { name: "save_character", version: "2" },
    arguments: {
      mode: "draft",
      name: "岚舟",
      markdown: "合成侦探角色",
      genres: ["悬疑", "犯罪"],
      age_band: "成人",
    },
  });
  expect(response).toMatchObject({
    outcome: "error",
    error: { code: "invalid_arguments", retryable: false },
  });
  expect(await free.candidates.drafts(t.conversationId)).toEqual([]);
});
