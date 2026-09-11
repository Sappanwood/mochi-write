import { randomUUID } from "node:crypto";
import { worldFixture, worldContent, worldNext } from "./free-world.js";
import { entity } from "../../src/server/entities.js";
import { freeDigest } from "../../src/server/free-references.js";
import { candidateTool } from "../../src/server/free-candidate-tools.js";
import type { Document } from "../../src/shared/model.js";
import type { ExactRef, FreeTask } from "../../src/shared/free.js";
import type { FreeSession } from "../../src/server/free-session.js";
export const assetReference = (d: Document): ExactRef => ({
  type: "asset",
  kind: d.kind as "story",
  asset_id: d.id,
  ...(d.projectId ? { story_id: d.projectId } : {}),
  revision: d.revision,
  version: d.currentVersion,
  content_hash: freeDigest(d.content),
});
export async function materialFixture() {
  const f = await worldFixture();
  const c = await f.free.conversation(f.conversation.id);
  await f.records.transaction("library", [
    {
      record: { ...c, toolsetVersion: "materials-v1" } as never,
      revision: c.revision,
    },
  ]);
  const id = randomUUID();
  const story = await f.content.commit(
    { ...entity("story", worldContent("灯塔"), id, id), status: "ready" },
    null,
  );
  const chapter = await f.content.commit(
    { ...entity("chapter", worldContent("第一章"), id), order: 1 },
    null,
  );
  const snapshot = await f.content.commit(
    entity("snapshot", worldContent("林舟"), id),
    null,
  );
  const setting = await f.content.commit(
    entity("setting", worldContent("设定"), id),
    null,
  );
  const outline = await f.content.commit(
    entity("outline", worldContent("大纲"), id),
    null,
  );
  return { ...f, story, chapter, snapshot, setting, outline };
}
export const materialRequests = () => [
  { key: "new", kind: "snapshot", mode: "create" },
  { key: "hero", kind: "snapshot", mode: "update", name: "林舟" },
  { key: "setting", kind: "setting", mode: "update" },
  { key: "outline", kind: "outline", mode: "update" },
];
export async function materialResolve(
  free: FreeSession,
  task: FreeTask,
  requests: Record<string, unknown>[] = materialRequests(),
  intent = "draft",
  mode = "explicit",
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
      target: {
        mode,
        kind: "story",
        predicates:
          mode === "search"
            ? [{ field: "name", operator: "eq", value: "灯塔", evidence }]
            : [],
      },
      ...(intent === "revise_story_materials"
        ? { changeEvidence: evidence }
        : {}),
      ...(requests.length
        ? { materials: requests.map((m) => ({ ...m, evidence })) }
        : {}),
    },
    randomUUID(),
  );
}
export async function materialTask(
  f: Awaited<ReturnType<typeof materialFixture>>,
  message = "为灯塔新增角色快照，更新林舟快照、设定和大纲，仅预览",
  refs: ExactRef[] = [assetReference(f.story)],
) {
  return worldNext(f.free, f.conversation.id, message, refs);
}
export async function materialDraft(
  free: FreeSession,
  task: FreeTask,
  args: Record<string, unknown> = {},
  invocation: string = randomUUID(),
) {
  const result = await candidateTool(
    free,
    task,
    "revise_story_materials",
    {
      mode: "draft",
      members: materialRequests().map((m) => ({
        key: m.key,
        name: m.name ?? m.key,
        markdown: "新资料：铜钥匙只能在午夜开启北塔。\r\n",
      })),
      ...args,
    },
    invocation,
  );
  return free.candidates.get(
    task.conversationId,
    (result.data as { draft_id: string }).draft_id,
  );
}
