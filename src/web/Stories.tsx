import { AssetCreativeEntry } from "./FreeEntry.js";
import { useEffect, useState } from "react";
import type { Document, Page } from "../shared/model.js";
import { type Api, message } from "./api.js";
import { ContentReading } from "./ContentReading.js";
import { PortraitImage } from "./PortraitImage.js";
import { ContentSummary, UpdatedTime } from "./ContentSummary.js";
import { StoryGuidance } from "./StoryGuidance.js";
export function StoriesView({
  api,
  navigate,
}: {
  api: Api;
  navigate: (path: string) => void;
}) {
  const [page, setPage] = useState<Page>({ items: [] }),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  async function more() {
    try {
      const next = await api<Page>(
        `/stories?cursor=${encodeURIComponent(page.cursor!)}`,
      );
      setPage((p) => ({ ...next, items: [...p.items, ...next.items] }));
    } catch (e) {
      setError(message(e));
    }
  }
  useEffect(() => {
    let active = true;
    void api<Page>("/stories")
      .then((p) => {
        if (active) setPage(p);
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
          <p className="eyebrow">故事书架</p>
          <h1>你的故事</h1>
          <p>阅读已保存的故事，也可以继续创作。</p>
        </div>
        <div className="creative-navigation">
          <button onClick={() => navigate("free/new/story")}>新建故事</button>
        </div>
      </header>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {loading && <p role="status">正在读取…</p>}
      {!loading && !error && !page.items.length && (
        <div className="empty">书架上还没有故事。先聊聊你的想法。</div>
      )}
      <div className="story-grid">
        {page.items.map((s, i) => (
          <button
            className="story-card"
            key={s.id}
            onClick={() => navigate(`story/${s.id}/chapter`)}
          >
            <div className={`book-cover cover-${i % 3}`}>
              <h2 title={s.content.name}>{s.content.name}</h2>
              <span>
                {s.initializationPending
                  ? "作品已建立 · 尚无章节"
                  : "故事 · 正式内容"}
              </span>
            </div>
            <ContentSummary markdown={s.content.markdown} />
            <p className="content-updated">
              资料更新于 <UpdatedTime value={s.updatedAt} />
            </p>
            <p>阅读故事 →</p>
          </button>
        ))}
      </div>
      {page.cursor && (
        <button className="secondary" onClick={() => void more()}>
          加载更多
        </button>
      )}
    </>
  );
}
const labels = {
  chapter: "章节",
  setting: "设定与关系",
  outline: "大纲",
  snapshot: "故事资产",
};
export type StorySection = keyof typeof labels;
export function StoryReader({
  api,
  id,
  section,
  documentId,
  navigate,
}: {
  api: Api;
  id: string;
  section: StorySection;
  documentId?: string;
  navigate: (path: string) => void;
}) {
  const [story, setStory] = useState<Document>(),
    [docs, setDocs] = useState<Document[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [adding, setAdding] = useState(false),
    [generation, setGeneration] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void (async () => {
      const story = await api<Document>(`/stories/${id}`);
      const docs: Document[] = [];
      let cursor: string | undefined;
      do {
        const page: Page = await api<Page>(
          `/stories/${id}/documents?kind=${section}&limit=100${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
        );
        docs.push(...page.items);
        cursor = page.cursor;
        if (docs.length > 1000)
          throw new Error("当前阅读范围过大，请缩小导入范围");
      } while (cursor);
      docs.sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id),
      );
      if (active) {
        setStory(story);
        setDocs(docs);
      }
    })()
      .catch((e) => {
        if (active) setError(message(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, id, section, generation]);
  const current = documentId ? docs.find((d) => d.id === documentId) : docs[0];
  const index = docs.findIndex((d) => d.id === current?.id);
  const hasOpeningHeading = /^ {0,3}#{1,6}[\t ]+\S/.test(
    current?.content.markdown.replace(/^(?:[\t ]*\r?\n)+/, "") ?? "",
  );
  return (
    <section className="story-reader">
      <button className="back-link" onClick={() => navigate("stories")}>
        ← 返回书架
      </button>
      <header className="page-heading">
        <div>
          <p className="eyebrow">故事阅读</p>
          <h1>{story?.content.name ?? "正在读取故事…"}</h1>
        </div>
        <button
          className="secondary"
          onClick={() => navigate(`free/new/story/${id}`)}
        >
          带此故事新建会话
        </button>
      </header>
      <AssetCreativeEntry api={api} id={id} kind="story" navigate={navigate} />
      {story?.id === id && (
        <StoryGuidance key={id} api={api} story={story} onSaved={setStory} />
      )}
      <nav className="tabs" aria-label="故事内容">
        {Object.entries(labels).map(([key, label]) => (
          <button
            key={key}
            aria-current={section === key ? "page" : undefined}
            onClick={() => navigate(`story/${id}/${key}`)}
          >
            {label}
          </button>
        ))}
      </nav>
      {error && (
        <div role="alert" className="error">
          {error}
          <button className="quiet" onClick={() => setGeneration((g) => g + 1)}>
            重试
          </button>
        </div>
      )}
      {loading && <p role="status">正在读取…</p>}
      {section === "snapshot" && (
        <div className="snapshot-note">
          <p>故事资产是独立副本，母版修改不会影响这里。</p>
          <button className="secondary" onClick={() => setAdding(!adding)}>
            添加资产快照
          </button>
        </div>
      )}
      {adding && (
        <SnapshotPicker
          api={api}
          storyId={id}
          onDone={() => {
            setAdding(false);
            setGeneration((g) => g + 1);
          }}
        />
      )}
      {!loading && !error && (
        <div className="reader-layout">
          <details className="reader-directory" key={`${id}:${section}`}>
            <summary>{labels[section]}目录</summary>
            <aside
              className="chapter-list"
              aria-label={labels[section] + "目录"}
            >
              {docs.map((d) => (
                <button
                  key={d.id}
                  aria-current={current?.id === d.id ? "page" : undefined}
                  onClick={() => navigate(`story/${id}/${section}/${d.id}`)}
                >
                  {d.order && <span>{String(d.order).padStart(2, "0")}</span>}
                  {d.content.name}
                </button>
              ))}
            </aside>
          </details>
          <div className="reading-pane">
            {current ? (
              <>
                <p className="eyebrow">
                  {labels[section]}
                  {current.order ? " · " + current.order : ""}
                  {section === "chapter" && ` · ${current.content.name}`}
                </p>
                {(section !== "chapter" || !hasOpeningHeading) && (
                  <h2>{current.content.name}</h2>
                )}
                {section === "snapshot" && (
                  <p className="muted">
                    {current.sourceAssetId
                      ? `从母版第 ${current.sourceVersion} 版复制`
                      : current.sourceCandidate
                        ? "来自角色候选 · 固定版本"
                        : "原创资料"}{" "}
                    · 当前故事第 {current.currentVersion} 版
                  </p>
                )}
                {current.portrait?.imageId && (
                  <PortraitImage
                    api={api}
                    imageId={current.portrait.imageId}
                    name={current.content.name}
                    large
                  />
                )}
                <ContentReading content={current.content} />
                {section === "chapter" && (
                  <div className="reader-navigation">
                    <button
                      className="secondary"
                      disabled={index <= 0}
                      onClick={() =>
                        navigate(`story/${id}/chapter/${docs[index - 1]!.id}`)
                      }
                    >
                      上一章
                    </button>
                    <span>
                      {index + 1} / {docs.length}
                    </span>
                    <button
                      className="secondary"
                      disabled={index >= docs.length - 1}
                      onClick={() =>
                        navigate(`story/${id}/chapter/${docs[index + 1]!.id}`)
                      }
                    >
                      下一章
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="empty">
                {documentId
                  ? "该文档不存在。"
                  : section === "chapter" && story?.initializationPending
                    ? "作品已建立，还没有章节。返回创作会话继续写第一章。"
                    : "这里还没有" + labels[section] + "。"}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
function SnapshotPicker({
  api,
  storyId,
  onDone,
}: {
  api: Api;
  storyId: string;
  onDone: () => void;
}) {
  const [kind, setKind] = useState("character"),
    [name, setName] = useState(""),
    [assets, setAssets] = useState<Document[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [request, setRequest] = useState<{ id: string; asset: string }>();
  useEffect(() => {
    let active = true;
    void api<Page>(`/library?${new URLSearchParams({ kind, name })}`)
      .then((p) => {
        if (active) setAssets(p.items);
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    return () => {
      active = false;
    };
  }, [api, kind, name]);
  async function add(asset: string) {
    setBusy(true);
    setError("");
    const req =
      request?.asset === asset ? request : { id: crypto.randomUUID(), asset };
    setRequest(req);
    try {
      await api(`/stories/${storyId}/snapshots`, {
        assetId: asset,
        requestId: req.id,
      });
      onDone();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="picker">
      <h2>从母版复制到故事</h2>
      <div className="filters">
        <label>
          资产类型
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="character">角色</option>
            <option value="world">世界观</option>
          </select>
        </label>
        <label>
          搜索名称
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <ul>
        {assets.map((a) => (
          <li key={a.id}>
            {a.content.name}
            <button
              disabled={busy}
              className="secondary"
              onClick={() => void add(a.id)}
            >
              复制到故事
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
