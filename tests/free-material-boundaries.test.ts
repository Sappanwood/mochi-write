import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  materialFixture,
  materialTask,
  materialResolve,
  materialDraft,
  assetReference,
} from "./support/free-materials.js";
import { entity } from "../src/server/entities.js";
import { worldContent } from "./support/free-world.js";
it("switching stories in one conversation fixes a fresh scope and refuses the previous package as parent", async () => {
  const f = await materialFixture();
  const first = await materialResolve(f.free, await materialTask(f));
  const old = await materialDraft(f.free, first);
  const id = randomUUID();
  const other = await f.content.commit(
    { ...entity("story", worldContent("别港"), id, id), status: "ready" },
    null,
  );
  await f.content.commit(entity("chapter", worldContent("首章"), id), null);
  const setting = await f.content.commit(
    entity("setting", worldContent("别港设定"), id),
    null,
  );
  const t = await materialResolve(
    f.free,
    await materialTask(f, "更新另一个故事设定，仅预览", [
      assetReference(other),
    ]),
    [{ key: "setting", kind: "setting", mode: "update" }],
  );
  expect(t.storyAllowlist).toEqual([other.id]);
  expect(t.draftContext?.target).toEqual({ kind: "story", story_id: other.id });
  expect(t.draftContext?.materials?.[0]?.asset_id).toBe(setting.id);
  await expect(
    materialDraft(f.free, t, {
      group_id: old.groupId,
      parent_ref: f.free.candidates.ref(old),
      members: [{ key: "setting", name: "别港设定", markdown: "不同正文" }],
    }),
  ).rejects.toThrow("draft_conflict");
  const next = await materialDraft(f.free, t, {
    members: [{ key: "setting", name: "别港设定", markdown: "不同正文" }],
  });
  expect(next.groupId).not.toBe(old.groupId);
  expect((await f.content.get(setting.id, other.id))?.currentVersion).toBe(1);
  expect((await f.content.get(f.setting.id, f.story.id))?.currentVersion).toBe(
    1,
  );
});
it("duplicate natural story matches and a story with no chapters cannot authorize material writes", async () => {
  const f = await materialFixture(),
    id = randomUUID();
  const other = await f.content.commit(
    { ...entity("story", worldContent("灯塔"), id, id), status: "ready" },
    null,
  );
  const request = [{ key: "new", kind: "snapshot", mode: "create" }];
  const ambiguous = await materialResolve(
    f.free,
    await materialTask(f, "为灯塔新增角色快照并保存", []),
    request,
    "revise_story_materials",
    "search",
  );
  expect(ambiguous.state).toBe("clarifying");
  expect(ambiguous.binding).toBeUndefined();
  const unstarted = await materialResolve(
    f.free,
    await materialTask(f, "为这个故事新增角色快照并保存", [
      assetReference(other),
    ]),
    request,
    "revise_story_materials",
  );
  expect(unstarted.state).toBe("clarifying");
  expect(unstarted.binding).toBeUndefined();
});
