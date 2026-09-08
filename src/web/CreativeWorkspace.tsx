import { useEffect, useRef, useState } from "react";
import type {
  CreativeConversation,
  CreativeDraft,
  CreativeTaskView,
  DraftRef,
} from "../shared/creative.js";
import type { Document } from "../shared/model.js";
import { type Api, ApiError, message } from "./api.js";
import {
  CreativeResults,
  type ToolProgress,
  activeCreativeTask,
} from "./CreativeResults.js";

interface Model {
  provider: string;
  id: string;
  name?: string;
}
interface Request {
  conversationId: string;
  clientRequestId: string;
  message: string;
  provider: string;
  model: string;
  selectedDraft?: DraftRef;
}
interface EventPage {
  events: { cursor: number; type: string; data: Record<string, unknown> }[];
  next_cursor: number;
}
export function CreativeWorkspace({
  api,
  storyId,
  conversationId,
  selectedDraftId,
  navigate,
}: {
  api: Api;
  storyId: string;
  conversationId?: string;
  selectedDraftId?: string;
  navigate: (path: string) => void;
}) {
  const [story, setStory] = useState<Document>(),
    [conversations, setConversations] = useState<CreativeConversation[]>([]),
    [models, setModels] = useState<Model[]>([]),
    [model, setModel] = useState(""),
    [tasks, setTasks] = useState<CreativeTaskView[]>([]),
    [drafts, setDrafts] = useState<CreativeDraft[]>([]),
    [selected, setSelected] = useState<CreativeDraft>(),
    [text, setText] = useState(""),
    [error, setError] = useState(""),
    [syncError, setSyncError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [pending, setPending] = useState<Request>(),
    [progress, setProgress] = useState<Record<string, ToolProgress[]>>({});
  const base = `/stories/${storyId}/creative`;
  const cursors = useRef(new Map<string, number>());
  const current = useRef(true);
  const refreshing = useRef(false);
  const taskProgress = useRef<Record<string, ToolProgress[]>>({});
  const pendingRef = useRef<Request | undefined>(undefined);
  const ended = useRef(new Set<string>());
  const selectedForRoute =
    selected?.id === selectedDraftId ? selected : undefined;
  const selectionUnavailable = Boolean(selectedDraftId && !selectedForRoute);
  useEffect(() => {
    current.current = true;
    return () => {
      current.current = false;
    };
  }, []);
  function choose(id: string) {
    sessionStorage.setItem(`mochi-creative:${storyId}`, id);
    navigate(`story/${storyId}/creative/${id}`);
  }
  useEffect(() => {
    let active = true;
    void Promise.all([
      api<Document>(`/stories/${storyId}`),
      api<{ items: CreativeConversation[] }>(base + "/conversations"),
      api<{ models: Model[] }>("/writing/models"),
    ])
      .then(([story, list, choices]) => {
        if (!active) return;
        setStory(story);
        setConversations(list.items);
        setModels(choices.models);
        const preferredModel =
          choices.models.find((model) => model.id === "deepseek-v4-flash") ??
          choices.models[0];
        setModel(
          preferredModel
            ? `${preferredModel.provider}/${preferredModel.id}`
            : "",
        );
        if (!conversationId && list.items.length) {
          const preferred = sessionStorage.getItem(`mochi-creative:${storyId}`);
          const chosen =
            list.items.find((conversation) => conversation.id === preferred) ??
            [...list.items].sort((a, b) =>
              b.createdAt.localeCompare(a.createdAt),
            )[0]!;
          choose(chosen.id);
        }
      })
      .catch((error) => {
        if (active) setError(message(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, storyId, conversationId]);
  useEffect(() => {
    setSelected(undefined);
    if (!selectedDraftId) return;
    let active = true;
    void api<CreativeDraft>(base + `/drafts/${selectedDraftId}`)
      .then((draft) => {
        if (!active) return;
        if (
          draft.conversationId !== conversationId ||
          draft.storyId !== storyId
        )
          throw new Error("草稿不属于当前会话");
        setSelected(draft);
        setText("保存这个版本");
      })
      .catch((error) => {
        if (active) setError(message(error));
      });
    return () => {
      active = false;
    };
  }, [api, storyId, conversationId, selectedDraftId]);
  async function refresh() {
    if (!conversationId || refreshing.current) return;
    refreshing.current = true;
    try {
      const [result, drafts] = await Promise.all([
        api<{ items: CreativeTaskView[] }>(
          base + `/tasks?conversationId=${conversationId}`,
        ),
        api<{ items: CreativeDraft[] }>(
          base + `/drafts?conversationId=${conversationId}`,
        ),
      ]);
      if (!current.current) return;
      setTasks(result.items);
      setDrafts(drafts.items);
      if (
        pendingRef.current &&
        result.items.some(
          (task) => task.id === pendingRef.current!.clientRequestId,
        )
      ) {
        pendingRef.current = undefined;
        setPending(undefined);
        setText("");
        setSelected(undefined);
        setError("");
      }
      for (const task of result.items) {
        if (ended.current.has(task.id)) continue;
        let cursor = cursors.current.get(task.id) ?? 0;
        const tools = new Map(
          (taskProgress.current[task.id] ?? []).map((tool) => [tool.id, tool]),
        );
        while (true) {
          const after = cursor;
          const page = await api<EventPage>(
            base + `/tasks/${task.id}/events?after=${after}`,
          );
          if (!current.current) return;
          for (const event of [...page.events].sort(
            (a, b) => a.cursor - b.cursor,
          )) {
            if (event.cursor <= cursor) continue;
            cursor = event.cursor;
            if (
              !["tool_started", "tool_finished"].includes(event.type) ||
              typeof event.data.invocation_id !== "string" ||
              typeof event.data.name !== "string"
            )
              continue;
            tools.set(event.data.invocation_id, {
              id: event.data.invocation_id,
              name: event.data.name,
              status:
                event.type === "tool_started"
                  ? "running"
                  : typeof event.data.status === "string"
                    ? event.data.status
                    : "unknown",
            });
          }
          if (cursor === after) break;
        }
        cursors.current.set(task.id, cursor);
        taskProgress.current[task.id] = [...tools.values()];
        if (!activeCreativeTask(task) && !task.stopPending)
          ended.current.add(task.id);
      }
      if (current.current) setProgress({ ...taskProgress.current });
    } finally {
      refreshing.current = false;
    }
  }
  useEffect(() => {
    if (!conversationId) return;
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refresh();
        if (active) setSyncError("");
      } catch (error) {
        if (active) setSyncError(message(error) + "；关闭页面不会取消任务。");
      }
      if (active) timer = setTimeout(() => void poll(), 1200);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, storyId, conversationId]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (error) {
      if (current.current) setError(message(error));
    } finally {
      if (current.current) setBusy(false);
    }
  }
  async function queryPending() {
    const request = pendingRef.current;
    if (!request) return;
    try {
      const task = await api<CreativeTaskView>(
        base + `/tasks/${request.clientRequestId}`,
      );
      if (current.current) {
        setTasks((tasks) => [
          ...tasks.filter((item) => item.id !== task.id),
          task,
        ]);
        setPending(undefined);
        pendingRef.current = undefined;
        setText("");
        setSelected(undefined);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404)
        throw new Error(
          "暂未查到原任务。可稍后查询，或使用保留的同一请求重试。",
          { cause: error },
        );
      throw error;
    }
  }
  async function send(request?: Request) {
    const choice = models.find(
      (choice) => `${choice.provider}/${choice.id}` === model,
    );
    if (!request && (!choice || !conversationId || selectionUnavailable))
      return;
    const value: Request = request ?? {
      conversationId: conversationId!,
      clientRequestId: crypto.randomUUID(),
      message: text,
      provider: choice!.provider,
      model: choice!.id,
      ...(selectedForRoute
        ? {
            selectedDraft: {
              draft_id: selectedForRoute.id,
              draft_revision: selectedForRoute.draftRevision,
              draft_hash: selectedForRoute.hash,
            },
          }
        : {}),
    };
    pendingRef.current = value;
    setPending(value);
    try {
      const task = await api<CreativeTaskView>(base + "/tasks", value);
      if (!current.current) return;
      setTasks((tasks) => [
        ...tasks.filter((item) => item.id !== task.id),
        task,
      ]);
      pendingRef.current = undefined;
      setPending(undefined);
      setText("");
      setSelected(undefined);
      if (selectedDraftId)
        navigate(`story/${storyId}/creative/${conversationId}`);
    } catch (error) {
      if (
        error instanceof ApiError &&
        [400, 401, 403, 404, 409].includes(error.status)
      ) {
        pendingRef.current = undefined;
        setPending(undefined);
      }
      throw error;
    }
  }
  const blocked = tasks.some(
    (task) =>
      task.stopPending || (!task.receipt && task.operationStatus === "unknown"),
  );
  return (
    <>
      <button className="back-link" onClick={() => navigate("stories")}>
        ← 返回书架
      </button>
      <header className="page-heading">
        <div>
          <p className="eyebrow">故事创作</p>
          <h1>{story?.content.name ?? "正在读取故事…"}</h1>
          <p>说说想看怎样的故事，让 Agent 自主取材、写出下一页。</p>
        </div>
        <div className="creative-navigation">
          <button
            className="secondary"
            onClick={() => navigate(`story/${storyId}/chapter`)}
          >
            阅读章节
          </button>
          <button
            className="quiet"
            onClick={() => navigate(`story/${storyId}/snapshot`)}
          >
            查看故事资料
          </button>
        </div>
      </header>
      {(error || syncError) && (
        <p role="alert" className="error">
          {error || syncError}
        </p>
      )}
      <div className="creative-layout">
        <section className="creative-conversation">
          <h2>创作会话</h2>
          <div className="creative-controls">
            <label>
              创作会话
              <select
                aria-label="创作会话"
                value={conversationId ?? ""}
                disabled={busy || loading}
                onChange={(e) => choose(e.target.value)}
              >
                <option value="" disabled>
                  请选择会话
                </option>
                {conversations.map((conversation, index) => (
                  <option key={conversation.id} value={conversation.id}>
                    会话 {index + 1} ·{" "}
                    {new Date(conversation.createdAt).toLocaleString()}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="secondary"
              disabled={busy || loading}
              onClick={() =>
                void action(async () => {
                  const conversation = await api<CreativeConversation>(
                    base + "/conversations",
                    {},
                  );
                  choose(conversation.id);
                })
              }
            >
              新建创作会话
            </button>
          </div>
          {loading && <p role="status">正在读取会话…</p>}
          {!loading && !conversationId && (
            <p className="empty">
              新建一个会话，告诉 Agent 想看怎样的下一章。资料会按需读取。
            </p>
          )}
          <div className="creative-timeline">
            {tasks.map((task) => (
              <CreativeResults
                key={task.id}
                api={api}
                task={task}
                progress={progress[task.id] ?? []}
                navigate={navigate}
                busy={busy}
                action={async (task, operation) =>
                  action(async () => {
                    const updated = await api<CreativeTaskView>(
                      base + `/tasks/${task.id}/${operation}`,
                      {},
                    );
                    setTasks((tasks) =>
                      tasks.map((task) =>
                        task.id === updated.id ? updated : task,
                      ),
                    );
                    await refresh();
                  })
                }
              />
            ))}
          </div>
          <form
            className="creative-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void action(() => send());
            }}
          >
            <label>
              创作模型
              <select
                aria-label="创作模型"
                disabled={busy || Boolean(pending)}
                value={model}
                onChange={(event) => setModel(event.target.value)}
              >
                {models.map((choice) => (
                  <option
                    key={`${choice.provider}/${choice.id}`}
                    value={`${choice.provider}/${choice.id}`}
                  >
                    {choice.name ?? choice.id} · {choice.provider}
                  </option>
                ))}
              </select>
            </label>
            {selectedForRoute && (
              <div className="notice">
                <p>
                  已选择草稿：{selectedForRoute.title}（版本{" "}
                  {selectedForRoute.draftRevision}）
                </p>
                <button
                  type="button"
                  className="quiet"
                  disabled={Boolean(pending)}
                  onClick={() => {
                    setSelected(undefined);
                    navigate(`story/${storyId}/creative/${conversationId}`);
                  }}
                >
                  取消选择
                </button>
              </div>
            )}
            {selectionUnavailable && (
              <div className="notice">
                <p>所选草稿尚未确认，请等待读取完成或取消选择。</p>
                <button
                  type="button"
                  className="quiet"
                  onClick={() =>
                    navigate(`story/${storyId}/creative/${conversationId}`)
                  }
                >
                  取消选择
                </button>
              </div>
            )}
            <label>
              对故事说点什么
              <textarea
                aria-label="对故事说点什么"
                value={text}
                maxLength={16000}
                disabled={busy || Boolean(pending)}
                placeholder="例如：让林舟发现新的线索，先写一章给我看看。"
                onChange={(event) => setText(event.target.value)}
              />
            </label>
            <p className="muted">
              可先讨论、看草稿，或明确要求写一章并保存。新消息会停止上一轮并撤回尚未执行的保存授权。
            </p>
            <button
              disabled={
                busy ||
                loading ||
                !conversationId ||
                !text.trim() ||
                !model ||
                Boolean(pending) ||
                selectionUnavailable ||
                blocked
              }
              type="submit"
            >
              发送
            </button>
            {pending && (
              <div className="creative-unknown">
                <p>提交结果待核实。先查询原任务，不会自动再次发送。</p>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void action(queryPending)}
                >
                  查询原任务
                </button>
                <button
                  type="button"
                  className="quiet"
                  disabled={busy}
                  onClick={() => void action(() => send(pending))}
                >
                  用同一请求重试
                </button>
              </div>
            )}
          </form>
        </section>
        <aside className="creative-artifacts" aria-label="独立草稿">
          <h2>独立草稿</h2>
          <p className="muted">正文单独阅读；草稿保存为章节后仍保留原稿。</p>
          {!drafts.length && <p className="empty">本会话还没有草稿。</p>}
          {drafts.map((draft) => (
            <section key={draft.id} className="creative-draft-card">
              <h3>{draft.title}</h3>
              <p className="muted">
                版本 {draft.draftRevision} ·{" "}
                {draft.receipt ? "已有正式章节" : "尚未加入章节目录"}
              </p>
              <button
                className="secondary"
                onClick={() => navigate(`story/${storyId}/draft/${draft.id}`)}
              >
                阅读草稿
              </button>
            </section>
          ))}
        </aside>
      </div>
    </>
  );
}
