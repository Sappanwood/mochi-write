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
};
export const actionLabel: Record<Action, string> = {
  create_character: "新建角色母版",
  update_character: "更新角色母版",
  initialize_story: "建立作品",
  save_first_chapter: "保存作品与首章",
  create_chapter: "新建章节",
};
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
