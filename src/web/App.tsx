import { FreeNewEntry, FreeConversations } from "./FreeEntry.js";
import { FreeWorkspace } from "./FreeWorkspace.js";
import { WritingHost } from "./WritingHost.js";
import {
  NewCreativeStory,
  CreativeConversations,
  LifecycleWorkspace,
} from "./CreativeEntry.js";
import { CreativeWorkspace } from "./CreativeWorkspace.js";
import { CreativeDraftReader } from "./CreativeResults.js";
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
  const [navigationCollapsed, setNavigationCollapsed] = useState(
    () => sessionStorage.getItem("mochi-write:navigation-collapsed") === "true",
  );
  function toggleNavigation() {
    setNavigationCollapsed((collapsed) => {
      sessionStorage.setItem(
        "mochi-write:navigation-collapsed",
        String(!collapsed),
      );
      return !collapsed;
    });
  }
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [route, setRoute] = useState(
    () => location.hash.slice(1) || "free/new",
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
    const update = () => setRoute(location.hash.slice(1) || "free/new");
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
  const [area, id, section, documentId, selectedDraftId] = route.split("/");
  let view;
  if (area === "free" && id === "conversations")
    view = <FreeConversations api={api} />;
  else if (area === "free" && id === "new")
    view = (
      <FreeNewEntry
        key={route}
        api={api}
        source={section}
        sourceId={documentId}
        navigate={navigate}
      />
    );
  else if (area === "free" && id === "conversation" && section)
    view = (
      <FreeWorkspace
        key={section}
        api={api}
        conversationId={section}
        navigate={navigate}
      />
    );
  else if (area === "library" && (id === "character" || id === "world"))
    view = <LibraryView key={route} api={api} kind={id} navigate={navigate} />;
  else if (area === "asset" && id)
    view = (
      <AssetEditor
        key={route}
        api={api}
        id={id}
        kind="character"
        draft={drafts[id]}
        formalRead={section === "read"}
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
  else if (area === "creative" && id === "new")
    view = <NewCreativeStory api={api} navigate={navigate} />;
  else if (area === "creative" && id === "conversations")
    view = <CreativeConversations api={api} navigate={navigate} />;
  else if (area === "creative" && id === "conversation" && section)
    view = (
      <LifecycleWorkspace
        key={section}
        api={api}
        conversationId={section}
        selectedDraftId={documentId}
        navigate={navigate}
      />
    );
  else if (area === "creative" && id === "draft" && section && documentId)
    view = (
      <CreativeDraftReader
        key={`${section}:${documentId}`}
        api={api}
        storyId={section}
        draftId={documentId}
        navigate={navigate}
        lifecycle
      />
    );
  else if (area === "story" && id && section === "creative")
    view = (
      <CreativeWorkspace
        key={`${id}:${documentId ?? ""}`}
        api={api}
        storyId={id}
        conversationId={documentId}
        selectedDraftId={selectedDraftId}
        navigate={navigate}
      />
    );
  else if (area === "story" && id && section === "draft" && documentId)
    view = (
      <CreativeDraftReader
        key={`${id}:${documentId}`}
        api={api}
        storyId={id}
        draftId={documentId}
        navigate={navigate}
      />
    );
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
    <div
      className={`workspace${navigationCollapsed ? " navigation-collapsed" : ""}${(area === "free" && id !== "conversations") || (area === "creative" && id === "conversation") || (area === "story" && section === "creative") ? " workspace-creative" : ""}`}
    >
      <aside className="sidebar">
        <div className="sidebar-heading">
          <a className="wordmark" href="#free/new">
            <span className="seal">文</span>
            <span>Mochi Write</span>
          </a>
          <button
            className="quiet navigation-toggle"
            aria-label={navigationCollapsed ? "展开主导航" : "收起主导航"}
            aria-expanded={!navigationCollapsed}
            aria-controls="sidebar-navigation"
            title={navigationCollapsed ? "展开主导航" : "收起主导航"}
            onClick={toggleNavigation}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 20 20"
              fill="none"
              aria-hidden="true"
            >
              <rect
                x="2"
                y="3"
                width="16"
                height="14"
                rx="2"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path d="M7 3v14" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>
        <div
          id="sidebar-navigation"
          className="sidebar-navigation"
          hidden={navigationCollapsed}
        >
          <nav aria-label="主导航">
            {[
              ["free/new", "新建创作", area === "free" && id === "new"],
              [
                "free/conversations",
                "最近会话",
                area === "free" && id !== "new",
              ],
              ["stories", "故事书架", area === "stories" || area === "story"],
              [
                "library/character",
                "角色库",
                area === "library" && id === "character",
              ],
              ["library/world", "世界观", area === "library" && id === "world"],
            ].map(([path, label, current]) => (
              <a
                key={String(path)}
                href={`#${path}`}
                className={path === "free/new" ? "new-creation" : undefined}
                aria-current={current ? "page" : undefined}
              >
                {label}
              </a>
            ))}
          </nav>
          <details className="sidebar-more" key={route}>
            <summary>更多</summary>
            <div className="sidebar-more-content">
              <a
                href="#transfer"
                aria-current={area === "transfer" ? "page" : undefined}
              >
                导入与导出
              </a>
              <a href="#creative/conversations">旧创作会话与草稿</a>
              <button
                className="quiet"
                onClick={() => navigate("creative/new")}
              >
                旧版新建故事
              </button>
              {area === "story" && id && (
                <button
                  className="quiet"
                  onClick={() => navigate(`story/${id}/creative`)}
                >
                  旧故事创作会话
                </button>
              )}
              <button className="quiet" onClick={() => void logout()}>
                退出登录
              </button>
            </div>
          </details>
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
          </div>
        </div>
      </aside>
      <main className={`main-content${area === "free" ? " free-main" : ""}`}>
        {area !== "free" && sessionStorage.getItem("mochi-free:return") && (
          <a
            className="back-link"
            href={`#free/conversation/${sessionStorage.getItem("mochi-free:return")}`}
          >
            返回原自由会话
          </a>
        )}
        {view}
      </main>
      {!(
        area === "free" ||
        area === "creative" ||
        (area === "story" && (section === "creative" || section === "draft"))
      ) && <WritingHost api={api} route={route} />}
    </div>
  );
}
