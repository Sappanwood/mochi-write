import { useLayoutEffect, useRef } from "react";
import type { CreativeDraft } from "../shared/creative.js";
import {
  InitializationReading,
  InitializationScope,
  draftKind,
} from "./InitializationReading.js";
import { Markdown } from "./Markdown.js";
import { savedPath } from "./CreativeResults.js";

export function CreativeDraftPane({
  drafts,
  draft,
  onChoose,
  onSave,
  disabled,
  navigate,
}: {
  drafts: CreativeDraft[];
  draft?: CreativeDraft;
  onChoose: (draft: CreativeDraft) => void;
  onSave: (draft: CreativeDraft) => void;
  disabled: boolean;
  navigate: (path: string) => void;
}) {
  const reading = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const element = reading.current;
    if (element)
      element.scrollTop = positions.current.get(draft?.id ?? "") ?? 0;
  }, [draft?.id]);
  const latest = drafts.at(-1);
  return (
    <section
      className="creative-draft-pane"
      id="creative-draft-panel"
      aria-label="草稿面板"
    >
      <header className="creative-draft-toolbar">
        <div className="creative-draft-title">
          <div>
            <p className="eyebrow">{draft ? draftKind(draft) : "草稿"}</p>
            <h2>{draft?.title ?? "故事正在酝酿"}</h2>
          </div>
          {draft &&
            (draft.receipt ? (
              <button
                className="secondary"
                onClick={() => navigate(savedPath(draft.receipt!))}
              >
                {"kind" in draft.receipt &&
                draft.receipt.kind === "story_initialized"
                  ? "打开作品"
                  : "打开章节"}
              </button>
            ) : (
              <button disabled={disabled} onClick={() => onSave(draft)}>
                保存此版本
              </button>
            ))}
        </div>
        {draft && (
          <div className="creative-version-row">
            <label>
              草稿版本
              <select
                aria-label="草稿版本"
                value={draft.id}
                onChange={(e) =>
                  onChoose(drafts.find((d) => d.id === e.target.value)!)
                }
              >
                {drafts.map((d, index) => (
                  <option key={d.id} value={d.id}>
                    第 {index + 1} 稿 · {d.title}
                    {d.receipt ? " · 已保存" : ""}
                  </option>
                ))}
              </select>
            </label>
            <span className="muted">
              {draft.receipt ? "此版本已保存" : "尚未正式保存"}
            </span>
          </div>
        )}
        {latest && latest.id !== draft?.id && (
          <button
            className="quiet creative-new-draft"
            onClick={() => onChoose(latest)}
          >
            查看新版本
          </button>
        )}
        {draft?.initialization && (
          <details className="creative-save-scope">
            <summary>查看本版本保存范围</summary>
            <InitializationScope value={draft.initialization} />
          </details>
        )}
      </header>
      <div
        className="creative-draft-scroll"
        ref={reading}
        role="region"
        aria-label="草稿正文"
        tabIndex={0}
        onScroll={(e) => {
          if (draft) positions.current.set(draft.id, e.currentTarget.scrollTop);
        }}
      >
        {draft ? (
          draft.initialization ? (
            <InitializationReading draft={draft} showScope={false} />
          ) : (
            <article className="creative-draft-body">
              <Markdown text={draft.body} />
            </article>
          )
        ) : (
          <div className="creative-draft-empty">
            <span aria-hidden="true">✎</span>
            <h3>从对话里，写出下一页</h3>
            <p>聊聊你的想法。生成的草稿会出现在这里，可以边读边继续讨论。</p>
          </div>
        )}
      </div>
    </section>
  );
}
