import { useEffect, useState } from "react";
import type {
  CreativeDraft,
  CreativeTaskView,
  CreativeReceipt,
} from "../shared/creative.js";
import type { AssetSource } from "../shared/creative-tools.js";
import type { Document } from "../shared/model.js";
import { type Api, ApiError, message } from "./api.js";
import { Markdown } from "./Markdown.js";

function savedPath(receipt: CreativeReceipt) {
  const chapterId =
    "chapter_id" in receipt ? receipt.chapter_id : receipt.chapter?.chapter_id;
  return chapterId
    ? `story/${receipt.story_id}/chapter/${chapterId}`
    : `story/${receipt.story_id}`;
}
function onlyStory(receipt: CreativeReceipt) {
  return "kind" in receipt && receipt.kind === "story_initialized";
}

export interface ToolProgress {
  id: string;
  name: string;
  status: string;
}
const toolLabels: Record<string, string> = {
  search_assets: "检索资料",
  read_asset: "读取资料",
  create_chapter: "创建章节工具",
};
const progressLabels: Record<string, string> = {
  running: "运行中",
  succeeded: "已完成",
  rejected: "失败",
  unknown: "待核实",
};
export const activeCreativeTask = (task: CreativeTaskView) =>
  ["interpreting", "pending", "running"].includes(task.status);
const statusLabels: Record<CreativeTaskView["status"], string> = {
  interpreting: "正在理解要求",
  pending: "正在准备创作",
  running: "正在创作",
  succeeded: "本轮已完成",
  failed: "本轮失败",
  cancelled: "已取消",
  interrupted: "执行已中断",
  unclear: "需要澄清要求",
};

function SourceView({
  api,
  storyId,
  source,
}: {
  api: Api;
  storyId: string;
  source: AssetSource;
}) {
  const [text, setText] = useState<string>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function read() {
    setBusy(true);
    setError("");
    setText(undefined);
    try {
      let content: string, revision: string;
      if (source.kind === "draft") {
        const draft = await api<CreativeDraft>(
          `/stories/${storyId}/creative/drafts/${encodeURIComponent(source.asset_id)}`,
        );
        content = draft.body;
        revision = draft.draftRevision;
      } else {
        const doc = await api<Document>(
          `/stories/${storyId}/documents/${encodeURIComponent(source.asset_id)}`,
        );
        content = doc.content.markdown;
        revision = doc.revision;
      }
      if (revision !== source.revision)
        setError("资料版本已变化，无法展示本轮读取的原版本");
      else setText(content);
    } catch (error) {
      setError(
        error instanceof ApiError && error.status === 404
          ? "资料已删除或不存在，无法展示本轮读取的原版本"
          : message(error),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="creative-source">
      <button className="quiet" disabled={busy} onClick={() => void read()}>
        查看来源：{source.title}
      </button>
      <p className="muted">读取版本：{source.revision}</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {text !== undefined && (
        <div className="source-reading">
          <Markdown text={text} />
          <button className="quiet" onClick={() => setText(undefined)}>
            收起来源
          </button>
        </div>
      )}
    </div>
  );
}

export function CreativeResults({
  api,
  task,
  progress,
  navigate,
  action,
  busy,
}: {
  api: Api;
  task: CreativeTaskView;
  progress: ToolProgress[];
  navigate: (path: string) => void;
  action: (
    task: CreativeTaskView,
    operation: "cancel" | "verify",
  ) => Promise<void>;
  busy: boolean;
}) {
  const saved =
    task.receipt?.status === "committed" &&
    task.receipt.story_id === task.storyId;
  return (
    <section className="creative-turn" aria-label={`创作任务 ${task.id}`}>
      <div className="creative-user">
        <p className="eyebrow">你</p>
        <p>{task.message}</p>
      </div>
      <div className="creative-assistant">
        <p role="status" className="creative-status">
          {statusLabels[task.status]}
        </p>
        {task.output && (
          <>
            <p className="eyebrow">会话回复</p>
            <Markdown text={task.output} />
          </>
        )}
        {task.error && <p className="error">{task.error}</p>}
        {task.status === "unclear" && (
          <p>
            请明确是讨论、先看草稿，还是创作并保存一章；保存已有草稿时先选择具体版本。
          </p>
        )}
        {progress.length > 0 && (
          <section className="creative-progress" aria-label="工具进展">
            <h3>工具进展</h3>
            <ul>
              {progress.map((tool) => (
                <li key={tool.id}>
                  {toolLabels[tool.name] ?? "故事工具"} ·{" "}
                  {progressLabels[tool.status] ?? tool.status}
                </li>
              ))}
            </ul>
          </section>
        )}
        {task.sources.length > 0 && (
          <details className="creative-sources" open>
            <summary>本轮实际读取的资料 · {task.sources.length}</summary>
            {task.sources.map((source) => (
              <SourceView
                key={`${source.asset_id}:${source.revision}`}
                api={api}
                storyId={task.storyId}
                source={source}
              />
            ))}
          </details>
        )}
        {saved && (
          <div className="notice creative-receipt">
            <strong>
              {onlyStory(task.receipt!) ? "作品已建立" : "章节已保存"}
            </strong>
            <p>
              {onlyStory(task.receipt!) ? "作品" : "正式章节"}第{" "}
              {task.receipt!.revision} 版，保存结果已由后端确认。
            </p>
            <button
              className="secondary"
              onClick={() => navigate(savedPath(task.receipt!))}
            >
              {onlyStory(task.receipt!) ? "打开作品" : "打开章节"}
            </button>
          </div>
        )}
        {!saved && task.operationStatus === "unknown" && (
          <div className="creative-unknown">
            <strong>保存结果待核实</strong>
            <p>暂时无法确认是否已创建章节。先核实原任务，避免重复保存。</p>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void action(task, "verify")}
            >
              核实保存结果
            </button>
          </div>
        )}
        {task.stopPending && (
          <p className="error">
            停止尚未确认，授权已撤回。请重试停止后再继续此会话。
          </p>
        )}
        {(activeCreativeTask(task) || task.stopPending) && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void action(task, "cancel")}
          >
            {task.stopPending ? "重试停止" : "停止并撤回授权"}
          </button>
        )}
        <details className="creative-usage">
          <summary>本轮用量</summary>
          <p className="muted">
            创作 tokens：{task.usage?.total_tokens ?? "未知"} · 缓存读取：
            {task.usage?.cache_read ?? "未知"}
          </p>
          <p className="muted">
            意图解释 tokens：{task.intentUsage?.total_tokens ?? "未知"} ·
            缓存读取：{task.intentUsage?.cache_read ?? "未知"}
          </p>
        </details>
      </div>
    </section>
  );
}

export function CreativeDraftReader({
  api,
  storyId,
  draftId,
  navigate,
}: {
  api: Api;
  storyId: string;
  draftId: string;
  navigate: (path: string) => void;
}) {
  const [draft, setDraft] = useState<CreativeDraft>(),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api<CreativeDraft>(`/stories/${storyId}/creative/drafts/${draftId}`)
      .then((value) => {
        if (active) setDraft(value);
      })
      .catch((error) => {
        if (active) setError(message(error));
      });
    return () => {
      active = false;
    };
  }, [api, storyId, draftId]);
  return (
    <>
      <button
        className="back-link"
        onClick={() =>
          navigate(
            `story/${storyId}/creative${draft ? `/${draft.conversationId}` : ""}`,
          )
        }
      >
        ← 返回创作会话
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!draft && !error && <p role="status">正在读取草稿…</p>}
      {draft && (
        <>
          <header className="page-heading">
            <div>
              <p className="eyebrow">独立草稿 · 版本 {draft.draftRevision}</p>
              <h1>{draft.title}</h1>
              <p>
                {draft.receipt
                  ? onlyStory(draft.receipt)
                    ? "此版本已建立作品。"
                    : "此版本已有正式章节。"
                  : "草稿尚未加入章节目录。"}
              </p>
            </div>
          </header>
          <article className="reading-pane">
            <Markdown text={draft.body} />
          </article>
          <div className="creative-draft-actions">
            {draft.receipt ? (
              <button onClick={() => navigate(savedPath(draft.receipt!))}>
                {onlyStory(draft.receipt!) ? "打开作品" : "打开章节"}
              </button>
            ) : (
              <button
                onClick={() =>
                  navigate(
                    `story/${storyId}/creative/${draft.conversationId}/${draft.id}`,
                  )
                }
              >
                选择此版本
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}
