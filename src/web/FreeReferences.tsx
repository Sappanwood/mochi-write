import { useEffect, useRef, useState } from "react";
import type { Api } from "./api.js";
import { message } from "./api.js";
import {
  discover,
  resolveDiscovery,
  refKey,
  refLabel,
  kindLabel,
  type Reference,
  type Discovery,
} from "./free-client.js";
export function ReferenceChips({
  values,
  open,
  remove,
}: {
  values: Reference[];
  open: (r: Reference) => void;
  remove?: (r: Reference) => void;
}) {
  const labels = values.map((r) => {
    const fallback = r.title === refLabel(r.ref);
    const title = fallback
      ? r.ref.type === "candidate"
        ? r.ref.member_id
          ? "草稿成员"
          : "草稿"
        : (kindLabel[r.ref.kind] ?? "资料")
      : r.title;
    const version =
      r.ref.type === "candidate"
        ? "固定版本"
        : `${kindLabel[r.ref.kind]} v${r.ref.version}`;
    return {
      title,
      version,
      fallback: fallback || ["原版本不可用", "名称读取中"].includes(title),
    };
  });
  return (
    <div className="free-references">
      {values.length ? (
        values.map((r, index) => {
          const label = labels[index]!;
          const ambiguous =
            label.fallback ||
            labels.some(
              (other, otherIndex) =>
                otherIndex !== index &&
                other.title === label.title &&
                other.version === label.version,
            );
          const identifier =
            r.ref.type === "candidate"
              ? (r.ref.member_id ?? r.ref.draft_id)
              : r.ref.asset_id;
          const suffix = ambiguous ? ` · ${identifier.slice(0, 8)}` : "";
          return (
            <span className="free-reference" key={refKey(r.ref)}>
              <button
                className="quiet"
                title={refLabel(r.ref)}
                onClick={() => open(r)}
              >
                {label.title}
                <small>
                  {" "}
                  · {label.version}
                  {suffix}
                </small>
              </button>
              {remove && (
                <button
                  className="quiet"
                  aria-label={`删除引用 ${label.title}${suffix}`}
                  title="仅移除资料引用，消息中的文字会保留"
                  onClick={() => remove(r)}
                >
                  ×
                </button>
              )}
            </span>
          );
        })
      ) : (
        <span className="muted">无</span>
      )}
    </div>
  );
}
export function discoveryLabel(item: Discovery) {
  return item.type === "candidate"
    ? `${item.title} · ${kindLabel[item.artifact_kind]}候选 · 组 ${item.group_id.slice(0, 8)} · 第 ${item.ordinal} 稿`
    : `${item.name} · ${kindLabel[item.kind]} · ${item.story_id ? `故事 ${item.story_id.slice(0, 8)}` : "母版库"} · v${item.version} · ${item.asset_id.slice(0, 8)}`;
}
export function ReferenceSearch({
  api,
  base,
  query,
  storyId,
  select,
  onError,
  onResolving,
  completion = false,
  kind,
}: {
  api: Api;
  base: string;
  query: string;
  storyId?: string;
  kind?: string;
  select: (r: Reference) => void;
  onError: (error: string) => void;
  completion?: boolean;
  onResolving?: (value: boolean) => void;
}) {
  const [items, setItems] = useState<Discovery[]>([]),
    [loading, setLoading] = useState(true),
    [resolving, setResolving] = useState(false);
  const mounted = useRef(true),
    selecting = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      onResolving?.(false);
    };
  }, []);
  async function choose(item: Discovery) {
    if (selecting.current) return;
    selecting.current = true;
    setResolving(true);
    onResolving?.(true);
    try {
      const ref = await resolveDiscovery(api, base, item);
      if (mounted.current) select(ref);
    } catch (e) {
      if (mounted.current) onError(message(e));
    } finally {
      selecting.current = false;
      if (mounted.current) {
        setResolving(false);
        onResolving?.(false);
      }
    }
  }
  useEffect(() => {
    let active = true;
    setLoading(true);
    setItems([]);
    const timer = setTimeout(
      () =>
        void discover(api, base, query, kind, storyId)
          .then((v) => {
            if (active) setItems(v);
          })
          .catch((e) => {
            if (active) onError(message(e));
          })
          .finally(() => {
            if (active) setLoading(false);
          }),
      150,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, base, query, kind, storyId]);
  return (
    <div
      className="free-search-results"
      aria-label={completion ? "引用补全" : "资产与候选结果"}
    >
      {loading ? (
        <p role="status">正在检索…</p>
      ) : !items.length ? (
        <p>没有符合名称的结果。</p>
      ) : (
        items.map((item) => (
          <button
            className="quiet"
            key={item.type === "candidate" ? item.draft_id : item.asset_id}
            disabled={resolving}
            onClick={() => void choose(item)}
          >
            {discoveryLabel(item)}
          </button>
        ))
      )}
    </div>
  );
}
