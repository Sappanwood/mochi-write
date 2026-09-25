import type { Api } from "./api.js";
import type { Content, Document } from "../shared/model.js";
import type {
  ExactRef,
  FreeTask,
  Target,
  Action,
  ReceiptV2,
  SourceRecord,
} from "../shared/free.js";
import type { Candidate, CandidateRef } from "../shared/free-candidates.js";
export interface Reference {
  ref: ExactRef;
  title: string;
  recorded: boolean;
}
export interface Composer {
  message: string;
  refs: Reference[];
}
export type TaskView = Pick<
  FreeTask,
  | "id"
  | "conversationId"
  | "createdAt"
  | "input"
  | "state"
  | "operationId"
  | "output"
  | "error"
  | "stopPending"
  | "receipt"
  | "draftContext"
> & {
  refs: ExactRef[];
  target?: Target;
  action?: Action;
  executionRun?: { runId?: string; status?: string };
  storyGuidance?: import("../shared/guidance.js").StoryGuidanceSnapshot | null;
  resolutionRun?: { runId?: string; status?: string };
};
export type Summary = Omit<CandidateRef, "type"> & {
  title: string;
  ordinal: number;
  artifact_kind: Candidate["artifactKind"];
};
export interface TaskDetail {
  task: TaskView;
  candidates: Summary[];
  sources: SourceRecord[];
  nextCursor: string | null;
}
export interface Information {
  availability: "exact" | "unavailable";
  content?: Content;
  currentVersion?: number;
  currentDeleted?: boolean;
  draft?: Candidate;
  claim?: { operationId: string; status: string };
  receipt?: ReceiptV2;
}
export type Discovery =
  | ({ type: "asset"; name: string } & Omit<
      Extract<ExactRef, { type: "asset" }>,
      "content_hash"
    >)
  | ({ type: "candidate" } & Summary);
export const root = "/creative/free";
export const kindLabel: Record<string, string> = {
  character: "角色",
  world: "世界观",
  story: "作品",
  setting: "设定",
  outline: "大纲",
  snapshot: "快照",
  chapter: "章节",
  candidate: "候选",
  story_initialization: "作品初始化",
  story_materials: "故事资料",
};
export const actionLabel: Record<Action, string> = {
  create_world: "新建世界观母版",
  update_world: "更新世界观母版",
  create_character: "新建角色母版",
  update_character: "更新角色母版",
  initialize_story: "建立作品",
  save_first_chapter: "保存作品与首章",
  create_chapter: "新建章节",
  revise_story_materials: "修订故事资料",
};
export const receiptLabel: Record<ReceiptV2["kind"], string> = {
  world_created: "独立世界观母版已新建",
  world_updated: "世界观母版已更新",
  character_created: "独立角色母版已新建",
  character_updated: "角色母版已更新",
  story_initialized: "作品已建立",
  first_chapter_saved: "作品与首章已保存",
  story_materials_saved: "故事资料已保存",
  chapter_created: "章节已保存",
};
export function targetLabel(target: Target) {
  return `${kindLabel[target.kind]} · ${(target.kind === "story" ? target.story_id : target.asset_id).slice(0, 8)}`;
}
const taskLabels: Record<string, string> = {
  unresolved: "正在理解请求",
  resolving: "正在查找资料与确认目标",
  binding: "正在确认保存目标",
  authorized: "准备创作",
  running: "正在创作",
  succeeded: "讨论已完成",
  failed: "本轮失败",
  interrupted: "执行中断 · 待核实原任务",
  cancel_pending: "取消待确认",
  revoked: "已撤回",
  conflict: "版本冲突 · 原稿保留",
  committed: "保存已确认",
  verifying: "保存结果待核实",
  clarifying: "需要澄清目标",
};
export function taskStatusLabel(task?: Pick<TaskView, "state" | "receipt">) {
  if (!task) return "尚未开始";
  if (task.state === "committed" && !task.receipt) return "保存结果待核实";
  return taskLabels[task.state] ?? "状态待核实";
}
export function refKey(ref: ExactRef) {
  return ref.type === "asset"
    ? `${ref.asset_id}:${ref.revision}:${ref.content_hash}`
    : `${ref.group_id}:${ref.draft_id}:${ref.draft_hash}:${ref.member_id ?? ""}`;
}
export function refLabel(ref: ExactRef) {
  return ref.type === "asset"
    ? `${kindLabel[ref.kind]} · ${ref.story_id ? `故事 ${ref.story_id}` : "角色与世界观库"} · v${ref.version} · ${ref.asset_id}`
    : `候选 · 组 ${ref.group_id} · ${ref.draft_id}${ref.member_id ? ` · 成员 ${ref.member_id}` : ""}`;
}
export function summaryRef(d: Summary): CandidateRef {
  return {
    type: "candidate",
    group_id: d.group_id,
    draft_id: d.draft_id,
    draft_revision: "1",
    draft_hash: d.draft_hash,
  };
}
export function blocksMessage(task: {
  state: string;
  stopPending?: boolean;
  executionRun?: { status?: string };
}) {
  if (task.state === "revoked" && !task.stopPending) return false;
  return Boolean(
    task.stopPending ||
    [
      "unresolved",
      "resolving",
      "binding",
      "authorized",
      "running",
      "cancel_pending",
      "verifying",
      "interrupted",
    ].includes(task.state) ||
    (task.executionRun &&
      (!task.executionRun.status ||
        ["queued", "running"].includes(task.executionRun.status))),
  );
}
export function settleSubmission(current: Composer, sent: Composer): Composer {
  return current.message === sent.message &&
    current.refs.map((r) => refKey(r.ref)).join() ===
      sent.refs.map((r) => refKey(r.ref)).join()
    ? { message: "", refs: [] }
    : current;
}
export async function pages<T>(api: Api, path: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: T[]; nextCursor: string | null } = await api(
      path + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""),
    );
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}
export async function discover(
  api: Api,
  base: string,
  query: string,
  kind?: string,
  storyId?: string,
) {
  const kinds = kind
    ? [kind]
    : [
        "character",
        "world",
        "story",
        ...(base === root ? [] : ["candidate"]),
        ...(storyId ? ["setting", "outline", "snapshot", "chapter"] : []),
      ];
  const result = await Promise.all(
    kinds.map(async (kind) => {
      const items: Discovery[] = [];
      let cursor: string | null = null;
      do {
        const params = new URLSearchParams({
          kind,
          query,
          ...(storyId &&
          !["character", "world", "story", "candidate"].includes(kind)
            ? { story_id: storyId }
            : {}),
          ...(cursor ? { cursor } : {}),
        });
        const page: {
          items: (Summary | Extract<Discovery, { type: "asset" }>)[];
          next_cursor: string | null;
        } = await api(`${base}/discover?${params}`);
        items.push(
          ...page.items.map((item) =>
            "draft_id" in item ? { ...item, type: "candidate" as const } : item,
          ),
        );
        cursor = page.next_cursor;
      } while (cursor);
      return items;
    }),
  );
  return result.flat();
}
export async function resolveDiscovery(
  api: Api,
  base: string,
  item: Discovery,
): Promise<Reference> {
  const locator =
    item.type === "candidate"
      ? summaryRef(item)
      : {
          type: item.type,
          kind: item.kind,
          asset_id: item.asset_id,
          revision: item.revision,
          version: item.version,
          ...(item.story_id ? { story_id: item.story_id } : {}),
        };
  const { ref } = await api<{ ref: ExactRef }>(
    base + "/references/resolve",
    locator,
  );
  return {
    ref,
    title:
      item.type === "candidate"
        ? `${item.title} · 第 ${item.ordinal} 稿`
        : item.name,
    recorded: item.type === "candidate",
  };
}
export async function readInformation(
  api: Api,
  base: string,
  value: Reference,
): Promise<Information> {
  const ref = value.ref;
  if (ref.type === "candidate" && !ref.member_id) {
    const result = await api<Information & { draft: Candidate }>(
      `${base}/drafts/${encodeURIComponent(ref.draft_id)}`,
    );
    if (
      result.draft.draftHash !== ref.draft_hash ||
      result.draft.groupId !== ref.group_id ||
      result.draft.draftRevision !== ref.draft_revision
    )
      throw Error("原版本不可取得");
    return {
      ...result,
      availability: "exact",
      content: result.draft.payload.content,
    };
  }
  if (value.recorded || ref.type === "candidate")
    return api(
      `${base}/references?ref=${encodeURIComponent(JSON.stringify(ref))}`,
    );
  const path =
    ref.kind === "character" || ref.kind === "world"
      ? `/library/${ref.asset_id}`
      : ref.kind === "story"
        ? `/stories/${ref.story_id}`
        : `/stories/${ref.story_id}/documents/${ref.asset_id}`;
  const doc = await api<Document>(path);
  if (doc.revision !== ref.revision || doc.currentVersion !== ref.version)
    throw Error("原版本不可取得，请重新检索；不会展示当前新版代替");
  return {
    availability: "exact",
    content: doc.content,
    currentVersion: doc.currentVersion,
  };
}

export function assetPath(
  target: ReceiptV2["target"],
  chapter?: ReceiptV2["chapter"],
) {
  return target.kind !== "story"
    ? `asset/${target.asset_id}`
    : `story/${target.story_id}/chapter${chapter ? `/${chapter.chapter_id}` : ""}`;
}
