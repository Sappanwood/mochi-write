import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  materialFixture,
  materialTask,
  materialResolve,
  materialDraft,
  materialRequests,
  assetReference,
} from "./support/free-materials.js";
import { entity } from "../src/server/entities.js";
import { worldContent } from "./support/free-world.js";
it("material preview fixes four member identities without business writes and rejects omission", async () => {
  const f = await materialFixture(),
    t = await materialResolve(f.free, await materialTask(f));
  expect(t.state).toBe("authorized");
  expect(t.binding).toBeUndefined();
  const before = structuredClone([...f.content.heads]);
  const a = await materialDraft(f.free, t, {}, "same");
  expect(a.artifactKind).toBe("story_materials");
  expect(a.payload.members).toHaveLength(4);
  expect(a.payload.members?.find((m) => m.kind === "setting")?.member_id).toBe(
    f.setting.id,
  );
  expect((await materialDraft(f.free, t, {}, "same")).id).toBe(a.id);
  expect([...f.content.heads]).toEqual(before);
  await expect(
    materialDraft(f.free, t, {
      members: [{ key: "new", name: "路人", markdown: "全文" }],
    }),
  ).rejects.toThrow();
  await expect(
    materialDraft(f.free, t, {
      members: Array.from({ length: 9 }, () => ({
        key: "new",
        name: "路人",
        markdown: "全文",
      })),
    }),
  ).rejects.toThrow();
});
it("feedback preserves member baselines after human editing and old exact content remains readable", async () => {
  const f = await materialFixture(),
    t = await materialResolve(f.free, await materialTask(f));
  const a = await materialDraft(f.free, t);
  await f.content.commit(
    { ...f.setting, currentVersion: 2, content: worldContent("人工设定") },
    f.setting.revision,
  );
  const follow = await materialTask(f, "反馈修改这份资料包，只预览", [
    f.free.candidates.ref(a),
  ]);
  const resolved = await materialResolve(f.free, follow, []);
  const b = await materialDraft(f.free, resolved, {
    group_id: a.groupId,
    parent_ref: f.free.candidates.ref(a),
  });
  expect(b.ordinal).toBe(2);
  expect(b.payload.draftContext).toMatchObject(a.payload.draftContext);
  expect((await f.free.candidates.get(t.conversationId, a.id)).draftHash).toBe(
    a.draftHash,
  );
});
it("unavailable capability and ambiguous draft members return to conversation without granting candidate scope", async () => {
  const f = await materialFixture();
  const c = await f.free.conversation(f.conversation.id);
  await f.records.transaction("library", [
    { record: { ...c, toolsetVersion: "world-v1" }, revision: c.revision },
  ]);
  const t = await materialResolve(f.free, await materialTask(f));
  expect(t.conversationNote).toBe("story_materials_unavailable");
  expect(t.draftContext).toBeUndefined();
  expect(t.binding).toBeUndefined();
  const g = await materialFixture();
  await g.content.commit(
    entity("snapshot", worldContent("林舟"), g.story.id),
    null,
  );
  const ambiguous = await materialResolve(g.free, await materialTask(g));
  expect(ambiguous.state).toBe("authorized");
  expect(ambiguous.draftContext).toBeUndefined();
  expect(ambiguous.conversationNote).toBe("ambiguous_or_missing_material");
});
it("master sources expand full independent Content and preserve source version", async () => {
  const f = await materialFixture();
  const master = await f.content.commit(
    entity("character", {
      ...worldContent("访客"),
      sourceMetadata: { legacy: { secret: "完整元数据" } },
    }),
    null,
  );
  const ref = assetReference(master);
  const task = await materialTask(f, "将访客母版完整复制为新角色快照，仅预览", [
    assetReference(f.story),
    ref,
  ]);
  const resolved = await materialResolve(f.free, task, [
    { key: "visitor", kind: "snapshot", mode: "create", source_ref: ref },
  ]);
  const d = await materialDraft(f.free, resolved, {
    members: [{ key: "visitor", copy_source: true }],
  });
  expect(d.payload.members?.[0]?.content).toEqual(master.content);
  expect(d.payload.members?.[0]?.sourceRef).toEqual(ref);
  await expect(
    materialDraft(f.free, resolved, {
      members: [{ key: "visitor", name: "摘要", markdown: "缺失的摘要" }],
    }),
  ).rejects.toThrow();
});
it("natural story lookup works without @ and draft evidence is advisory while saving stays strict", async () => {
  const f = await materialFixture();
  const task = await materialTask(f, "为灯塔更新林舟快照，只预览", []);
  const t = await materialResolve(
    f.free,
    task,
    [materialRequests()[1]!],
    "draft",
    "search",
  );
  expect(t.draftContext?.target).toEqual({
    kind: "story",
    story_id: f.story.id,
  });
  for (const intent of ["draft", "revise_story_materials"]) {
    const next = await materialTask(f, "继续按这个方向改");
    const result = await f.free.resolve(
      next.id,
      {
        intent,
        evidence: {
          start: 0,
          end: next.input.message.length,
          text: next.input.message,
        },
        changeEvidence: {
          start: 0,
          end: next.input.message.length,
          text: next.input.message,
        },
        target: { mode: "explicit", kind: "story", predicates: [] },
        materials: materialRequests().map((r) => ({
          ...r,
          evidence: { start: 0, end: 1, text: "假" },
        })),
      },
      randomUUID(),
    );
    expect(result.state).toBe(intent === "draft" ? "authorized" : "clarifying");
    expect(result.binding).toBeUndefined();
    if (intent === "draft")
      expect(result.draftContext?.materials).toHaveLength(4);
    else expect(result.error).toBe("invalid_material_evidence");
  }
});
it("unsaved same-conversation character expands without a master and keeps durable candidate provenance", async () => {
  const f = await materialFixture();
  const role = await materialTask(f, "构思一个新角色，仅预览", []);
  const evidence = {
    start: 0,
    end: role.input.message.length,
    text: role.input.message,
  };
  const r = await f.free.resolve(
    role.id,
    {
      intent: "draft",
      evidence,
      target: { mode: "new", kind: "character", predicates: [] },
    },
    randomUUID(),
  );
  const { candidateTool } =
    await import("../src/server/free-candidate-tools.js");
  const result = await candidateTool(
    f.free,
    r,
    "save_character",
    {
      mode: "draft",
      name: "旅人",
      markdown: "完整角色正文\r\n",
      genres: ["奇幻"],
      age_band: "成年",
    },
    randomUUID(),
  );
  const candidate = await f.free.candidates.get(
    r.conversationId,
    (result.data as { draft_id: string }).draft_id,
  );
  const ref = f.free.candidates.ref(candidate);
  const task = await materialTask(f, "将旅人候选完整加入角色快照，仅预览", [
    assetReference(f.story),
    ref,
  ]);
  const resolved = await materialResolve(f.free, task, [
    { key: "visitor", kind: "snapshot", mode: "create", source_ref: ref },
  ]);
  const d = await materialDraft(f.free, resolved, {
    members: [{ key: "visitor", copy_source: true }],
  });
  expect(d.payload.members?.[0]?.content).toEqual(candidate.payload.content);
  const pack = d.payload.business?.materials as {
    members: { entity: Record<string, unknown> }[];
  };
  expect(pack.members[0]?.entity.sourceCandidate).toEqual({
    conversationId: f.conversation.id,
    groupId: candidate.groupId,
    draftId: candidate.id,
    draftRevision: "1",
    draftHash: candidate.draftHash,
  });
  expect(pack.members[0]?.entity.sourceAssetId).toBeUndefined();
  expect(
    [...f.content.heads.values()].filter((x) => x.kind === "character"),
  ).toHaveLength(0);
});
