import { useMemo, useRef, useState } from "react";
import type { Document, Page } from "../shared/model.js";
import type {
  Conversation,
  DraftRecord,
  PageContext,
  Scope,
  Submit,
} from "../shared/writing.js";
import type { Api } from "./api.js";
import { message } from "./api.js";
import { AgentSidebar } from "./sidebar/AgentSidebar.js";
import type { HostAdapter, Task } from "./sidebar/contracts.js";
const task = (d: DraftRecord): Task => ({
  id: d.id,
  status: d.status,
  text: d.output,
  usage: d.usage,
});
export function WritingHost({ api, route }: { api: Api; route: string }) {
  const [target, setTarget] = useState("new"),
    [name, setName] = useState("新章节"),
    [order, setOrder] = useState(1);
  const form = useRef({ target, name, order });
  form.current = { target, name, order };
  const initializedScope = useRef("");
  const host = useMemo<HostAdapter>(() => {
    const [area, id, section, documentId] = route.split("/");
    const scope: Scope =
      area === "story" && id
        ? { type: "story", id }
        : { type: "library", id: "library" };
    const query = new URLSearchParams(scope).toString();
    const documents = new Map<string, Document>();
    let context: PageContext = {
      schemaVersion: 1,
      scope,
      location: null,
      selection: null,
    };
    const list = async (path: string) => {
      const docs: Document[] = [];
      let cursor: string | undefined;
      do {
        const page: Page = await api(
          path +
            (path.includes("?") ? "&" : "?") +
            "limit=100" +
            (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
        );
        docs.push(...page.items);
        cursor = page.cursor;
        if (docs.length > 1000) throw new Error("引用候选过多，请缩小故事范围");
      } while (cursor);
      return docs;
    };
    return {
      scopeKey: scope.type + ":" + scope.id,
      async getContext() {
        documents.clear();
        let docs: Document[], label: string;
        if (scope.type === "story") {
          const story = await api<Document>(`/stories/${scope.id}`);
          label = story.content.name;
          docs = (
            await Promise.all(
              ["chapter", "setting", "outline", "snapshot"].map((kind) =>
                list(`/stories/${scope.id}/documents?kind=${kind}`),
              ),
            )
          ).flat();
        } else {
          label = "资产库";
          docs = (
            await Promise.all(
              ["character", "world"].map((kind) =>
                list(`/library?kind=${kind}`),
              ),
            )
          ).flat();
        }
        if (initializedScope.current !== scope.type + scope.id) {
          initializedScope.current = scope.type + scope.id;
          setOrder(
            Math.max(
              0,
              ...docs
                .filter((d) => d.kind === "chapter")
                .map((d) => d.order ?? 0),
            ) + 1,
          );
        }
        docs.sort(
          (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id),
        );
        const current =
          area === "asset"
            ? docs.find((d) => d.id === id)
            : scope.type === "story"
              ? documentId
                ? docs.find((d) => d.id === documentId)
                : docs.find((d) => d.kind === section)
              : undefined;
        if (current) {
          context = {
            ...context,
            location: {
              id: current.id,
              type: current.kind,
              revision: current.revision,
            },
          };
          docs = [current, ...docs.filter((d) => d.id !== current.id)];
        }
        for (const d of docs) documents.set(d.id, d);
        return {
          label,
          references: docs.map((d) => ({
            id: d.id,
            revision: d.revision,
            label: `${d.content.name} · v${d.currentVersion}`,
            text: d.content.markdown,
          })),
        };
      },
      async listConversation() {
        const value = await api<{ items: Conversation[] }>(
          `/writing/conversations?${query}`,
        );
        return value.items.map((c) => ({
          id: c.id,
          label:
            new Date(c.createdAt).toLocaleString() + " · " + c.id.slice(0, 6),
        }));
      },
      async openConversation() {
        const c = await api<Conversation>("/writing/conversations", scope);
        return { id: c.id, label: new Date(c.createdAt).toLocaleString() };
      },
      async history(id) {
        return (
          await api<{ messages: { role: string; content: string }[] }>(
            `/writing/history?${query}&conversationId=${id}`,
          )
        ).messages;
      },
      async models() {
        return (
          await api<{
            models: { provider: string; id: string; name: string }[];
          }>("/writing/models")
        ).models;
      },
      async tasks(id) {
        return (
          await api<{ items: DraftRecord[] }>(
            `/writing/drafts?${query}&conversationId=${id}`,
          )
        ).items.map(task);
      },
      async resolveContext(
        conversationId,
        message,
        model,
        refs,
        selection,
        feedbackDraftId,
      ) {
        const { target, name, order } = form.current;
        let destination: Submit["target"] = null;
        if (scope.type === "story") {
          const doc =
            target === "current" && context.location
              ? documents.get(context.location.id)
              : undefined;
          if (target === "current" && doc?.kind !== "chapter")
            throw new Error("当前页面不是章节，请选择新章节");
          destination = {
            id: doc?.id ?? null,
            revision: doc?.revision ?? null,
            name: doc?.content.name ?? name,
            order: doc?.order ?? order,
          };
        }
        if (feedbackDraftId) {
          const previous = await api<DraftRecord>(
            `/writing/drafts/${feedbackDraftId}?${query}`,
          );
          destination = previous.request.target;
        }
        const input: Submit = {
          conversationId,
          clientRequestId: crypto.randomUUID(),
          message,
          provider: model.provider,
          model: model.id,
          pageContext: {
            ...context,
            selection: selection ? { text: selection } : null,
          },
          attachedRefs: refs.map((r) => ({ id: r.id, revision: r.revision })),
          target: destination,
          ...(feedbackDraftId ? { feedbackDraftId } : {}),
        };
        const resolved = await api<{ prompt: string }>(
          "/writing/context",
          input,
        );
        return {
          preview: `目标：${destination ? destination.name + "（顺序 " + destination.order + "）" : "仅对话，不采纳章节"}\n${resolved.prompt}`,
          request: input,
        };
      },
      async submit(request) {
        return task(await api<DraftRecord>("/writing/submit", request));
      },
      async retry(id) {
        const d = await api<DraftRecord>(`/writing/drafts/${id}?${query}`);
        return task(await api<DraftRecord>("/writing/submit", d.request));
      },
      async cancel(id) {
        return task(
          await api<DraftRecord>(`/writing/drafts/${id}/cancel?${query}`, {}),
        );
      },
      async resume(id) {
        return task(await api<DraftRecord>(`/writing/drafts/${id}?${query}`));
      },
      subscribe(id, after) {
        return api(`/writing/drafts/${id}/events?${query}&after=${after}`);
      },
      renderContextActions() {
        const { target, name, order } = form.current;
        return scope.type === "story" ? (
          <fieldset>
            <legend>采纳目标</legend>
            <label>
              目标章节
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="new">新章节</option>
                <option value="current">当前章节的新版本</option>
              </select>
            </label>
            {target === "new" && (
              <>
                <label>
                  新章节名称
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label>
                  章节顺序
                  <input
                    type="number"
                    min="1"
                    value={order}
                    onChange={(e) => setOrder(Number(e.target.value))}
                  />
                </label>
              </>
            )}
          </fieldset>
        ) : (
          <p className="muted">资产库会话仅提供建议，没有章节采纳操作。</p>
        );
      },
      renderResultActions(t, refresh) {
        return scope.type === "story" &&
          ["succeeded", "accepted"].includes(t.status) ? (
          <AcceptResult api={api} query={query} task={t} refresh={refresh} />
        ) : null;
      },
    };
  }, [api, route]);
  return (
    <AgentSidebar
      key={host.scopeKey}
      host={host}
      inputVersion={JSON.stringify([target, name, order])}
    />
  );
}
function AcceptResult({
  api,
  query,
  task,
  refresh,
}: {
  api: Api;
  query: string;
  task: Task;
  refresh: () => void;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<{ id: string; version: number }>();
  return (
    <div>
      {task.status === "succeeded" && (
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError("");
            void api<{ id: string; version: number }>(
              `/writing/drafts/${task.id}/accept?${query}`,
              {},
            )
              .then((value) => {
                setResult(value);
                refresh();
              })
              .catch((e) => setError(message(e)))
              .finally(() => setBusy(false));
          }}
        >
          采纳到固定章节
        </button>
      )}
      {task.status === "accepted" && (
        <p>
          已采纳{result ? `，第 ${result.version} 版` : ""}。重新打开章节查看。
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
