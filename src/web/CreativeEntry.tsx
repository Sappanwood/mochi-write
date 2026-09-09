import { useEffect, useRef, useState } from "react";
import type {
  CreativeConversation,
  CreativeTaskView,
  ThinkingLevel,
} from "../shared/creative.js";
import { type Api, ApiError, message } from "./api.js";
import {
  CreativeModelPicker,
  type CreativeModel,
} from "./CreativeModelPicker.js";
import { CreativeWorkspace } from "./CreativeWorkspace.js";
export type LifecycleConversation = CreativeConversation & {
  established: boolean;
};
interface FirstRequest {
  clientRequestId: string;
  message: string;
  provider: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
}
const requestKey = "mochi-creative-first-request";
function pendingFirst(): FirstRequest | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(requestKey) ?? "null");
    if (
      value &&
      ["clientRequestId", "message", "provider", "model"].every(
        (k) => typeof value[k] === "string",
      )
    )
      return value;
  } catch {
    /* Invalid local recovery hints do not replace server records. */
  }
  return undefined;
}
export function NewCreativeStory({
  api,
  navigate,
}: {
  api: Api;
  navigate: (path: string) => void;
}) {
  const [pending, setPending] = useState(pendingFirst),
    [text, setText] = useState(() => pendingFirst()?.message ?? ""),
    [models, setModels] = useState<CreativeModel[]>([]),
    [model, setModel] = useState(""),
    [thinking, setThinking] = useState<ThinkingLevel | "">(
      () => pendingFirst()?.thinkingLevel ?? "",
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const initial = useRef(pending);
  function opened(result: {
    conversation: CreativeConversation;
    task: CreativeTaskView;
  }) {
    sessionStorage.removeItem(requestKey);
    sessionStorage.setItem(
      `mochi-creative:${result.conversation.storyId}`,
      result.conversation.id,
    );
    navigate(`creative/conversation/${result.conversation.id}`);
  }
  async function query(value = pending) {
    if (!value) return;
    setBusy(true);
    setError("");
    try {
      opened(
        await api(
          `/creative/conversations/by-request/${value.clientRequestId}`,
        ),
      );
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 404
          ? "暂未查到原请求。可以稍后查询，或用保留的同一请求重试。"
          : message(e),
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    void api<{ models: CreativeModel[] }>("/writing/models")
      .then((result) => {
        if (!active) return;
        setModels(result.models);
        const choice =
          result.models.find((m) => m.id === "deepseek-v4-flash") ??
          result.models[0];
        setModel(choice ? `${choice.provider}/${choice.id}` : "");
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    if (initial.current) void query(initial.current);
    return () => {
      active = false;
    };
  }, [api]);
  async function send(value?: FirstRequest) {
    const choice = models.find((m) => `${m.provider}/${m.id}` === model);
    if (!value && (!choice || !text.trim())) return;
    const request = value ?? {
      clientRequestId: crypto.randomUUID(),
      message: text,
      provider: choice!.provider,
      model: choice!.id,
      ...(thinking ? { thinkingLevel: thinking } : {}),
    };
    sessionStorage.setItem(requestKey, JSON.stringify(request));
    setPending(request);
    setBusy(true);
    setError("");
    try {
      opened(await api("/creative/conversations", request));
    } catch (e) {
      if (
        e instanceof ApiError &&
        [400, 401, 403, 404, 409, 413].includes(e.status)
      ) {
        sessionStorage.removeItem(requestKey);
        setPending(undefined);
      }
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button className="back-link" onClick={() => navigate("stories")}>
        ← 返回书架
      </button>
      <header className="page-heading">
        <div>
          <p className="eyebrow">新建故事</p>
          <h1>从一个想法开始</h1>
          <p>
            说说人物、世界或一个画面。先聊清楚，再决定何时建立作品、保存第一章。
          </p>
        </div>
      </header>
      <form
        className="creative-composer creative-entry"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <CreativeModelPicker
          models={models}
          model={model}
          thinking={thinking}
          onModel={setModel}
          onThinking={setThinking}
          locked={pending}
          disabled={busy || Boolean(pending)}
        />
        <p className="muted">首次发送后，本会话的模型与思考强度固定。</p>
        <label>
          对故事说点什么
          <textarea
            aria-label="对故事说点什么"
            value={text}
            maxLength={16000}
            disabled={busy || Boolean(pending)}
            onChange={(e) => setText(e.target.value)}
            placeholder="例如：想写一个海边小镇的悬疑故事，先找个合适的侦探角色，一起聊聊开场。"
          />
        </label>
        <p className="muted">
          角色和世界观会按需检索；也可以从零创作。首次发送后，可从创作会话入口回来继续。
        </p>
        <button
          type="submit"
          disabled={busy || Boolean(pending) || !model || !text.trim()}
        >
          发送
        </button>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {pending && (
          <div className="creative-unknown">
            <p>首次提交结果待核实。刷新只查询原请求，不会重新发送。</p>
            <div className="creative-navigation">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void query()}
              >
                查询原请求
              </button>
              <button
                type="button"
                className="quiet"
                disabled={busy}
                onClick={() => void send(pending)}
              >
                用同一请求重试
              </button>
            </div>
          </div>
        )}
      </form>
    </>
  );
}
export function CreativeConversations({
  api,
  navigate,
}: {
  api: Api;
  navigate: (path: string) => void;
}) {
  const [items, setItems] = useState<LifecycleConversation[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    void api<{ items: LifecycleConversation[] }>("/creative/conversations")
      .then((result) => {
        if (active)
          setItems(
            result.items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
          );
      })
      .catch((e) => {
        if (active) setError(message(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api]);
  return (
    <>
      <header className="page-heading">
        <div>
          <p className="eyebrow">继续创作</p>
          <h1>创作会话</h1>
          <p>回到原来的讨论、资料与草稿。</p>
        </div>
        <button onClick={() => navigate("creative/new")}>新建故事</button>
      </header>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {loading && <p role="status">正在读取会话…</p>}
      {!loading && !error && !items.length && (
        <p className="empty">
          还没有从想法开始的会话。发送第一条消息后，这里就能找回。
        </p>
      )}
      <div className="creative-session-list">
        {items.map((c) => (
          <button
            key={c.id}
            className="creative-session-card"
            onClick={() => navigate(`creative/conversation/${c.id}`)}
          >
            <span className="eyebrow">
              {c.established ? "作品已建立" : "尚未建立作品"}
            </span>
            <h2>{c.initialInput?.message.slice(0, 100) ?? "创作会话"}</h2>
            <p>{new Date(c.updatedAt).toLocaleString()} · 返回原会话 →</p>
          </button>
        ))}
      </div>
    </>
  );
}
export function LifecycleWorkspace({
  api,
  conversationId,
  selectedDraftId,
  navigate,
}: {
  api: Api;
  conversationId: string;
  selectedDraftId?: string;
  navigate: (path: string) => void;
}) {
  const [conversation, setConversation] = useState<LifecycleConversation>(),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api<LifecycleConversation>(`/creative/conversations/${conversationId}`)
      .then((c) => {
        if (active) {
          setConversation(c);
          sessionStorage.setItem(`mochi-creative:${c.storyId}`, c.id);
        }
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    return () => {
      active = false;
    };
  }, [api, conversationId]);
  return conversation ? (
    <CreativeWorkspace
      api={api}
      storyId={conversation.storyId}
      conversationId={conversationId}
      selectedDraftId={selectedDraftId}
      navigate={navigate}
      lifecycle
    />
  ) : error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : (
    <p role="status">正在恢复创作会话…</p>
  );
}
