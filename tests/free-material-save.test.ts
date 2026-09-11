import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { candidateTool } from "../src/server/free-candidate-tools.js";
import { freeDigest } from "../src/server/free-references.js";
import {
  materialFixture,
  materialTask,
  materialResolve,
  materialDraft,
} from "./support/free-materials.js";
import type { FreeSession } from "../src/server/free-session.js";
import type { FreeTask } from "../src/shared/free.js";
import type { Candidate } from "../src/shared/free-candidates.js";
const save = async (free: FreeSession, t: FreeTask, d: Candidate) => {
  const result = await candidateTool(
    free,
    t,
    "revise_story_materials",
    {
      mode: "commit",
      draft_id: d.id,
      draft_revision: "1",
      draft_hash: d.draftHash,
    },
    randomUUID(),
  );
  if (!("receipt" in result) || !result.receipt) throw Error("Missing receipt");
  return result;
};
async function prepared() {
  const f = await materialFixture();
  const t = await materialResolve(
    f.free,
    await materialTask(f, "新增角色快照、更新林舟快照、设定和大纲并保存"),
    undefined,
    "revise_story_materials",
  );
  const d = await materialDraft(f.free, t);
  return { ...f, t, d };
}
it("one material OP saves the exact complete package and retry returns original receipt", async () => {
  const f = await prepared();
  const chapter = structuredClone(f.chapter);
  const a = await save(f.free, f.t, f.d);
  expect(a).toMatchObject({
    receipt: {
      kind: "story_materials_saved",
      content_hash: f.d.draftHash,
      assets: expect.any(Array),
    },
  });
  expect((a.receipt as { assets: unknown[] }).assets).toHaveLength(4);
  for (const m of f.d.payload.members!)
    expect((await f.content.get(m.member_id, f.story.id))?.content).toEqual(
      m.content,
    );
  expect(await f.content.get(chapter.id, f.story.id)).toEqual(chapter);
  const before = structuredClone([...f.content.heads]);
  expect((await save(f.free, f.t, f.d)).receipt).toEqual(a.receipt);
  expect([...f.content.heads]).toEqual(before);
  expect((await f.free.operation(f.t.operationId)).receipt).toEqual(a.receipt);
});
it("one conflicted member prevents every material write and keeps candidate", async () => {
  const f = await prepared();
  await f.content.commit(
    {
      ...f.setting,
      currentVersion: 2,
      content: { ...f.setting.content, markdown: "人工编辑" },
    },
    f.setting.revision,
  );
  const before = structuredClone([...f.content.heads]);
  await expect(save(f.free, f.t, f.d)).rejects.toThrow("revision_conflict");
  expect([...f.content.heads]).toEqual(before);
  expect((await f.free.operation(f.t.operationId)).status).toBe("conflict");
  expect(
    (await f.free.candidates.get(f.t.conversationId, f.d.id)).draftHash,
  ).toBe(f.d.draftHash);
});
it("lost committed response recovers original OP without a second snapshot", async () => {
  const f = await prepared();
  const original = f.records.transaction.bind(f.records);
  let lost = false;
  const originalGet = f.records.get.bind(f.records);
  vi.spyOn(f.records, "get").mockImplementation(async (...args) => {
    if (lost && args[0] === f.story.id && args[1] === "op") {
      lost = false;
      throw new Error("lost response");
    }
    return originalGet(...args);
  });
  vi.spyOn(f.records, "transaction").mockImplementation(async (...args) => {
    const r = await original(...args);
    if (args[3] && !lost) {
      lost = true;
      throw new Error("lost response");
    }
    return r;
  });
  await expect(save(f.free, f.t, f.d)).rejects.toThrow("lost response");
  const count = f.content.heads.size;
  const verified = await f.free.verify(f.t.id);
  expect(verified.receipt?.kind).toBe("story_materials_saved");
  expect((await save(f.free, f.t, f.d)).receipt).toEqual(verified.receipt);
  expect(f.content.heads.size).toBe(count);
});
it("cancel wins before commit and committed operation remains authoritative after cancel", async () => {
  const f = await prepared();
  await f.free.cancel(f.t.id);
  await expect(save(f.free, f.t, f.d)).rejects.toThrow();
  expect(f.content.heads.size).toBe(5);
  const g = await prepared();
  const r = await save(g.free, g.t, g.d);
  await g.free.cancel(g.t.id);
  expect((await g.free.operation(g.t.operationId)).receipt).toEqual(r.receipt);
});
it("same operation refuses another candidate after claim even if target result is unknown", async () => {
  const f = await prepared();
  const other = await materialDraft(f.free, f.t);
  f.records.failPartition = f.story.id;
  await expect(save(f.free, f.t, f.d)).rejects.toThrow();
  f.records.failPartition = undefined;
  await expect(save(f.free, f.t, other)).rejects.toThrow("operation_conflict");
  expect(f.content.heads.size).toBe(5);
  expect((await save(f.free, f.t, f.d)).receipt).toBeDefined();
});
it("save_current preserves selected old package after feedback", async () => {
  const f = await materialFixture();
  const t = await materialResolve(f.free, await materialTask(f));
  const old = await materialDraft(f.free, t);
  const newerTask = await materialResolve(
    f.free,
    await materialTask(f, "反馈修改资料，只预览", [f.free.candidates.ref(old)]),
    [],
  );
  await materialDraft(f.free, newerTask, {
    group_id: old.groupId,
    parent_ref: f.free.candidates.ref(old),
  });
  const t2 = await materialResolve(
    f.free,
    await materialTask(f, "原样保存这份资料旧稿", [f.free.candidates.ref(old)]),
    [],
    "save_current",
  );
  expect(t2.binding?.selectedDraft?.draft_id).toBe(old.id);
  const r = await save(f.free, t2, old);
  expect((r.receipt as { draft_hash: string }).draft_hash).toBe(old.draftHash);
  for (const m of old.payload.members!)
    expect(
      freeDigest((await f.content.get(m.member_id, f.story.id))!.content),
    ).toBe(freeDigest(m.content));
});
it("material batch applies object CAS with one story guard and rejects scope or receipt tampering", async () => {
  const f = await prepared();
  const calls = vi.spyOn(f.records, "transaction");
  await save(f.free, f.t, f.d);
  const call = calls.mock.calls.find((c) => c[3]);
  expect(call).toBeDefined();
  const { freeOperations } = await import("../src/server/free-store.js");
  const ops = freeOperations(...call!);
  expect(ops).toHaveLength(10);
  expect(
    ops.filter((o) => o.operationType === "Replace").map((o) => o.id),
  ).toContain(f.story.id);
  expect(
    ops.find((o) => o.operationType === "Replace" && o.id === f.setting.id),
  ).toHaveProperty("ifMatch", f.setting.revision);
  for (const tamper of ["story", "member", "receipt"]) {
    const args = structuredClone(call!) as typeof call;
    const pack = (
      args![3] as {
        materials: {
          story: { id: string };
          members: { entity: { projectId: string | null } }[];
        };
      }
    ).materials;
    if (tamper === "story") pack.story.id = randomUUID();
    if (tamper === "member") pack.members[0]!.entity.projectId = randomUUID();
    if (tamper === "receipt")
      (
        args![1][0]!.record as { receipt: { assets: unknown[] } }
      ).receipt.assets.pop();
    expect(() => freeOperations(...args!)).toThrow();
  }
});
it("concurrent identical commits do not create duplicate heads or versions", async () => {
  const f = await prepared();
  const results = await Promise.allSettled([
    save(f.free, f.t, f.d),
    save(f.free, f.t, f.d),
  ]);
  expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  const receipt = (await f.free.operation(f.t.operationId)).receipt;
  expect(receipt?.assets).toHaveLength(4);
  expect(f.content.heads.size).toBe(6);
  expect((await save(f.free, f.t, f.d)).receipt).toEqual(receipt);
});
