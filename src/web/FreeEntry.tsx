import { UpdatedTime } from "./ContentSummary.js";
import { useEffect, useState } from "react";
import type { FreeConversation, AssetRef } from "../shared/free.js";
import type { CandidateGroup } from "../shared/free-candidates.js";
import type { Document } from "../shared/model.js";
import { message, type Api } from "./api.js";
import { FreeWorkspace } from "./FreeWorkspace.js";
import {
  assetPath,
  pages,
  root,
  resolveDiscovery,
  kindLabel,
  taskStatusLabel,
  type TaskView,
  type Reference,
} from "./free-client.js";

export function FreeNewEntry({
  api,
  source,
  sourceId,
  navigate,
}: {
  api: Api;
  source?: string;
  sourceId?: string;
  navigate: (path: string) => void;
}) {
  const [reference, setReference] = useState<Reference>();
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);
  const scope = sourceId ? `${source}:${sourceId}` : (source ?? "new");
  useEffect(() => {
    if (!sourceId) return;
    let active = true;
    setError("");
    void (async () => {
      const saved = sessionStorage.getItem(`mochi-free:initial:${scope}`);
      if (saved) {
        if (active) setReference(JSON.parse(saved));
        return;
      }
      const doc = await api<Document>(
        source === "asset" ? `/library/${sourceId}` : `/stories/${sourceId}`,
      );
      const reference = await resolveDiscovery(api, root, {
        type: "asset",
        kind: doc.kind as AssetRef["kind"],
        asset_id: doc.id,
        ...(source === "story" ? { story_id: doc.id } : {}),
        revision: doc.revision,
        version: doc.currentVersion,
        name: doc.content.name,
      });
      if (active) {
        sessionStorage.setItem(
          `mochi-free:initial:${scope}`,
          JSON.stringify(reference),
        );
        setReference(reference);
      }
    })().catch((e) => {
      if (active) setError(message(e));
    });
    return () => {
      active = false;
    };
  }, [api, source, sourceId, scope, generation]);
  function refreshInitial() {
    sessionStorage.removeItem(`mochi-free:initial:${scope}`);
    setReference(undefined);
    setError("");
    setGeneration((value) => value + 1);
  }
  if (error)
    return (
      <p role="alert" className="error">
        {error}。
        <button className="quiet" onClick={refreshInitial}>
          重新读取初始资料
        </button>
      </p>
    );
  if (sourceId && !reference) return <p role="status">正在读取初始资料…</p>;
  return (
    <FreeWorkspace
      api={api}
      navigate={navigate}
      entryKey={scope}
      initialRefs={reference ? [reference.ref] : []}
      refreshInitial={sourceId ? refreshInitial : undefined}
      initialMessage={
        !sourceId && source === "character"
          ? "我想构思一个角色："
          : !sourceId && source === "world"
            ? "我想构思一个世界观："
            : !sourceId && source === "story"
              ? "我想构思一个故事："
              : ""
      }
    />
  );
}
interface SessionRow {
  conversation: FreeConversation;
  tasks: TaskView[];
  groups: CandidateGroup[];
}
export function FreeConversations({
  api,
  assetId,
  compact = false,
}: {
  api: Api;
  assetId?: string;
  compact?: boolean;
}) {
  const [rows, setRows] = useState<SessionRow[]>([]),
    [names, setNames] = useState<Record<string, string | null>>({}),
    [error, setError] = useState(""),
    [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      const conversations = await pages<FreeConversation>(
        api,
        root + "/conversations",
      );
      const selected = conversations.filter(
        (c) =>
          !assetId ||
          c.initialRefs.some(
            (r) =>
              r.type === "asset" &&
              (r.asset_id === assetId || r.story_id === assetId),
          ) ||
          c.associatedAssets.some(
            (t) => (t.kind !== "story" ? t.asset_id : t.story_id) === assetId,
          ),
      );
      const rows = await Promise.all(
        selected.map(async (conversation) => ({
          conversation,
          tasks: await pages<TaskView>(
            api,
            `${root}/conversations/${conversation.id}/tasks`,
          ),
          groups: await pages<CandidateGroup>(
            api,
            `${root}/conversations/${conversation.id}/groups`,
          ),
        })),
      );
      rows.forEach((r) =>
        r.tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      );
      rows.sort((a, b) =>
        (b.tasks.at(-1)?.createdAt ?? b.conversation.createdAt).localeCompare(
          a.tasks.at(-1)?.createdAt ?? a.conversation.createdAt,
        ),
      );
      if (active) {
        setRows(rows);
        setLoaded(true);
      }
      const targets = new Map(
        rows.flatMap(({ conversation }) =>
          conversation.associatedAssets.map((t) => [assetPath(t), t] as const),
        ),
      );
      const entries = await Promise.all(
        [...targets].map(async ([path, target]) => {
          try {
            const doc = await api<Document>(
              target.kind === "story"
                ? `/stories/${target.story_id}`
                : `/library/${target.asset_id}`,
            );
            return [path, doc.content.name] as const;
          } catch {
            return [path, null] as const;
          }
        }),
      );
      if (active) setNames(Object.fromEntries(entries));
    })().catch((e) => {
      if (active) setError(message(e));
    });
    return () => {
      active = false;
    };
  }, [api, assetId]);
  return (
    <section
      className="free-conversations"
      aria-label={compact ? "关联自由会话" : "自由会话列表"}
    >
      {!compact && (
        <header className="page-heading">
          <div>
            <p className="eyebrow">创作模式</p>
            <h1>自由创作会话</h1>
            <p>按会话继续讨论，成果可以关联多个角色、世界观或故事。</p>
          </div>
          <a className="list-new" href="#free/new">
            新建创作
          </a>
        </header>
      )}
      {compact && <h2>关联自由会话</h2>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!loaded && !error && <p role="status">正在读取会话…</p>}
      {loaded && !rows.length && (
        <p className="muted">
          暂无{compact ? "关联" : ""}自由会话。发送第一条消息后会出现在这里。
        </p>
      )}
      {rows.map(({ conversation: c, tasks, groups }) => (
        <article key={c.id} data-session-id={c.id}>
          <h2 className="session-title">
            <a
              href={`#free/conversation/${c.id}`}
              aria-label={`继续会话：${tasks[0]?.input.message.slice(0, 80) ?? "未命名会话"}`}
            >
              {tasks[0]?.input.message.slice(0, 80) ?? "未命名会话"}
            </a>
          </h2>
          <div className="session-meta">
            <UpdatedTime value={tasks.at(-1)?.createdAt ?? c.createdAt} />
            <span className="session-status">
              {taskStatusLabel(tasks.at(-1))}
            </span>
          </div>
          {tasks.at(-1) && (
            <p className="content-summary">
              最近消息：{tasks.at(-1)!.input.message}
            </p>
          )}
          <p>
            {groups.length} 组草稿 · {tasks.filter((t) => t.receipt).length}{" "}
            次已确认保存
          </p>
          <div className="free-associations">
            {c.associatedAssets.map((t) => (
              <a
                key={assetPath(t)}
                href={`#${assetPath(t)}`}
                title={t.kind !== "story" ? t.asset_id : t.story_id}
              >
                {kindLabel[t.kind]} ·{" "}
                {names[assetPath(t)] === undefined
                  ? "名称读取中"
                  : (names[assetPath(t)] ?? "内容暂不可用")}
                <small>
                  {" "}
                  · {(t.kind !== "story" ? t.asset_id : t.story_id).slice(0, 8)}
                </small>
              </a>
            ))}
            {c.initialRefs
              .filter((r): r is AssetRef => r.type === "asset")
              .map((r) => (
                <span key={r.asset_id}>
                  初始资料：{kindLabel[r.kind]} · {r.asset_id.slice(0, 8)} · v
                  {r.version}
                </span>
              ))}
          </div>
          {!c.associatedAssets.length && (
            <p className="muted">尚无正式成果，也可以继续此会话。</p>
          )}
        </article>
      ))}
    </section>
  );
}
export function AssetCreativeEntry({
  api,
  id,
  kind,
  navigate,
}: {
  api: Api;
  id: string;
  kind: "asset" | "story";
  navigate: (path: string) => void;
}) {
  return (
    <div className="asset-creative-entry">
      {kind === "asset" && (
        <button
          className="secondary"
          onClick={() => navigate(`free/new/${kind}/${id}`)}
        >
          带此{kind === "asset" ? "资产" : "故事"}开始创作
        </button>
      )}
      <details>
        <summary>创作与关联会话</summary>
        <p className="muted">
          以已保存内容开始讨论，未保存的编辑留在当前页面。
        </p>
        <FreeConversations api={api} assetId={id} compact />
      </details>
    </div>
  );
}
