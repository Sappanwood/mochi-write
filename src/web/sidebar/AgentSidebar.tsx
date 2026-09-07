import { useEffect, useRef, useState } from "react";
import type {
  HostAdapter,
  Reference,
  Task,
  ModelItem,
  ConversationItem,
} from "./contracts.js";
import { Markdown } from "../Markdown.js";
import { message as errorMessage } from "../api.js";
export function AgentSidebar({
  host,
  inputVersion,
}: {
  host: HostAdapter;
  inputVersion: string;
}) {
  const [open, setOpen] = useState(false),
    [error, setError] = useState(""),
    [label, setLabel] = useState(""),
    [refs, setRefs] = useState<Reference[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [conversations, setConversations] = useState<ConversationItem[]>([]),
    [conversation, setConversation] = useState(""),
    [models, setModels] = useState<ModelItem[]>([]),
    [model, setModel] = useState(""),
    [history, setHistory] = useState<{ role: string; content: string }[]>([]),
    [tasks, setTasks] = useState<Task[]>([]),
    [text, setText] = useState(""),
    [selection, setSelection] = useState(""),
    [feedback, setFeedback] = useState<string>(),
    [preview, setPreview] = useState(""),
    [request, setRequest] = useState<unknown>(),
    [busy, setBusy] = useState(false),
    [initializing, setInitializing] = useState(false);
  const cursors = useRef(new Map<string, number>());
  const chunks = useRef(new Map<string, string>());
  const currentHost = useRef(host);
  currentHost.current = host;
  const running = tasks.some((t) =>
    ["pending", "queued", "running"].includes(t.status),
  );
  function chooseConversation(id: string) {
    setConversation(id);
    sessionStorage.setItem(`mochi-sidebar:${host.scopeKey}`, id);
  }
  useEffect(() => {
    setRequest(undefined);
    setPreview("");
  }, [inputVersion]);
  function replace(task: Task) {
    setTasks((old) => [...old.filter((t) => t.id !== task.id), task]);
  }
  async function recover() {
    if (!conversation) return;
    setTasks(await host.tasks(conversation));
    setHistory(await host.history(conversation));
  }
  useEffect(() => {
    if (!open) return;
    let active = true;
    setInitializing(true);
    void Promise.all([
      host.getContext(),
      host.listConversation(),
      host.models(),
    ])
      .then(([context, list, choices]) => {
        if (!active) return;
        setLabel(context.label);
        setRefs(context.references);
        setSelected(context.references.slice(0, 1).map((r) => r.id));
        setConversations(list);
        const preferred = sessionStorage.getItem(
          `mochi-sidebar:${host.scopeKey}`,
        );
        setConversation(
          list.find((c) => c.id === preferred)?.id ?? list[0]?.id ?? "",
        );
        setModels(choices);
        setModel(choices[0] ? `${choices[0].provider}/${choices[0].id}` : "");
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      })
      .finally(() => {
        if (active) setInitializing(false);
      });
    return () => {
      active = false;
    };
  }, [host.scopeKey, open]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    void host
      .getContext()
      .then((context) => {
        if (active) {
          setLabel(context.label);
          setRefs(context.references);
          setSelected(context.references.slice(0, 1).map((r) => r.id));
          setPreview("");
          setRequest(undefined);
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [host, open]);
  useEffect(() => {
    setTasks([]);
    setHistory([]);
    setFeedback(undefined);
    setRequest(undefined);
    setPreview("");
    if (!conversation) return;
    let active = true;
    void Promise.all([host.tasks(conversation), host.history(conversation)])
      .then(([values, messages]) => {
        if (active) {
          setTasks(values);
          setHistory(messages);
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [conversation, host.scopeKey]);
  useEffect(() => {
    if (!open || !conversation) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const adapter = currentHost.current;
        const values = await adapter.tasks(conversation);
        const messages = await adapter.history(conversation);
        if (active) setHistory(messages);
        if (active)
          setTasks(
            values.map((v) => ({
              ...v,
              text: v.text || chunks.current.get(v.id) || "",
            })),
          );
        for (const value of values) {
          if (!["pending", "queued", "running"].includes(value.status))
            continue;
          const after = cursors.current.get(value.id) ?? 0;
          const events = await adapter.subscribe(value.id, after);
          let cursor = after,
            chunk = chunks.current.get(value.id) ?? "";
          for (const event of events.events) {
            if (event.cursor <= cursor) continue;
            cursor = event.cursor;
            if (event.type === "text_delta") chunk += event.data.text ?? "";
          }
          cursors.current.set(value.id, cursor);
          chunks.current.set(value.id, chunk);
          const task = await adapter.resume(value.id);
          if (active) replace({ ...task, text: task.text || chunk });
        }
        if (active) setError("");
      } catch (e) {
        if (active) setError(errorMessage(e) + "；任务不会因页面关闭而取消。");
      } finally {
        if (active) timer = setTimeout(() => void poll(), 1800);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [conversation, host.scopeKey, open]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const invalidate = () => {
    setRequest(undefined);
    setPreview("");
  };
  return (
    <aside
      className={"agent-sidebar" + (open ? " agent-open" : "")}
      aria-label="Agent 侧栏"
    >
      <button className="secondary" onClick={() => setOpen(!open)}>
        {open ? "收起写作助手" : "打开写作助手"}
      </button>
      {open && (
        <>
          <h2>写作助手</h2>
          <p>{label}</p>
          <p className="muted">发送时固定资料与目标；导航只影响下一次发送。</p>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <label>
            会话
            <select
              disabled={busy || initializing}
              aria-label="会话"
              value={conversation}
              onChange={(e) => chooseConversation(e.target.value)}
            >
              <option value="">请选择会话</option>
              {conversations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="secondary"
            disabled={busy || initializing}
            onClick={() =>
              void action(async () => {
                const c = await host.openConversation();
                setConversations((old) => [c, ...old]);
                chooseConversation(c.id);
              })
            }
          >
            新建会话
          </button>
          <label>
            模型
            <select
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                invalidate();
              }}
            >
              {models.map((m) => (
                <option
                  key={`${m.provider}/${m.id}`}
                  value={`${m.provider}/${m.id}`}
                >
                  {m.name} · {m.provider}
                </option>
              ))}
            </select>
          </label>
          <details>
            <summary>会话历史（由 Mochi 保存）</summary>
            {history.map((m, i) => (
              <div key={i}>
                <strong>{m.role === "user" ? "你" : "助手"}</strong>
                <Markdown text={m.content} />
              </div>
            ))}
          </details>
          <fieldset>
            <legend>本轮引用资料</legend>
            {refs.map((ref) => (
              <div key={ref.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.includes(ref.id)}
                    onChange={(e) => {
                      setSelected((old) =>
                        e.target.checked
                          ? [...old, ref.id]
                          : old.filter((id) => id !== ref.id),
                      );
                      invalidate();
                    }}
                  />
                  {ref.label}
                </label>
                <details>
                  <summary>预览资料</summary>
                  <Markdown text={ref.text} />
                </details>
              </div>
            ))}
          </fieldset>
          <label>
            选区文本（可粘贴或调整）
            <textarea
              value={selection}
              onChange={(e) => {
                setSelection(e.target.value);
                invalidate();
              }}
            />
          </label>
          {host.renderContextActions()}
          <label>
            本次要求
            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                invalidate();
              }}
            />
          </label>
          {feedback && (
            <p>
              正在反馈重写{" "}
              <button
                className="quiet"
                onClick={() => {
                  setFeedback(undefined);
                  invalidate();
                }}
              >
                取消重写
              </button>
            </p>
          )}
          <button
            disabled={
              busy || running || !conversation || !text.trim() || !model
            }
            onClick={() =>
              void action(async () => {
                const choice = models.find(
                  (m) => `${m.provider}/${m.id}` === model,
                )!;
                const resolved = await host.resolveContext(
                  conversation,
                  text,
                  choice,
                  refs.filter((r) => selected.includes(r.id)),
                  selection,
                  feedback,
                );
                setPreview(resolved.preview);
                setRequest(resolved.request);
              })
            }
          >
            预览发送内容
          </button>
          {request !== undefined && (
            <>
              <details open>
                <summary>固定发送内容</summary>
                <pre className="context-preview">{preview}</pre>
              </details>
              <button
                disabled={busy || initializing || running}
                onClick={() =>
                  void action(async () => {
                    replace(await host.submit(request));
                    setRequest(undefined);
                    setPreview("");
                    setText("");
                    setFeedback(undefined);
                  })
                }
              >
                确认发送
              </button>
              <p className="muted">
                提交结果未知时保留本请求，先查询任务，再以相同请求重试。
              </p>
            </>
          )}
          <button
            className="quiet"
            disabled={busy || !conversation}
            onClick={() => void action(recover)}
          >
            恢复查询
          </button>
          <div aria-label="任务结果">
            {tasks.map((t) => (
              <section key={t.id} className="agent-result">
                <p>状态：{t.status}</p>
                <p className="muted">
                  缓存读取：{t.usage?.cache_read ?? "未知"}
                </p>
                <Markdown text={t.text} />
                {t.status === "pending" && (
                  <button
                    className="secondary"
                    onClick={() =>
                      void action(async () => replace(await host.retry(t.id)))
                    }
                  >
                    用原请求重试提交
                  </button>
                )}
                {["pending", "queued", "running"].includes(t.status) && (
                  <button
                    className="secondary"
                    onClick={() =>
                      void action(async () => replace(await host.cancel(t.id)))
                    }
                  >
                    取消任务
                  </button>
                )}
                {t.status === "succeeded" && (
                  <button
                    className="secondary"
                    onClick={() => {
                      setFeedback(t.id);
                      invalidate();
                    }}
                  >
                    反馈重写
                  </button>
                )}
                {host.renderResultActions(t, () => void action(recover))}
              </section>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
