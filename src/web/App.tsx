import { WritingHost } from "./WritingHost.js";
import { useEffect, useMemo, useState } from "react";
import type { AuthClient } from "./auth.js";
import { apiClient, message } from "./api.js";
import { AssetEditor, LibraryView, type Draft } from "./Library.js";
import { StoriesView, StoryReader, type StorySection } from "./Stories.js";
import { Transfer } from "./Transfer.js";
export function App({
  initialization,
}: {
  initialization: Promise<AuthClient>;
}) {
  const [auth, setAuth] = useState<AuthClient>(),
    [busy, setBusy] = useState(false),
    [authorized, setAuthorized] = useState(false),
    [error, setError] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [route, setRoute] = useState(
    () => location.hash.slice(1) || "library/character",
  );
  const api = useMemo(() => (auth ? apiClient(auth) : undefined), [auth]);
  useEffect(() => {
    let active = true;
    void initialization
      .then(async (client) => {
        if (active) setAuth(client);
        try {
          await apiClient(client)("/session");
          if (active) setAuthorized(true);
        } catch {
          /* No cached personal session. */
        }
      })
      .catch(() => {
        if (active) setError("登录服务暂不可用，请刷新页面重试");
      });
    return () => {
      active = false;
    };
  }, [initialization]);
  useEffect(() => {
    const update = () =>
      setRoute(location.hash.slice(1) || "library/character");
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  useEffect(() => {
    if (!Object.keys(drafts).length) return;
    const prevent = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [drafts]);
  async function login() {
    if (!auth) return;
    setBusy(true);
    setError("");
    try {
      await auth.login();
      await apiClient(auth)("/session");
      setAuthorized(true);
    } catch (e) {
      setError(
        message(e).includes("本人")
          ? message(e)
          : "登录未完成，请使用本人账号重试",
      );
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    if (!auth) return;
    if (
      Object.keys(drafts).length &&
      !confirm("退出登录会丢弃当前未保存草稿，是否继续？")
    )
      return;
    setDrafts({});
    setAuthorized(false);
    try {
      await auth.logout();
    } catch {
      setError("退出未完成，请重试");
    }
  }
  function navigate(path: string) {
    location.hash = path;
  }
  function setDraft(id: string, value?: Draft) {
    setDrafts((old) => {
      const next = { ...old };
      if (value) next[id] = value;
      else delete next[id];
      return next;
    });
  }
  if (!authorized || !api)
    return (
      <main className="entry">
        <div className="wordmark">
          <span className="seal">文</span> Mochi Write
        </div>
        <section className="welcome">
          <p className="eyebrow">你的创作空间</p>
          <h1>
            让人物与世界，
            <br />
            在文字里相遇。
          </h1>
          <p className="description">整理角色与世界观，回到故事的下一页。</p>
          <button disabled={!auth || busy} onClick={() => void login()}>
            {busy ? "正在登录…" : "使用 Microsoft 账号登录"}
          </button>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <p className="privacy">仅限本人访问</p>
        </section>
        <footer>MOCHI WRITE · 个人小说创作工作台</footer>
      </main>
    );
  const [area, id, section, documentId] = route.split("/");
  let view;
  if (area === "library" && (id === "character" || id === "world"))
    view = <LibraryView key={route} api={api} kind={id} navigate={navigate} />;
  else if (area === "asset" && id)
    view = (
      <AssetEditor
        key={route}
        api={api}
        id={id}
        kind="character"
        draft={drafts[id]}
        setDraft={setDraft}
        navigate={navigate}
      />
    );
  else if (area === "new" && (id === "character" || id === "world"))
    view = (
      <AssetEditor
        key={route}
        api={api}
        kind={id}
        setDraft={setDraft}
        navigate={navigate}
      />
    );
  else if (area === "stories")
    view = <StoriesView api={api} navigate={navigate} />;
  else if (
    area === "story" &&
    id &&
    section &&
    ["chapter", "outline", "setting", "snapshot"].includes(section)
  )
    view = (
      <StoryReader
        api={api}
        id={id}
        section={section as StorySection}
        documentId={documentId}
        navigate={navigate}
      />
    );
  else if (area === "transfer") view = <Transfer api={api} />;
  else view = <div className="empty">页面不存在。请从侧栏选择资产或故事。</div>;
  return (
    <div className="workspace">
      <aside className="sidebar">
        <a className="wordmark" href="#library/character">
          <span className="seal">文</span>
          <span>Mochi Write</span>
        </a>
        <p className="sidebar-label">创作资料</p>
        <nav aria-label="主导航">
          <a
            href="#stories"
            aria-current={
              area === "stories" || area === "story" ? "page" : undefined
            }
          >
            <span aria-hidden="true">▤</span>故事书架
          </a>
          <a
            href="#library/character"
            aria-current={
              area === "library" && id === "character" ? "page" : undefined
            }
          >
            <span aria-hidden="true">♙</span>角色库
          </a>
          <a
            href="#library/world"
            aria-current={
              area === "library" && id === "world" ? "page" : undefined
            }
          >
            <span aria-hidden="true">◎</span>世界观
          </a>
        </nav>
        <p className="sidebar-label">资料管理</p>
        <nav>
          <a
            href="#transfer"
            aria-current={area === "transfer" ? "page" : undefined}
          >
            <span aria-hidden="true">⇄</span>导入与导出
          </a>
        </nav>
        {Object.keys(drafts).length > 0 && (
          <div className="drafts">
            <p>未保存草稿</p>
            {Object.entries(drafts).map(([id, d]) => (
              <a key={id} href={`#asset/${id}`}>
                {d.content.name}
              </a>
            ))}
          </div>
        )}
        <div className="sidebar-bottom">
          <p>个人创作空间</p>
          <button className="quiet" onClick={() => void logout()}>
            退出登录
          </button>
        </div>
      </aside>
      <main className="main-content">{view}</main>
      <WritingHost api={api} route={route} />
    </div>
  );
}
