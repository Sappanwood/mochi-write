import { ContentReading } from "./ContentReading.js";
import { AssetCreativeEntry } from "./FreeEntry.js";
import { useEffect, useState } from "react";
import type { Content, Document, Page } from "../shared/model.js";
import type { Api } from "./api.js";
import { message } from "./api.js";
import { Markdown } from "./Markdown.js";
export interface Draft {
  base: Document;
  content: Content;
}
export function LibraryView({
  api,
  kind,
  navigate,
}: {
  api: Api;
  kind: "character" | "world";
  navigate: (path: string) => void;
}) {
  const [name, setName] = useState(""),
    [genre, setGenre] = useState(""),
    [age, setAge] = useState("");
  const [terms, setTerms] = useState<{ genres: string[]; ageBands: string[] }>({
    genres: [],
    ageBands: [],
  });
  const [page, setPage] = useState<Page>({ items: [] }),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    void api<typeof terms>("/vocabulary")
      .then(setTerms)
      .catch((e) => setError(message(e)));
  }, [api]);
  const query = new URLSearchParams({ kind, name, genre, ageBand: age });
  async function load(cursor?: string) {
    setLoading(true);
    setError("");
    try {
      const next = await api<Page>(
        `/library?${query}${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`,
      );
      setPage((old) =>
        cursor ? { ...next, items: [...old.items, ...next.items] } : next,
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void api<Page>(
      `/library?${new URLSearchParams({ kind, name, genre, ageBand: age })}`,
    )
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
  }, [api, kind, name, genre, age]);
  return (
    <>
      <header className="page-heading">
        <div>
          <p className="eyebrow">资产库</p>
          <h1>{kind === "character" ? "角色" : "世界观"}</h1>
          <p>保存可复用的设定，让每个故事拥有自己的起点。</p>
        </div>
        <button onClick={() => navigate(`free/new/${kind}`)}>
          新建{kind === "character" ? "角色" : "世界观"}
        </button>
      </header>
      <div className="filters">
        <label>
          名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="按名称检索"
          />
        </label>
        <label>
          题材
          <select value={genre} onChange={(e) => setGenre(e.target.value)}>
            <option value="">全部题材</option>
            {terms.genres.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        {kind === "character" && (
          <label>
            年龄层
            <select value={age} onChange={(e) => setAge(e.target.value)}>
              <option value="">全部年龄层</option>
              {terms.ageBands.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      {error && (
        <div role="alert" className="error">
          {error}
          <button className="quiet" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}
      {loading && <p role="status">正在读取…</p>}
      {!loading && !error && !page.items.length && (
        <div className="empty">
          没有匹配的{kind === "character" ? "角色" : "世界观"}
          。可以新建，或从导入页面添加资料。
        </div>
      )}
      <div className="asset-grid">
        {page.items.map((d) => (
          <button
            className="asset-card"
            key={d.id}
            onClick={() => navigate(`asset/${d.id}`)}
          >
            <span className="card-icon">
              {kind === "character" ? "人" : "境"}
            </span>
            <h2>{d.content.name}</h2>
            <p>
              {[
                kind === "world"
                  ? d.content.sourceMetadata.era
                  : d.content.sourceMetadata.occupation,
                d.content.ageBand,
              ]
                .filter(Boolean)
                .join(" · ") || "世界与设定"}
            </p>
            <div className="tags">
              {d.content.genres.map((t) => (
                <span key={t}>{t}</span>
              ))}
            </div>
            <span className="card-link">阅读与编辑 →</span>
          </button>
        ))}
      </div>
      {page.cursor && (
        <button
          className="secondary"
          disabled={loading}
          onClick={() => void load(page.cursor)}
        >
          加载更多
        </button>
      )}
    </>
  );
}
export function AssetEditor({
  api,
  id,
  kind,
  draft,
  formalRead = false,
  setDraft,
  navigate,
}: {
  api: Api;
  id?: string;
  kind: "character" | "world";
  draft?: Draft;
  formalRead?: boolean;
  setDraft: (id: string, value?: Draft) => void;
  navigate: (path: string) => void;
}) {
  const initialDraft = formalRead ? undefined : draft;
  const [base, setBase] = useState<Document | undefined>(initialDraft?.base);
  const [remote, setRemote] = useState<Document>();
  const [content, setContent] = useState<Content>(
    initialDraft?.content ?? {
      name: "",
      markdown: "",
      genres: [],
      ageBand: "",
      sourceMetadata: {},
    },
  );
  const [terms, setTerms] = useState<{ genres: string[]; ageBands: string[] }>({
    genres: [],
    ageBands: [],
  });
  const [editing, setEditing] = useState(!id || !!initialDraft),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  useEffect(() => {
    void api<typeof terms>("/vocabulary")
      .then(setTerms)
      .catch((e) => setError(message(e)));
    if (id && (formalRead || !draft)) {
      let active = true;
      void api<Document>(`/library/${id}`)
        .then((doc) => {
          if (active) {
            setBase(doc);
            setContent(doc.content);
          }
        })
        .catch((e) => {
          if (active) setError(message(e));
        });
      return () => {
        active = false;
      };
    }
  }, [api, id, formalRead]);
  function change(next: Content) {
    setContent(next);
    setNotice("");
    if (id && base) setDraft(id, { base, content: next });
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      const doc = await api<Document>(
        id ? `/library/${id}` : "/library",
        id ? { revision: base?.revision, content } : { kind, content },
        id ? "PUT" : "POST",
      );
      setBase(doc);
      setContent(doc.content);
      if (id) setDraft(id);
      setEditing(false);
      setNotice("已保存");
      setRemote(undefined);
      if (!id) navigate(`asset/${doc.id}`);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    if (!id) return;
    setBusy(true);
    try {
      const doc = await api<Document>(`/library/${id}`);
      setBase(doc);
      setDraft(id, { base: doc, content });
      setRemote(doc);
      setNotice("已读取最新版本，草稿已保留；请核对后再保存");
      setError("");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!base || !confirm("删除此母版？已有故事快照会保留。")) return;
    setBusy(true);
    try {
      await api(`/library/${base.id}`, { revision: base.revision }, "DELETE");
      setDraft(base.id);
      navigate(`library/${base.kind}`);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  if (id && !base)
    return (
      <>
        <p role="status">正在读取资产…</p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </>
    );
  return (
    <>
      <button
        className="back-link"
        onClick={() => navigate(`library/${base?.kind ?? kind}`)}
      >
        ← 返回资产库
      </button>
      <header className="page-heading">
        <div>
          <p className="eyebrow">
            {base?.kind === "world" || kind === "world"
              ? "世界观母版"
              : "角色母版"}
          </p>
          <h1>
            {id
              ? base?.content.name
              : "新建" + (kind === "character" ? "角色" : "世界观")}
          </h1>
          <p>母版的变化不会影响已有故事。</p>
        </div>
        {!editing &&
          (formalRead && draft ? (
            <button onClick={() => navigate(`asset/${id}`)}>
              继续未保存编辑
            </button>
          ) : (
            <button onClick={() => setEditing(true)}>编辑资产</button>
          ))}
      </header>
      {formalRead && draft && !editing && (
        <p className="notice">
          正在阅读正式内容；未保存人工编辑及其原始版本仍保留，可单独继续编辑。
        </p>
      )}
      {id && (
        <AssetCreativeEntry
          api={api}
          id={id}
          kind="asset"
          navigate={navigate}
        />
      )}
      {editing && (
        <p className="notice">
          临时人工编辑 · 尚未保存，不是会话候选；不会自动发送给 Agent。
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {error && (
        <div role="alert" className="error">
          {error}
          {id && (
            <button
              className="quiet"
              onClick={() => void reload()}
              disabled={busy}
            >
              读取最新版本，保留草稿
            </button>
          )}
        </div>
      )}
      {remote && (
        <details className="remote-version" open>
          <summary>服务器最新版本 · {remote.content.name}</summary>
          <Markdown text={remote.content.markdown} />
        </details>
      )}
      {editing ? (
        <form
          className="editor"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            名称
            <input
              required
              maxLength={200}
              value={content.name}
              onChange={(e) => change({ ...content, name: e.target.value })}
            />
          </label>
          {(base?.kind ?? kind) === "character" && (
            <div className="field-row">
              {(["gender", "age", "occupation"] as const).map((key, i) => (
                <label key={key}>
                  {["性别", "年龄", "职业"][i]}
                  <input
                    value={String(content.sourceMetadata[key] ?? "")}
                    onChange={(e) =>
                      change({
                        ...content,
                        sourceMetadata: {
                          ...content.sourceMetadata,
                          [key]: e.target.value,
                        },
                      })
                    }
                  />
                </label>
              ))}
            </div>
          )}
          <div className="field-row">
            <fieldset>
              <legend>适用题材</legend>
              <div className="tag-options">
                {terms.genres.map((t) => (
                  <label key={t}>
                    <input
                      type="checkbox"
                      checked={content.genres.includes(t)}
                      onChange={(e) =>
                        change({
                          ...content,
                          genres: e.target.checked
                            ? [...content.genres, t]
                            : content.genres.filter((g) => g !== t),
                        })
                      }
                    />
                    {t}
                  </label>
                ))}
              </div>
            </fieldset>
            <label>
              年龄层
              <select
                value={content.ageBand}
                onChange={(e) =>
                  change({ ...content, ageBand: e.target.value })
                }
              >
                <option value="">未指定</option>
                {terms.ageBands.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
          </div>
          <label>
            资料正文
            <textarea
              className="markdown-input"
              value={content.markdown}
              onChange={(e) => change({ ...content, markdown: e.target.value })}
            />
          </label>
          <p className="muted">支持 Markdown。其他原始字段会随资料保留。</p>
          <div className="actions">
            <button disabled={busy || !content.name.trim()} type="submit">
              {busy ? "正在保存…" : "保存修改"}
            </button>
            {id && (
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  if (confirm("放弃当前未保存修改？")) {
                    setContent(base!.content);
                    setDraft(id);
                    setEditing(false);
                    setError("");
                  }
                }}
              >
                放弃修改
              </button>
            )}
          </div>
        </form>
      ) : (
        <>
          <ContentReading content={content} />
          <button
            className="danger quiet"
            disabled={busy}
            onClick={() => void remove()}
          >
            删除母版
          </button>
        </>
      )}
    </>
  );
}
