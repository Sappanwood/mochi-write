import type { Content } from "../shared/model.js";
import { Markdown } from "./Markdown.js";
export function ContentReading({ content }: { content: Content }) {
  return (
    <>
      {(content.genres.length > 0 || content.ageBand) && (
        <div className="tags">
          {content.genres.map((t) => (
            <span key={t}>{t}</span>
          ))}
          {content.ageBand && <span>{content.ageBand}</span>}
        </div>
      )}
      <dl className="metadata">
        {(
          [
            "gender",
            "age",
            "occupation",
            "era",
            "region",
            "traits",
            "tags",
          ] as const
        )
          .filter((k) => content.sourceMetadata[k] !== undefined)
          .map((k) => (
            <div key={k}>
              <dt>
                {
                  {
                    gender: "性别",
                    age: "年龄",
                    occupation: "职业",
                    era: "时代",
                    region: "地区",
                    traits: "特征",
                    tags: "标签",
                  }[k]
                }
              </dt>
              <dd>
                {Array.isArray(content.sourceMetadata[k])
                  ? content.sourceMetadata[k].join("、")
                  : String(content.sourceMetadata[k])}
              </dd>
            </div>
          ))}
      </dl>
      <Markdown text={content.markdown} />
    </>
  );
}
