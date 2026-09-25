import { useState } from "react";
import type { Document } from "../shared/model.js";
import { GUIDANCE_MAX_LENGTH } from "../shared/guidance.js";
import { type Api, message } from "./api.js";
import { Markdown } from "./Markdown.js";

export function StoryGuidance({
  api,
  story,
  onSaved,
}: {
  api: Api;
  story: Document;
  onSaved: (story: Document) => void;
}) {
  const [baseline, setBaseline] = useState(story);
  const [text, setText] = useState(story.guidance ?? "");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [latest, setLatest] = useState<Document>();
  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await api<Document>(
        `/stories/${story.id}/guidance`,
        { revision: baseline.revision, text },
        "PUT",
      );
      setBaseline(saved);
      setText(saved.guidance ?? "");
      setLatest(undefined);
      onSaved(saved);
      setNotice("指引已保存");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const current = await api<Document>(`/stories/${story.id}`);
      setBaseline(current);
      setLatest(current);
      onSaved(current);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="story-guidance">
      <summary>写作指引</summary>
      <p className="muted">
        为这部故事保存文风、节奏和叙事方向。后续写作会读取，正在生成的内容不受修改影响。清空后保存可移除指引。
      </p>
      <label>
        故事写作指引
        <textarea
          rows={6}
          maxLength={GUIDANCE_MAX_LENGTH}
          value={text}
          disabled={busy}
          placeholder="例如：慢热，侧重对白；避免全知旁白；暂不揭晓主角的真实身份。"
          onChange={(e) => {
            setText(e.target.value);
            setNotice("");
          }}
        />
      </label>
      <p className="muted">
        {text.length} / {GUIDANCE_MAX_LENGTH} · 输入后请保存
      </p>
      <button
        className="secondary"
        disabled={busy || text === (baseline.guidance ?? "")}
        onClick={() => void save()}
      >
        {busy ? "处理中…" : "保存指引"}
      </button>
      {notice && <p role="status">{notice}</p>}
      {error && (
        <div role="alert" className="error">
          {error}
          <button
            className="quiet"
            disabled={busy}
            onClick={() => void refresh()}
          >
            读取最新指引，保留输入
          </button>
        </div>
      )}
      {latest && (
        <div className="notice">
          <p>服务器当前指引（保存将以此版本为基础）：</p>
          {latest.guidance ? (
            <Markdown text={latest.guidance} />
          ) : (
            <p>未设置指引</p>
          )}
        </div>
      )}
    </details>
  );
}
