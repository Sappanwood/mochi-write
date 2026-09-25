import { useState, type ReactNode } from "react";
import type { Document } from "../shared/model.js";
import { portraitSchema, type Portrait } from "../shared/portrait.js";
import { ApiError, message, type Api } from "./api.js";
import { PortraitImage } from "./PortraitImage.js";
import { PortraitCrop } from "./PortraitCrop.js";

interface Draft {
  revision: string;
  portrait: Portrait;
}
export function PortraitPanel({
  api,
  doc,
  onSaved,
  navigate,
  children,
}: {
  children: ReactNode;
  api: Api;
  doc: Document;
  onSaved: (doc: Document) => void;
  navigate: (path: string) => void;
}) {
  const key = `mochi-portrait:${doc.id}`;
  const [draft, setDraft] = useState<Draft | undefined>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
      if (value && typeof value.revision === "string")
        return {
          revision: value.revision,
          portrait: portraitSchema.parse(value.portrait),
        };
    } catch {
      /* Invalid local drafts are ignored. */
    }
    return undefined;
  });
  const [expanded, setExpanded] = useState(draft !== undefined);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false),
    [remote, setRemote] = useState<Document>();
  const value = draft?.portrait ?? doc.portrait ?? { prompt: "" };
  function change(portrait: Portrait) {
    const next = { revision: draft?.revision ?? doc.revision, portrait };
    setDraft(next);
    setNotice("");
    try {
      sessionStorage.setItem(key, JSON.stringify(next));
    } catch {
      setError("浏览器暂存失败，请在离开前保存头像与提示词");
    }
  }
  async function save() {
    if (!draft) return;
    setBusy(true);
    setError("");
    try {
      const saved = await api<Document>(
        `/library/${doc.id}/portrait`,
        draft,
        "PUT",
      );
      sessionStorage.removeItem(key);
      setDraft(undefined);
      setRemote(undefined);
      setConflict(false);
      onSaved(saved);
      setNotice("头像与提示词已保存");
    } catch (e) {
      setError(message(e));
      setConflict(e instanceof ApiError && e.status === 409);
    } finally {
      setBusy(false);
    }
  }
  async function reload() {
    setBusy(true);
    setError("");
    try {
      const latest = await api<Document>(`/library/${doc.id}`);
      setRemote(latest);
      const next = { revision: latest.revision, portrait: value };
      setDraft(next);
      sessionStorage.setItem(key, JSON.stringify(next));
      setConflict(false);
      setNotice("已读取最新版本，头像草稿保留；请对照后保存");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(value.prompt);
      setNotice("提示词已复制");
    } catch {
      setError("复制失败，请在提示词文本框内手动选择并复制");
    }
  }
  return (
    <section className="character-profile" aria-label="角色档案">
      <div className="character-portrait">
        <PortraitImage
          api={api}
          imageId={value.imageId}
          name={doc.content.name}
          large
        />
        <button
          className="quiet"
          aria-expanded={expanded}
          aria-controls="portrait-manager"
          onClick={() => setExpanded(!expanded)}
        >
          {value.imageId ? "更换头像" : "添加头像"}
        </button>
        {draft && <span className="portrait-unsaved">尚未保存</span>}
      </div>
      {children}
      <div className="portrait-controls">
        <details
          id="portrait-manager"
          open={expanded}
          onToggle={(e) => setExpanded(e.currentTarget.open)}
        >
          <summary>头像与提示词{draft ? " · 尚未保存" : ""}</summary>
          <div className="portrait-manager-body">
            <button
              className="secondary"
              onClick={() => navigate(`free/new/portrait/${doc.id}`)}
            >
              整理 2.5D 提示词
            </button>
            <p className="muted">
              带已保存角色资料进入文字会话，发送后整理提示词。生成图片后可上传到这里。
            </p>
            <fieldset disabled={busy}>
              <PortraitCrop
                onCrop={async (data) => {
                  setBusy(true);
                  try {
                    const uploaded = await api<{ imageId: string }>(
                      "/portraits",
                      { data },
                    );
                    change({ ...value, imageId: uploaded.imageId });
                  } finally {
                    setBusy(false);
                  }
                }}
              />
              {value.imageId && (
                <button
                  type="button"
                  className="quiet"
                  onClick={() => change({ prompt: value.prompt })}
                >
                  移除头像
                </button>
              )}
              <label>
                采用的生图提示词
                <textarea
                  maxLength={8000}
                  value={value.prompt}
                  onChange={(e) => change({ ...value, prompt: e.target.value })}
                  placeholder="将选定提示词粘贴在这里，保留画风、固定视觉锚点与本次构图。"
                />
              </label>
              <div className="actions">
                <button disabled={!draft} onClick={() => void save()}>
                  保存头像与提示词
                </button>
                <button
                  className="secondary"
                  disabled={!value.prompt}
                  onClick={() => void copy()}
                >
                  复制提示词
                </button>
                {draft && (
                  <button
                    className="quiet"
                    onClick={() => {
                      if (confirm("放弃未保存的头像与提示词？")) {
                        setDraft(undefined);
                        sessionStorage.removeItem(key);
                        setError("");
                        setRemote(undefined);
                        setConflict(false);
                      }
                    }}
                  >
                    放弃头像修改
                  </button>
                )}
              </div>
            </fieldset>
          </div>
        </details>
        {conflict && (
          <button
            disabled={busy}
            className="secondary"
            onClick={() => void reload()}
          >
            读取最新头像，保留草稿
          </button>
        )}
        {remote && (
          <details open>
            <summary>服务器最新头像与提示词</summary>
            <PortraitImage
              api={api}
              imageId={remote.portrait?.imageId}
              name={remote.content.name}
            />
            <pre>{remote.portrait?.prompt || "未保存提示词"}</pre>
          </details>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
      </div>
    </section>
  );
}
