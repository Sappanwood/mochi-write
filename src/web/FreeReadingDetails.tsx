import { ContentMetadata } from "./ContentReading.js";
import { InitializationScope } from "./InitializationReading.js";
import type { InitializationPackage } from "../shared/creative.js";
import type { MaterialPackage } from "../shared/story-materials.js";
import {
  actionLabel,
  kindLabel,
  receiptLabel,
  refLabel,
  targetLabel,
  type Information,
  type Reference,
} from "./free-client.js";

export function FreeReadingDetails({
  info,
  value,
  open,
}: {
  info: Information;
  value: Reference;
  open: (ref: Reference) => void;
}) {
  const draft = info.draft;
  const initialization = draft?.payload.business?.initialization as
    InitializationPackage | undefined;
  const materials = draft?.payload.business?.materials as
    MaterialPackage | undefined;
  return (
    <details className="free-details free-reading-details">
      <summary>
        {value.ref.type === "candidate" ? "稿件详情" : "资料详情"}
      </summary>
      {draft && (
        <>
          <h3>保存范围</h3>
          <p>
            {actionLabel[draft.payload.action]} ·{" "}
            {materials
              ? `${materials.story.content.name} · ${materials.members.length} 项资料`
              : draft.payload.draftContext.target
                ? targetLabel(draft.payload.draftContext.target)
                : "发送保存请求后核验具体目标"}
          </p>
          {initialization && <InitializationScope value={initialization} />}
          <p className="free-identity">
            基础版本：{draft.payload.draftContext.baseRevision ?? "新建"}
          </p>
        </>
      )}
      {info.content && (
        <>
          <h3>内容属性</h3>
          <ContentMetadata content={info.content} />
          <pre className="free-identity">
            {JSON.stringify(info.content.sourceMetadata, null, 2)}
          </pre>
        </>
      )}
      {draft?.payload.members?.map((member) => (
        <section key={member.member_id}>
          <h3>
            {kindLabel[member.kind] ?? member.kind} · {member.content.name}
          </h3>
          {materials && (
            <p>
              {member.mode === "create"
                ? "新增 · 无基础版本"
                : `更新 · 基于 v${member.baseVersion}`}
              {" · "}
              {info.receipt?.assets?.find(
                (asset) => asset.asset_id === member.member_id,
              )
                ? `已保存为 v${info.receipt.assets.find((asset) => asset.asset_id === member.member_id)!.revision}`
                : "尚未保存"}
            </p>
          )}
          {member.sourceRef ? (
            <button
              className="quiet"
              onClick={() =>
                open({
                  ref: member.sourceRef!,
                  title: `入包来源：${member.content.name}`,
                  recorded: true,
                })
              }
            >
              入包来源：{member.content.name} ·{" "}
              {member.sourceRef.type === "asset"
                ? `母版 v${member.sourceRef.version}`
                : "角色候选固定版本"}
            </button>
          ) : (
            materials && (
              <p className="muted">
                {member.mode === "update"
                  ? "基于故事既有资料修订"
                  : "原创故事资料"}
              </p>
            )
          )}
          <ContentMetadata content={member.content} />
          <pre className="free-identity">
            {JSON.stringify(member.content.sourceMetadata, null, 2)}
          </pre>
        </section>
      ))}
      {draft?.payload.business?.derivation != null && (
        <>
          <h3>独立母版的保留、改写与排除</h3>
          <pre className="free-identity">
            {JSON.stringify(draft.payload.business.derivation, null, 2)}
          </pre>
        </>
      )}
      <h3>版本与保存记录</h3>
      <p className="free-identity">{refLabel(value.ref)}</p>
      {info.currentVersion !== undefined && (
        <p>当前版本 v{info.currentVersion}</p>
      )}
      {draft?.payload.draftContext.target && (
        <pre className="free-identity">
          {JSON.stringify(draft.payload.draftContext.target, null, 2)}
        </pre>
      )}
      {info.receipt && (
        <>
          <p>
            {receiptLabel[info.receipt.kind]} · 第 {info.receipt.revision} 版
          </p>
          <p className="free-identity">保存记录：{info.receipt.operation_id}</p>
        </>
      )}
      {info.claim && (
        <p className="free-identity">
          原保存操作：{info.claim.status} · {info.claim.operationId}
        </p>
      )}
    </details>
  );
}
