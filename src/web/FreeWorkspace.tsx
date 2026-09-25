import "./free.css";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ExactRef, FreeConversation, FreeInput } from "../shared/free.js";
import type { CandidateGroup } from "../shared/free-candidates.js";
import type { ThinkingLevel } from "../shared/creative.js";
import { ApiError, message, type Api } from "./api.js";
import {
  CreativeModelPicker,
  type CreativeModel,
} from "./CreativeModelPicker.js";
import { ReferenceChips, ReferenceSearch } from "./FreeReferences.js";
import { FreeInformation, type ReadingState } from "./FreeInformation.js";
import { FreeSplit } from "./FreeSplit.js";
import { FreeTimeline } from "./FreeTimeline.js";
import {
  root,
  pages,
  blocksMessage,
  settleSubmission,
  refKey,
  refLabel,
  summaryRef,
  type Composer,
  type Reference,
  type TaskView,
  type TaskDetail,
  type Summary,
} from "./free-client.js";
interface Pending {
  input: FreeInput & { initialRefs?: ExactRef[] };
  sent: Composer;
}
interface Local {
  composer: Composer;
  reading: ReadingState;
  view: "discussion" | "information";
  pending?: Pending;
  layout?: "discussion" | "split" | "reading";
  discussionScroll?: number;
  following?: boolean;
}
const empty = (): Local => ({
  composer: { message: "", refs: [] },
  reading: {
    recent: [],
    explorer: false,
    query: "",
    kind: "",
    storyId: "",
    scroll: 0,
  },
  view: "discussion",
});
function stored(key: string): Local {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (
      value?.composer &&
      value?.reading &&
      ["discussion", "information"].includes(value.view)
    )
      return value;
  } catch {
    /* Server records remain authoritative. */
  }
  return empty();
}
export function FreeWorkspace({
  api,
  conversationId,
  navigate,
  initialRefs = [],
  entryKey = "new",
  initialMessage = "",
  refreshInitial,
}: {
  api: Api;
  conversationId?: string;
  navigate: (path: string) => void;
  initialRefs?: ExactRef[];
  entryKey?: string;
  initialMessage?: string;
  refreshInitial?: () => void;
}) {
  const key = `mochi-free:${conversationId ?? entryKey}`;
  const [local, setLocal] = useState<Local>(() => {
      const state = stored(key);
      if (!sessionStorage.getItem(key)) state.composer.message = initialMessage;
      return state;
    }),
    [conversation, setConversation] = useState<FreeConversation>(),
    [models, setModels] = useState<CreativeModel[]>([]),
    [model, setModel] = useState(""),
    [thinking, setThinking] = useState<ThinkingLevel | "">(""),
    [details, setDetails] = useState<TaskDetail[]>([]),
    [groups, setGroups] = useState<CandidateGroup[]>([]),
    [drafts, setDrafts] = useState<Summary[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [selectingReference, setSelectingReference] = useState(false),
    [loaded, setLoaded] = useState(!conversationId),
    [dismissed, setDismissed] = useState<string | null>(null);
  const current = useRef(true),
    refreshing = useRef(false),
    latestLocal = useRef(local),
    input = useRef<HTMLTextAreaElement>(null),
    completion = useRef<HTMLDivElement>(null),
    timeline = useRef<HTMLDivElement>(null),
    session = useRef<HTMLElement>(null),
    follow = useRef(local.following ?? true);
  const layout =
    local.layout ??
    (local.reading.current || local.reading.explorer ? "split" : "discussion");
  const base = conversationId
    ? `${root}/conversations/${conversationId}`
    : root;
  latestLocal.current = local;
  const timelineVersion = details
    .map(
      (d) =>
        `${d.task.id}:${d.task.state}:${d.task.output}:${d.candidates.length}`,
    )
    .join("|");
  useLayoutEffect(() => {
    const element = timeline.current;
    if (element?.clientHeight)
      element.scrollTop = follow.current
        ? element.scrollHeight
        : (latestLocal.current.discussionScroll ?? 0);
  }, [timelineVersion, local.view, layout]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const workspace = session.current?.closest<HTMLElement>(
      ".workspace-creative",
    );
    if (!viewport || !workspace) return;
    const resize = () => {
      if (viewport.scale !== 1) return;
      workspace.style.setProperty(
        "--free-viewport-height",
        `${viewport.height}px`,
      );
      workspace.style.setProperty(
        "--free-viewport-top",
        `${viewport.offsetTop}px`,
      );
    };
    resize();
    viewport.addEventListener("resize", resize);
    viewport.addEventListener("scroll", resize);
    return () => {
      viewport.removeEventListener("resize", resize);
      viewport.removeEventListener("scroll", resize);
      workspace.style.removeProperty("--free-viewport-height");
      workspace.style.removeProperty("--free-viewport-top");
    };
  }, []);
  useEffect(() => {
    sessionStorage.setItem(key, JSON.stringify(local));
  }, [key, local]);
  useEffect(() => {
    current.current = true;
    return () => {
      current.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    void api<{ models: CreativeModel[] }>("/writing/models")
      .then((v) => {
        if (!active) return;
        setModels(v.models);
        const preferred =
          v.models.find((m) => m.id === "deepseek-v4-flash") ?? v.models[0];
        setModel(preferred ? `${preferred.provider}/${preferred.id}` : "");
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    return () => {
      active = false;
    };
  }, [api]);
  async function refresh() {
    if (!conversationId || refreshing.current) return;
    refreshing.current = true;
    try {
      const [descriptor, tasks, groupList] = await Promise.all([
        api<{ conversation: FreeConversation }>(base),
        pages<TaskView>(api, base + "/tasks"),
        pages<CandidateGroup>(api, base + "/groups"),
      ]);
      const [full, versions] = await Promise.all([
        Promise.all(
          tasks.map(async (task) => {
            let cursor: string | null = null;
            let result: TaskDetail | undefined;
            do {
              const page: TaskDetail = await api(
                `${base}/tasks/${task.id}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
              );
              result = result
                ? { ...page, sources: [...result.sources, ...page.sources] }
                : page;
              cursor = page.nextCursor;
            } while (cursor);
            return result!;
          }),
        ),
        Promise.all(
          groupList.map((g) =>
            pages<Summary>(api, `${base}/groups/${g.id}/drafts`),
          ),
        ),
      ]);
      if (!current.current) return;
      setConversation(descriptor.conversation);
      setDetails(full);
      setGroups(groupList);
      setDrafts(versions.flat());
      setLoaded(true);
    } finally {
      refreshing.current = false;
    }
  }
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refresh();
      } catch (e) {
        if (active) setError(message(e));
      }
      if (active) timer = setTimeout(() => void poll(), 1200);
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, base]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      if (current.current) setError(message(e));
    } finally {
      if (current.current) setBusy(false);
    }
  }
  function open(ref: Reference) {
    setLocal((old) => ({
      ...old,
      view: "information",
      layout: old.layout === "reading" ? "reading" : "split",
      reading: {
        ...old.reading,
        current: ref,
        loadId: (old.reading.loadId ?? 0) + 1,
        explorer: false,
        scroll:
          old.reading.current &&
          refKey(old.reading.current.ref) === refKey(ref.ref)
            ? old.reading.scroll
            : (old.reading.scrollByRef?.[refKey(ref.ref)] ?? 0),
        recent: [
          ref,
          ...old.reading.recent.filter(
            (r) => refKey(r.ref) !== refKey(ref.ref),
          ),
        ].slice(0, 6),
      },
    }));
  }
  function attach(ref: Reference) {
    if (
      latestLocal.current.composer.refs.some(
        (r) => refKey(r.ref) === refKey(ref.ref),
      )
    )
      return true;
    if (latestLocal.current.composer.refs.length >= 8) {
      setError("每条消息最多引用 8 项");
      return false;
    }
    setLocal((old) => ({
      ...old,
      composer: { ...old.composer, refs: [...old.composer.refs, ref] },
    }));
    return true;
  }
  function feedback(ref: Reference, quote?: string) {
    const composer = latestLocal.current.composer;
    const alreadyAttached = composer.refs.some(
      (item) => refKey(item.ref) === refKey(ref.ref),
    );
    if (!alreadyAttached && composer.refs.length >= 8) {
      setError("每条消息最多引用 8 项，请先移除一项资料引用");
      return;
    }
    setError("");
    const excerpt = quote
      ? `针对《${ref.title}》的选中段落：\n${quote
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}\n\n修改意见：`
      : "";
    setLocal((old) => ({
      ...old,
      view: "discussion",
      layout: "split",
      composer: {
        message: excerpt
          ? [old.composer.message, excerpt].filter(Boolean).join("\n\n")
          : old.composer.message,
        refs: alreadyAttached ? old.composer.refs : [...old.composer.refs, ref],
      },
    }));
    requestAnimationFrame(() => {
      const element = input.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
      element.scrollTop = element.scrollHeight;
    });
  }
  function prepareSave(ref: Reference, request: string) {
    const composer = latestLocal.current.composer;
    if (
      composer.refs.some(
        (item) =>
          item.ref.type === "candidate" && refKey(item.ref) !== refKey(ref.ref),
      )
    ) {
      setError("原样保存需只保留这一稿，请先移除其他草稿引用");
      return;
    }
    const attached = composer.refs.some(
      (item) => refKey(item.ref) === refKey(ref.ref),
    );
    if (!attached && composer.refs.length >= 8) {
      setError("每条消息最多引用 8 项，请先移除一项资料引用");
      return;
    }
    setError("");
    setLocal((old) => ({
      ...old,
      view: "discussion",
      layout: "split",
      composer: {
        message: old.composer.message.includes(request)
          ? old.composer.message
          : [old.composer.message, request].filter(Boolean).join("\n\n"),
        refs: attached ? old.composer.refs : [...old.composer.refs, ref],
      },
    }));
    requestAnimationFrame(() => {
      const element = input.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
      element.scrollTop = element.scrollHeight;
    });
  }
  function acknowledge(
    pending: Pending,
    result: { conversation?: FreeConversation; task: TaskView },
  ) {
    if (!current.current) return;
    const next = {
      ...latestLocal.current,
      composer: settleSubmission(latestLocal.current.composer, pending.sent),
      pending: undefined,
    };
    if (!conversationId && result.conversation) {
      sessionStorage.setItem(
        `mochi-free:${result.conversation.id}`,
        JSON.stringify(next),
      );
      sessionStorage.removeItem(key);
      sessionStorage.removeItem(`mochi-free:initial:${entryKey}`);
      navigate(`free/conversation/${result.conversation.id}`);
    } else {
      setLocal(next);
      void refresh();
    }
  }
  async function send(retry?: Pending) {
    if (
      !retry &&
      (busy ||
        selectingReference ||
        local.pending ||
        !loaded ||
        details.some((d) => blocksMessage(d.task)))
    )
      return;
    const choice = models.find((m) => `${m.provider}/${m.id}` === model);
    const configuration =
      conversation?.configuration ??
      (choice
        ? {
            provider: choice.provider,
            model: choice.id,
            ...(thinking ? { thinkingLevel: thinking } : {}),
          }
        : undefined);
    if (!retry && (!configuration || !local.composer.message.trim())) return;
    const pending = retry ?? {
      sent: structuredClone(local.composer),
      input: {
        ...configuration!,
        clientRequestId: crypto.randomUUID(),
        message: local.composer.message,
        refs: local.composer.refs.map((r) => r.ref),
        ...(!conversationId && initialRefs.length ? { initialRefs } : {}),
      },
    };
    const preserved = { ...latestLocal.current, pending };
    sessionStorage.setItem(key, JSON.stringify(preserved));
    setLocal(preserved);
    try {
      const result = await api<{
        conversation?: FreeConversation;
        task: TaskView;
      }>(
        conversationId ? base + "/tasks" : root + "/conversations",
        pending.input,
      );
      acknowledge(pending, result);
    } catch (e) {
      if (e instanceof ApiError && [400, 401, 403, 404, 409].includes(e.status))
        setLocal((old) => ({ ...old, pending: undefined }));
      throw e;
    }
  }
  async function queryPending() {
    const pending = latestLocal.current.pending;
    if (!pending) return;
    const result = await api<{
      conversation?: FreeConversation;
      task: TaskView;
    }>(
      conversationId
        ? `${base}/tasks/${pending.input.clientRequestId}`
        : `${root}/conversations/by-request/${pending.input.clientRequestId}`,
    );
    acknowledge(pending, result);
  }
  const query = local.composer.message.match(/@([^@\n]*)$/)?.[1];
  const selectedQuery =
    query !== undefined && query !== dismissed ? query : undefined;
  const unseen = drafts.filter(
    (d) =>
      !local.reading.recent.some(
        (r) => r.ref.type === "candidate" && r.ref.draft_id === d.draft_id,
      ),
  );
  const blocked =
    !loaded ||
    busy ||
    selectingReference ||
    !!local.pending ||
    details.some((d) => blocksMessage(d.task));
  const setReading = (
    value: ReadingState | ((old: ReadingState) => ReadingState),
  ) =>
    setLocal((old) => ({
      ...old,
      reading: typeof value === "function" ? value(old.reading) : value,
    }));
  return (
    <section
      ref={session}
      className={`creative-session free-session free-view-${local.view} free-layout-${layout}${!details.length ? " free-empty" : ""}`}
    >
      <header className="free-session-heading">
        {details.length > 0 && (
          <div>
            <p className="eyebrow">创作会话</p>
            <h1 title={details[0]!.task.input.message}>
              {details[0]!.task.input.message.slice(0, 60)}
            </h1>
          </div>
        )}
        <details>
          <summary>会话信息</summary>
          <p className="free-identity">
            {conversationId ?? "发送第一条消息后建立会话"}
            {conversation?.sessionId && ` · ${conversation.sessionId}`}
          </p>
          <button className="quiet" onClick={() => navigate("free/new")}>
            新会话
          </button>
          <p>初始上下文</p>
          <ReferenceChips
            values={(conversation?.initialRefs ?? initialRefs).map((ref) => ({
              ref,
              title: refLabel(ref),
              recorded: !!conversationId,
            }))}
            open={open}
          />
        </details>
      </header>
      {conversation && !conversation.toolsetVersion && (
        <aside className="notice" aria-label="旧会话能力">
          <p>
            此会话保留原有角色与故事能力，世界观可讨论和阅读。生成或保存世界观请新建会话。
          </p>
          <p>
            聊天、候选稿和保存授权保留在这里；新会话可重新引用已保存的资产。
          </p>
          <button
            className="secondary"
            onClick={() => navigate("free/new/world")}
          >
            新建支持世界观的会话
          </button>
        </aside>
      )}
      {conversation && conversation.toolsetVersion !== "materials-v1" && (
        <aside className="notice" aria-label="故事资料能力">
          <p>
            此会话可继续使用原有能力。预览或保存已开篇故事的角色快照、设定和大纲，请新建会话。
          </p>
          <p>
            原聊天、候选稿和保存授权保留在这里；新会话可重新引用已保存的资产。
          </p>
          <button className="secondary" onClick={() => navigate("free/new")}>
            新建支持故事资料的会话
          </button>
        </aside>
      )}
      {(conversation?.initialRefs ?? initialRefs).length > 0 && (
        <div className="free-initial">
          <p>初始上下文 · 仅作为资料</p>
          {refreshInitial && (
            <button
              className="quiet"
              disabled={busy || !!local.pending}
              onClick={refreshInitial}
            >
              重新读取初始资料
            </button>
          )}
          <ReferenceChips
            values={(conversation?.initialRefs ?? initialRefs).map((ref) => ({
              ref,
              title: refLabel(ref),
              recorded: !!conversationId,
            }))}
            open={open}
          />
        </div>
      )}
      <div className="free-layout-actions">
        <button
          className="quiet"
          onClick={() =>
            setLocal((old) => ({
              ...old,
              layout: layout === "discussion" ? "split" : "discussion",
              view: "information",
              reading: {
                ...old.reading,
                explorer: old.reading.current ? old.reading.explorer : true,
              },
            }))
          }
        >
          {layout === "discussion" ? "资料与草稿" : "收起资料"}
        </button>
        {layout !== "discussion" && (
          <button
            className="quiet"
            onClick={() =>
              setLocal((old) => ({
                ...old,
                layout: layout === "reading" ? "split" : "reading",
              }))
            }
          >
            {layout === "reading" ? "返回讨论" : "专心阅读"}
          </button>
        )}
      </div>
      <div
        className="free-mobile-tabs"
        role="tablist"
        aria-label="自由会话视图"
      >
        {(["discussion", "information"] as const).map((v) => (
          <button
            key={v}
            role="tab"
            aria-selected={local.view === v}
            onClick={() => setLocal((old) => ({ ...old, view: v }))}
          >
            {v === "discussion" ? "讨论" : "信息"}
          </button>
        ))}
      </div>
      <div className="free-columns">
        <FreeSplit />
        <section className="free-discussion" aria-label="讨论">
          <div
            ref={timeline}
            onScroll={(e) => {
              const element = e.currentTarget;
              if (!element.clientHeight) return;
              follow.current =
                element.scrollHeight -
                  element.scrollTop -
                  element.clientHeight <
                80;
              setLocal((old) => ({
                ...old,
                discussionScroll: element.scrollTop,
                following: follow.current,
              }));
            }}
            className="free-timeline"
            role="region"
            aria-label="讨论内容"
          >
            <FreeTimeline
              details={details}
              navigate={navigate}
              open={open}
              busy={busy}
              operate={(id, operation) =>
                void action(async () => {
                  await api(`${base}/tasks/${id}/${operation}`, {});
                  await refresh();
                })
              }
            />
            {!details.length && (
              <div className="free-start">
                <h1>今天想写点什么？</h1>
                <p>从一个想法开始，也可以输入 @ 参考已有资料。</p>
                <div className="free-start-actions">
                  {["构思角色", "构思世界观", "写一个故事"].map((label) => (
                    <button
                      key={label}
                      className="secondary"
                      onClick={() => {
                        setLocal((old) => ({
                          ...old,
                          composer: {
                            ...old.composer,
                            message: old.composer.message || `我想${label}：`,
                          },
                        }));
                        input.current?.focus();
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
        <div className="free-composer" aria-label="消息输入">
          <div className="free-update" role="status">
            {unseen.length > 0 && (
              <button
                className="quiet"
                onClick={() => {
                  const d = unseen.at(-1)!;
                  open({
                    ref: summaryRef(d),
                    title: `${d.title} · 第 ${d.ordinal} 稿`,
                    recorded: true,
                  });
                }}
              >
                {unseen.length === 1
                  ? `第 ${unseen[0]!.ordinal} 稿已就绪`
                  : `${unseen.length} 份新稿已就绪`}{" "}
                · 打开
              </button>
            )}
          </div>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {local.pending && (
            <div className="notice">
              <p>发送结果待核实，保留原请求、输入和引用。</p>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void action(queryPending)}
              >
                查询原请求
              </button>
              <button
                className="quiet"
                disabled={busy}
                onClick={() => void action(() => send(local.pending))}
              >
                按原请求重试
              </button>
            </div>
          )}
          {local.composer.refs.length > 0 && (
            <div className="free-composer-references">
              <small>已引用到本消息</small>
              <ReferenceChips
                values={local.composer.refs}
                open={open}
                remove={(r) =>
                  setLocal((old) => ({
                    ...old,
                    composer: {
                      ...old.composer,
                      refs: old.composer.refs.filter(
                        (item) => refKey(item.ref) !== refKey(r.ref),
                      ),
                    },
                  }))
                }
              />
            </div>
          )}
          <label className="sr-only" htmlFor="free-message">
            下一条消息
          </label>
          <textarea
            ref={input}
            id="free-message"
            value={local.composer.message}
            placeholder="自由讨论，或输入 @ 查找精确引用"
            onChange={(e) => {
              const message = e.target.value;
              setDismissed(null);
              setLocal((old) => ({
                ...old,
                composer: { ...old.composer, message },
              }));
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && selectedQuery !== undefined) {
                e.preventDefault();
                completion.current
                  ?.querySelector<HTMLButtonElement>("button")
                  ?.focus();
              }
              if (e.key === "Escape" && query !== undefined)
                setDismissed(query);
            }}
          />
          {(selectedQuery !== undefined || selectingReference) && (
            <div
              ref={completion}
              className="free-completion"
              onKeyDown={(e) => {
                const buttons = [
                  ...completion.current!.querySelectorAll("button"),
                ];
                const index = buttons.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  buttons[
                    (index +
                      (e.key === "ArrowDown" ? 1 : -1) +
                      buttons.length) %
                      buttons.length
                  ]?.focus();
                }
                if (e.key === "Escape") {
                  setDismissed(query!);
                  input.current?.focus();
                }
              }}
            >
              <ReferenceSearch
                api={api}
                base={base}
                query={selectedQuery ?? ""}
                completion
                onResolving={setSelectingReference}
                storyId={local.reading.storyId || undefined}
                onError={setError}
                select={(r) => {
                  if (!attach(r)) return;
                  setLocal((old) => ({
                    ...old,
                    composer: {
                      ...old.composer,
                      message:
                        old.composer.message === local.composer.message
                          ? old.composer.message.replace(
                              /@[^@\n]*$/,
                              () => `${r.title} `,
                            )
                          : old.composer.message,
                    },
                  }));
                  input.current?.focus();
                }}
              />
            </div>
          )}
          <div className="free-send">
            <CreativeModelPicker
              models={models}
              model={model}
              thinking={thinking}
              onModel={setModel}
              onThinking={setThinking}
              locked={conversation?.configuration}
              disabled={busy || !!local.pending}
            />
            <button
              disabled={
                blocked ||
                !local.composer.message.trim() ||
                (!conversation && !model)
              }
              onClick={() => void action(() => send())}
            >
              发送
            </button>
          </div>
          {selectingReference && (
            <p role="status" className="muted">
              正在固定所选引用…
            </p>
          )}
          {blocked && !busy && !selectingReference && !local.pending && (
            <p className="muted">
              等待本轮结束；中断或结果未知时请核实原任务。输入和引用保持。
            </p>
          )}
        </div>
        <FreeInformation
          api={api}
          base={base}
          reading={local.reading}
          receiptsVersion={details
            .map((d) => d.task.receipt?.operation_id ?? "")
            .join("|")}
          setReading={setReading}
          groups={groups}
          drafts={drafts}
          attach={attach}
          feedback={feedback}
          prepareSave={prepareSave}
          open={open}
          onError={setError}
        />
      </div>
    </section>
  );
}
