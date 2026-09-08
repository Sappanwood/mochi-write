import type {
  CreativeDraft,
  InitializationPackage,
} from "../shared/creative.js";
import { Markdown } from "./Markdown.js";
const labels = {
  setting: "设定与关系",
  outline: "大纲",
  snapshot: "角色／世界观快照",
};
export function draftKind(draft: CreativeDraft) {
  return draft.artifactKind === "story_initialization"
    ? draft.initialization?.chapter
      ? "作品与首章草稿"
      : "作品初始化草稿（不含章节）"
    : "章节草稿";
}
export function InitializationScope({
  value,
}: {
  value: InitializationPackage;
}) {
  return (
    <section className="initialization-scope" aria-label="本版本保存范围">
      <h3>本版本保存范围</h3>
      <p>
        {value.story.baseRevision ? "更新作品信息" : "建立作品"} ·{" "}
        {value.assets.length} 项关联资料
        {value.chapter ? " · 保存首章" : " · 不保存章节"}
      </p>
      <ul>
        {value.assets.map((a) => (
          <li key={a.entity.id}>
            <strong>
              {a.baseRevision ? "更新" : "新增"} · {a.entity.content.name}
            </strong>
            <span> · {labels[a.entity.kind as keyof typeof labels]}</span>
            {a.source && (
              <span>
                {" "}
                · 来源：{a.source.title}，母版第 {a.source.version} 版
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="muted">保存此版本时，一并确认以上资料范围。</p>
    </section>
  );
}
export function InitializationReading({ draft }: { draft: CreativeDraft }) {
  const value = draft.initialization!;
  return (
    <div className="initialization-reading">
      <InitializationScope value={value} />
      <section className="reading-pane" aria-label="作品信息">
        <p className="eyebrow">作品信息</p>
        <h2>{value.story.entity.content.name}</h2>
        <Markdown text={value.story.entity.content.markdown} />
      </section>
      {value.chapter && (
        <article className="reading-pane" aria-label="首章草稿">
          <p className="eyebrow">首章草稿</p>
          <h2>{value.chapter.entity.content.name}</h2>
          <Markdown text={value.chapter.entity.content.markdown} />
        </article>
      )}
      <section aria-label="关联资料全文">
        <h2>关联资料</h2>
        {!value.assets.length && <p className="muted">本版本没有附带资料。</p>}
        {value.assets.map((a) => (
          <details className="initialization-asset" key={a.entity.id}>
            <summary>
              {a.baseRevision ? "更新" : "新增"} · {a.entity.content.name} ·{" "}
              {labels[a.entity.kind as keyof typeof labels]}
            </summary>
            {a.source ? (
              <p className="muted">
                来源：{a.source.title} · 母版第 {a.source.version} 版 ·
                完整独立快照
              </p>
            ) : a.entity.sourceAssetId ? (
              <p className="muted">
                保留母版第 {a.entity.sourceVersion}{" "}
                版的溯源；本次更新仅属于当前作品。
              </p>
            ) : (
              <p className="muted">为当前作品创作的资料。</p>
            )}
            <div className="reading-pane">
              <Markdown text={a.entity.content.markdown} />
            </div>
          </details>
        ))}
      </section>
    </div>
  );
}
