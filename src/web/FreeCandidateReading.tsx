import { ContentReading } from "./ContentReading.js";
import { InitializationReading } from "./InitializationReading.js";
import type {
  CreativeDraft,
  InitializationPackage,
} from "../shared/creative.js";
import type { MaterialPackage } from "../shared/story-materials.js";
import {
  kindLabel,
  summaryRef,
  type Information,
  type Reference,
} from "./free-client.js";
export function FreeCandidateReading({
  info,
  attach,
  open,
  expanded = false,
}: {
  info: Information;
  attach?: (ref: Reference) => void;
  open?: (ref: Reference) => void;
  expanded?: boolean;
}) {
  const currentDraft = info.draft;
  const materials =
    currentDraft?.artifactKind === "story_materials"
      ? (currentDraft.payload.business?.materials as
          MaterialPackage | undefined)
      : undefined;
  return (
    <>
      {info.availability === "exact" &&
        (currentDraft?.artifactKind === "story_initialization" ? (
          <InitializationReading
            expandAssets={expanded}
            showScope={!expanded}
            draft={
              {
                initialization: currentDraft.payload.business
                  ?.initialization as InitializationPackage,
              } as CreativeDraft
            }
          />
        ) : info.content ? (
          <ContentReading content={info.content} />
        ) : null)}
      {(currentDraft?.artifactKind !== "story_initialization" || !expanded) &&
        currentDraft?.payload.members?.map((m) => (
          <details key={m.member_id} open={expanded || undefined}>
            <summary>
              {kindLabel[m.kind] ?? m.kind} · {m.content.name}
            </summary>
            {materials && (
              <p>
                {m.mode === "create"
                  ? "新增 · 无基础版本"
                  : `更新 · 基于 v${m.baseVersion}`}{" "}
                ·{" "}
                {info?.receipt?.assets?.find((a) => a.asset_id === m.member_id)
                  ? `已保存为 v${info.receipt.assets.find((a) => a.asset_id === m.member_id)!.revision}`
                  : "尚未保存"}
              </p>
            )}
            {materials &&
              (m.sourceRef ? (
                <button
                  className="quiet"
                  disabled={!open}
                  onClick={() =>
                    open?.({
                      ref: m.sourceRef!,
                      title: `入包来源：${m.content.name}`,
                      recorded: true,
                    })
                  }
                >
                  入包来源：{m.content.name} ·{" "}
                  {m.sourceRef.type === "asset"
                    ? `母版 v${m.sourceRef.version}`
                    : "角色候选固定版本"}
                </button>
              ) : (
                <p className="muted">
                  {m.mode === "update"
                    ? "基于故事既有资料修订"
                    : "原创故事资料"}
                </p>
              ))}
            <ContentReading content={m.content} />
            {materials && (
              <details>
                <summary>完整属性</summary>
                <pre className="free-identity">
                  {JSON.stringify(m.content.sourceMetadata, null, 2)}
                </pre>
              </details>
            )}
            {attach && (
              <button
                className="quiet"
                onClick={() =>
                  attach({
                    ref: {
                      ...summaryRef({
                        group_id: currentDraft.groupId,
                        draft_id: currentDraft.id,
                        draft_revision: "1",
                        draft_hash: currentDraft.draftHash,
                        title: currentDraft.title,
                        ordinal: currentDraft.ordinal,
                        artifact_kind: currentDraft.artifactKind,
                      }),
                      member_id: m.member_id,
                    },
                    title: m.content.name,
                    recorded: true,
                  })
                }
              >
                引用成员：{m.content.name}
              </button>
            )}
          </details>
        ))}
      {currentDraft?.payload.business?.derivation != null && (
        <details>
          <summary>独立母版的保留、改写与排除</summary>
          <pre className="free-identity">
            {JSON.stringify(currentDraft.payload.business.derivation, null, 2)}
          </pre>
        </details>
      )}
    </>
  );
}
