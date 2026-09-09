import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  CreativeConversation,
  CreativeDraft,
  CreativeTaskView,
  DraftRef,
  ThinkingLevel,
} from "../shared/creative.js";
import type { LifecycleConversation } from "./CreativeEntry.js";
import { InitializationScope } from "./InitializationReading.js";
import { CreativeDraftPane } from "./CreativeDraftPane.js";
import {
  CreativeModelPicker,
  type CreativeModel,
} from "./CreativeModelPicker.js";
import type { Document } from "../shared/model.js";
import { type Api, ApiError, message } from "./api.js";
import {
  CreativeResults,
  type ToolProgress,
  activeCreativeTask,
} from "./CreativeResults.js";

interface Request {
  conversationId: string;
  clientRequestId: string;
  message: string;
  provider: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
  selectedDraft?: DraftRef;
}
function readPending(conversationId?: string): Request | undefined {
  if (!conversationId) return;
  try {
    const value = JSON.parse(
      sessionStorage.getItem(`mochi-creative-pending:${conversationId}`) ??
        "null",
    );
    if (
      value?.conversationId === conversationId &&
      ["clientRequestId", "message", "provider", "model"].every(
        (k) => typeof value[k] === "string",
      )
    )
      return value;
  } catch {
    /* Only server records establish whether a request exists. */
  }
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
  lifecycle = false,
  navigate,
}: {
  api: Api;
  storyId: string;
  conversationId?: string;
  selectedDraftId?: string;
  lifecycle?: boolean;
  navigate: (path: string) => void;
}) {
  const [story, setStory] = useState<Document>(),
    [conversations, setConversations] = useState<CreativeConversation[]>([]),
    [models, setModels] = useState<CreativeModel[]>([]),
    [model, setModel] = useState(""),
    [thinking, setThinking] = useState<ThinkingLevel | "">(""),
    [tasks, setTasks] = useState<CreativeTaskView[]>([]),
    [drafts, setDrafts] = useState<CreativeDraft[]>([]),
    [selected, setSelected] = useState<CreativeDraft>(),
    [text, setText] = useState(
      () => readPending(conversationId)?.message ?? "",
    ),
    [error, setError] = useState(""),
    [syncError, setSyncError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [pending, setPending] = useState<Request | undefined>(() =>
      readPending(conversationId),
    ),
    [progress, setProgress] = useState<Record<string, ToolProgress[]>>({});
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [view, setView] = useState<"conversation" | "draft">("conversation");
  const [viewedDraftId, setViewedDraftId] = useState<string>();
  const [seenDrafts, setSeenDrafts] = useState<string[]>([]);
  const timeline = useRef<HTMLDivElement>(null);
  const followConversation = useRef(true);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const carriedSelection = useRef<CreativeDraft | undefined>(undefined);
  const [saveScopeOpen, setSaveScopeOpen] = useState(false);
  const base = `/stories/${storyId}/creative`;
  const cursors = useRef(new Map<string, number>());
  const current = useRef(true);
  const refreshing = useRef(false);
  const taskProgress = useRef<Record<string, ToolProgress[]>>({});
  const pendingRef = useRef<Request | undefined>(pending);
  const ended = useRef(new Set<string>());
  const selectedForRoute = selectedDraftId
    ? selected?.id === selectedDraftId
      ? selected
      : undefined
    : selected;
  const selectionUnavailable = Boolean(selectedDraftId && !selectedForRoute);
  useEffect(() => {
    current.current = true;
    return () => {
      current.current = false;
    };
  }, []);
  const conversationPath = lifecycle
    ? `creative/conversation/${conversationId}`
    : `story/${storyId}/creative/${conversationId}`;
  function choose(id: string, isLifecycle = false) {
    sessionStorage.setItem(`mochi-creative:${storyId}`, id);
    navigate(
      isLifecycle
        ? `creative/conversation/${id}`
        : `story/${storyId}/creative/${id}`,
    );
  }
  useEffect(() => {
    let active = true;
    void (async () => {
      const choices = await api<{ models: CreativeModel[] }>("/writing/models");
      if (lifecycle && conversationId) {
        const conversation = await api<LifecycleConversation>(
          `/creative/conversations/${conversationId}`,
        );
        const story = conversation.established
          ? await api<Document>(`/stories/${storyId}`)
          : undefined;
        return [story, { items: [conversation] }, choices] as const;
      }
      return [
        await api<Document>(`/stories/${storyId}`),
        await api<{ items: CreativeConversation[] }>(base + "/conversations"),
        choices,
      ] as const;
    })()
      .then(([story, list, choices]) => {
        if (!active) return;
        setStory(story);
        setConversations([...list.items]);
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
          choose(chosen.id, chosen.lifecycle);
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
    setSelected(carriedSelection.current);
    carriedSelection.current = undefined;
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
        setViewedDraftId(draft.id);
        setView("draft");
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
      const [result, drafts, descriptor] = await Promise.all([
        api<{ items: CreativeTaskView[] }>(
          base + `/tasks?conversationId=${conversationId}`,
        ),
        api<{ items: CreativeDraft[] }>(
          base + `/drafts?conversationId=${conversationId}`,
        ),
        lifecycle
          ? api<LifecycleConversation>(
              `/creative/conversations/${conversationId}`,
            )
          : Promise.resolve(undefined),
      ]);
      if (descriptor?.established) {
        const value = await api<Document>(`/stories/${storyId}`);
        if (current.current) setStory(value);
      }
      if (!current.current) return;
      setTasks(result.items);
      setHistoryLoaded(true);
      setDrafts(
        [...drafts.items].sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
      );
      setViewedDraftId(
        (id) =>
          id ??
          [...drafts.items]
            .sort(
              (a, b) =>
                a.createdAt.localeCompare(b.createdAt) ||
                a.id.localeCompare(b.id),
            )
            .at(-1)?.id,
      );
      if (
        pendingRef.current &&
        result.items.some(
          (task) => task.id === pendingRef.current!.clientRequestId,
        )
      ) {
        pendingRef.current = undefined;
        sessionStorage.removeItem(`mochi-creative-pending:${conversationId}`);
        setPending(undefined);
        setText("");
        if (selectedDraftId) {
          carriedSelection.current = selectedForRoute;
          navigate(conversationPath);
        }
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
        sessionStorage.removeItem(`mochi-creative-pending:${conversationId}`);
        setText("");
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
  const lastTask = tasks.at(-1);
  const fixedConfiguration =
    conversations.find((c) => c.id === conversationId)?.configuration ??
    (lastTask
      ? {
          provider: lastTask.provider,
          model: lastTask.model,
          ...(lastTask.thinkingLevel
            ? { thinkingLevel: lastTask.thinkingLevel }
            : {}),
        }
      : undefined);
  async function send(request?: Request) {
    const choice = fixedConfiguration
      ? { provider: fixedConfiguration.provider, id: fixedConfiguration.model }
      : models.find((choice) => `${choice.provider}/${choice.id}` === model);
    if (!request && (!choice || !conversationId || selectionUnavailable))
      return;
    const value: Request = request ?? {
      conversationId: conversationId!,
      clientRequestId: crypto.randomUUID(),
      message: text,
      provider: choice!.provider,
      model: choice!.id,
      ...((fixedConfiguration ? fixedConfiguration.thinkingLevel : thinking)
        ? {
            thinkingLevel: (fixedConfiguration
              ? fixedConfiguration.thinkingLevel
              : thinking) as ThinkingLevel,
          }
        : {}),
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
    sessionStorage.setItem(
      `mochi-creative-pending:${conversationId}`,
      JSON.stringify(value),
    );
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
      sessionStorage.removeItem(`mochi-creative-pending:${conversationId}`);
      setPending(undefined);
      setText("");
      if (selectedDraftId) {
        carriedSelection.current = selectedForRoute;
        navigate(conversationPath);
      }
    } catch (error) {
      if (
        error instanceof ApiError &&
        [400, 401, 403, 404, 409].includes(error.status)
      ) {
        pendingRef.current = undefined;
        sessionStorage.removeItem(`mochi-creative-pending:${conversationId}`);
        setPending(undefined);
      }
      throw error;
    }
  }
  const viewedDraft =
    drafts.find((draft) => draft.id === viewedDraftId) ??
    (selected?.id === viewedDraftId ? selected : undefined);
  useEffect(() => {
    if (viewedDraft && !selectedDraftId && !pendingRef.current)
      setSelected(viewedDraft);
  }, [viewedDraft?.id]);
  const latestDraft = drafts.at(-1);
  const hasNewDraft = Boolean(
    latestDraft && !seenDrafts.includes(latestDraft.id),
  );
  function readDraft(draft: CreativeDraft) {
    setViewedDraftId(draft.id);
    setSeenDrafts((ids) => (ids.includes(draft.id) ? ids : [...ids, draft.id]));
    setView("draft");
    if (!pending) {
      setSelected(draft);
      if (selectedDraftId && selectedDraftId !== draft.id) {
        carriedSelection.current = draft;
        navigate(conversationPath);
      }
    }
  }
  function prepareSave(draft: CreativeDraft) {
    readDraft(draft);
    setText("保存这个版本");
    setSaveScopeOpen(true);
    composerInput.current?.focus();
  }
  const conversationContent = tasks
    .map(
      (task) =>
        `${task.id}:${task.output}:${task.status}:${task.artifacts.length}`,
    )
    .join("|");
  useLayoutEffect(() => {
    const element = timeline.current;
    if (element && followConversation.current && view === "conversation")
      element.scrollTop = element.scrollHeight;
  }, [conversationContent, view]);
  const blocked = tasks.some(
    (task) =>
      task.stopPending || (!task.receipt && task.operationStatus === "unknown"),
  );
  return (
    <section className="creative-session">
      <div className="creative-session-topbar">
        <button className="back-link" onClick={() => navigate("stories")}>
          ← 返回书架
        </button>
        <details className="creative-session-menu">
          <summary>会话与导航</summary>{" "}
          <div className="creative-controls">
            {!lifecycle && (
              <label>
                创作会话
                <select
                  aria-label="创作会话"
                  value={conversationId ?? ""}
                  disabled={busy || loading}
                  onChange={(e) =>
                    choose(
                      e.target.value,
                      conversations.find((c) => c.id === e.target.value)
                        ?.lifecycle,
                    )
                  }
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
            )}
            {lifecycle && (
              <button
                className="quiet"
                onClick={() => navigate("creative/conversations")}
              >
                全部创作会话
              </button>
            )}
            {!lifecycle || story ? (
              <button
                className="secondary"
                disabled={busy || loading}
                onClick={() =>
                  void action(async () => {
                    const conversation = await api<CreativeConversation>(
                      base + "/conversations",
                      {},
                    );
                    choose(conversation.id, conversation.lifecycle);
                  })
                }
              >
                新建创作会话
              </button>
            ) : (
              <button
                className="secondary"
                onClick={() => navigate("creative/new")}
              >
                新建故事
              </button>
            )}
          </div>
        </details>
      </div>
      <header className="page-heading creative-heading">
        <div>
          <h1>
            {story?.content.name ??
              (lifecycle ? "尚未建立作品" : "正在读取故事…")}
          </h1>
          <p className="creative-story-description">
            {lifecycle
              ? story
                ? story.initializationPending
                  ? "作品已建立，还没有章节。继续在这里创作第一章。"
                  : "作品已保存，在当前会话继续创作。"
                : "先讨论、检索资料或看看草稿，确认后再建立作品。"
              : "说说想看怎样的故事，让 Agent 自主取材、写出下一页。"}
          </p>
        </div>
        {(!lifecycle || story) && (
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
        )}
      </header>
      {(error || syncError) && (
        <p role="alert" className="error">
          {error || syncError}
        </p>
      )}
      <nav
        className="creative-view-tabs"
        role="tablist"
        aria-label="创作视图"
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          const tabs =
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              "[role=tab]",
            );
          const index =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? 1
                : view === "conversation"
                  ? 1
                  : 0;
          tabs[index]?.focus();
          tabs[index]?.click();
        }}
      >
        <button
          role="tab"
          id="creative-conversation-tab"
          aria-controls="creative-conversation-panel"
          aria-selected={view === "conversation"}
          tabIndex={view === "conversation" ? 0 : -1}
          onClick={() => setView("conversation")}
        >
          对话
        </button>
        <button
          role="tab"
          id="creative-draft-tab"
          aria-controls="creative-draft-panel"
          aria-selected={view === "draft"}
          tabIndex={view === "draft" ? 0 : -1}
          onClick={() => {
            setView("draft");
            if (viewedDraft) readDraft(viewedDraft);
          }}
        >
          草稿{hasNewDraft ? " · 有更新" : ""}
        </button>
      </nav>
      <div className="creative-layout" data-view={view}>
        <section
          className="creative-conversation"
          id="creative-conversation-panel"
          aria-label="创作会话"
        >
          <h2 className="sr-only">创作会话</h2>
          {loading && <p role="status">正在读取会话…</p>}
          {!loading && !conversationId && (
            <div className="empty">
              <p>新建一个会话，聊聊故事的下一步。</p>
              <button
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const conversation = await api<CreativeConversation>(
                      base + "/conversations",
                      {},
                    );
                    choose(conversation.id, conversation.lifecycle);
                  })
                }
              >
                开始对话
              </button>
            </div>
          )}
          <div
            className="creative-timeline"
            ref={timeline}
            role="region"
            aria-label="对话内容"
            tabIndex={0}
            onScroll={(event) => {
              const element = event.currentTarget;
              if (element.clientHeight)
                followConversation.current =
                  element.scrollHeight -
                    element.scrollTop -
                    element.clientHeight <
                  64;
            }}
          >
            {tasks.map((task) => (
              <CreativeResults
                key={task.id}
                api={api}
                task={task}
                drafts={drafts.filter((draft) => draft.taskId === task.id)}
                onReadDraft={readDraft}
                lifecycle={lifecycle}
                progress={progress[task.id] ?? []}
                savedDraft={
                  task.receipt
                    ? drafts.find(
                        (d) =>
                          d.receipt?.operation_id ===
                          task.receipt!.operation_id,
                      )
                    : undefined
                }
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
        </section>
        <CreativeDraftPane
          drafts={drafts}
          draft={viewedDraft}
          onChoose={readDraft}
          onSave={prepareSave}
          disabled={busy || Boolean(pending) || blocked || !conversationId}
          navigate={navigate}
        />
        <form
          className="creative-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void action(() => send());
          }}
        >
          {selectedForRoute && (
            <div className="creative-reference">
              <p>
                当前引用：{selectedForRoute.title}
                {drafts.some((draft) => draft.id === selectedForRoute.id)
                  ? ` · 第 ${drafts.findIndex((draft) => draft.id === selectedForRoute.id) + 1} 稿`
                  : ""}
              </p>
              {selectedForRoute.initialization && (
                <details
                  className="creative-reference-scope"
                  open={saveScopeOpen}
                  onToggle={(e) => setSaveScopeOpen(e.currentTarget.open)}
                >
                  <summary>保存范围</summary>
                  <InitializationScope
                    value={selectedForRoute.initialization}
                  />
                </details>
              )}
              <button
                type="button"
                className="quiet"
                disabled={Boolean(pending)}
                onClick={() => {
                  setSelected(undefined);
                  navigate(conversationPath);
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
                onClick={() => navigate(conversationPath)}
              >
                取消选择
              </button>
            </div>
          )}
          <label className="creative-message-input">
            <span className="sr-only">对故事说点什么</span>
            <textarea
              ref={composerInput}
              rows={2}
              aria-label="对故事说点什么"
              value={text}
              maxLength={16000}
              disabled={busy || Boolean(pending)}
              placeholder={
                selectedForRoute
                  ? "说说这一版想怎么调整…"
                  : "聊聊接下来想写什么…"
              }
              onChange={(event) => setText(event.target.value)}
            />
          </label>

          <div className="creative-composer-footer">
            <CreativeModelPicker
              models={models}
              model={model}
              thinking={thinking}
              onModel={setModel}
              onThinking={setThinking}
              locked={fixedConfiguration}
              disabled={
                busy ||
                Boolean(pending) ||
                loading ||
                Boolean(conversationId && !historyLoaded)
              }
            />
            <span className="muted creative-compose-status" role="status">
              {tasks.some(activeCreativeTask)
                ? selectedForRoute
                  ? "正在处理这版草稿…"
                  : "正在创作…"
                : ""}
            </span>
            <button
              disabled={
                busy ||
                loading ||
                !conversationId ||
                !historyLoaded ||
                !text.trim() ||
                (!fixedConfiguration && !model) ||
                Boolean(pending) ||
                selectionUnavailable ||
                blocked
              }
              type="submit"
            >
              发送
            </button>
          </div>

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
        </form>{" "}
      </div>
    </section>
  );
}
