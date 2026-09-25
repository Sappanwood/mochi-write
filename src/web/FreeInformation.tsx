import { ContentReading } from "./ContentReading.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Api } from "./api.js";
import { message } from "./api.js";
import type { CandidateGroup } from "../shared/free-candidates.js";
import type {
  CreativeDraft,
  InitializationPackage,
} from "../shared/creative.js";
import type { MaterialPackage } from "../shared/story-materials.js";
import { InitializationReading } from "./InitializationReading.js";
import { ReferenceSearch } from "./FreeReferences.js";
import {
  readInformation,
  root,
  refKey,
  refLabel,
  summaryRef,
  actionLabel,
  receiptLabel,
  targetLabel,
  kindLabel,
  type Reference,
  type Information,
  type Summary,
} from "./free-client.js";
export interface ReadingState {
  current?: Reference;
  recent: Reference[];
  explorer: boolean;
  query: string;
  kind: string;
  storyId: string;
  scroll: number;
  scrollByRef?: Record<string, number>;
  loadId?: number;
}
export function FreeInformation({
  api,
  base,
  reading,
  receiptsVersion,
  setReading,
  groups,
  drafts,
  attach,
  feedback,
  open,
  onError,
}: {
  api: Api;
  base: string;
  reading: ReadingState;
  receiptsVersion: string;
  setReading: (
    value: ReadingState | ((old: ReadingState) => ReadingState),
  ) => void;
  groups: CandidateGroup[];
  drafts: Summary[];
  attach: (ref: Reference) => void;
  feedback: (ref: Reference, quote?: string) => void;
  open: (ref: Reference) => void;
  onError: (error: string) => void;
}) {
  const [loadedInfo, setInfo] = useState<Information>(),
    [loadedKey, setLoadedKey] = useState<string>(),
    [error, setError] = useState(""),
    [selection, setSelection] = useState<{ key: string; text: string }>();
  const pane = useRef<HTMLDivElement>(null);
  const value = reading.current;
  const loadKey = `${value ? refKey(value.ref) : ""}:${reading.loadId ?? 0}:${receiptsVersion}`;
  const info = loadedKey === loadKey ? loadedInfo : undefined;
  const canFeedback = info?.availability === "exact" && !error;
  const selectedText = selection?.key === loadKey ? selection.text : "";
  useEffect(() => {
    setSelection(undefined);
    if (!canFeedback || reading.explorer) return;
    const capture = () => {
      const selected = window.getSelection();
      if (!selected || selected.isCollapsed || selected.rangeCount !== 1) {
        setSelection(undefined);
        return;
      }
      const range = selected.getRangeAt(0);
      const article = [
        ...(pane.current?.querySelectorAll(".markdown") ?? []),
      ].find(
        (element) =>
          element.contains(range.startContainer) &&
          element.contains(range.endContainer),
      );
      const text = article ? selected.toString().trim() : "";
      setSelection(text ? { key: loadKey, text } : undefined);
    };
    document.addEventListener("selectionchange", capture);
    return () => document.removeEventListener("selectionchange", capture);
  }, [loadKey, canFeedback, reading.explorer]);
  useEffect(() => {
    setInfo(undefined);
    setLoadedKey(undefined);
    setError("");
    if (!value) return;
    let active = true;
    void readInformation(api, base, value)
      .then((v) => {
        if (active) {
          setInfo(v);
          setLoadedKey(loadKey);
        }
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    return () => {
      active = false;
    };
  }, [api, base, loadKey]);
  useLayoutEffect(() => {
    if (info && pane.current) pane.current.scrollTop = reading.scroll;
  }, [info, reading.explorer]);
  const currentDraft = info?.draft;
  const title = currentDraft
    ? `${info?.content?.name ?? currentDraft.title} · 第 ${currentDraft.ordinal} 稿`
    : (info?.content?.name ??
      (value && value.title !== refLabel(value.ref)
        ? value.title
        : "资料与草稿"));
  const displayedReference = value ? { ...value, title } : undefined;
  const materials =
    currentDraft?.artifactKind === "story_materials"
      ? (currentDraft.payload.business?.materials as
          MaterialPackage | undefined)
      : undefined;
  const versions = currentDraft
    ? drafts.filter((d) => d.group_id === currentDraft.groupId)
    : [];
  const choose = (d?: Summary) => {
    if (d)
      open({
        ref: summaryRef(d),
        title: `${d.title} · 第 ${d.ordinal} 稿`,
        recorded: true,
      });
  };
  return (
    <section className="free-information" aria-label="当前信息">
      <header className="free-pane-heading">
        <h2>{reading.explorer ? "查找资料" : title}</h2>
        <button
          className="quiet"
          onClick={() => setReading((r) => ({ ...r, explorer: !r.explorer }))}
        >
          {reading.explorer ? "返回详情" : "查找资料"}
        </button>
        <details className="free-recent">
          <summary>最近内容</summary>
          {reading.recent.map((r) => (
            <button
              className="quiet"
              key={refKey(r.ref)}
              onClick={() => open(r)}
            >
              {r.title}
            </button>
          ))}
        </details>
      </header>
      {reading.explorer ? (
        <div className="free-explorer">
          <h3>查找资料与草稿</h3>
          <label>
            按名称查找
            <input
              value={reading.query}
              onChange={(e) =>
                setReading((r) => ({ ...r, query: e.target.value }))
              }
            />
          </label>
          <div className="free-explorer-filters">
            <label>
              内容范围
              <select
                value={reading.kind}
                onChange={(e) =>
                  setReading((r) => ({ ...r, kind: e.target.value }))
                }
              >
                <option value="">全部可用范围</option>
                {[
                  "character",
                  "world",
                  "story",
                  ...(base !== root ? ["candidate"] : []),
                  ...(reading.storyId
                    ? ["setting", "outline", "snapshot", "chapter"]
                    : []),
                ].map((k) => (
                  <option key={k} value={k}>
                    {kindLabel[k]}
                  </option>
                ))}
              </select>
            </label>
            {reading.storyId && (
              <button
                className="quiet"
                onClick={() =>
                  setReading((r) => ({ ...r, storyId: "", kind: "" }))
                }
              >
                离开故事范围
              </button>
            )}
          </div>
          <ReferenceSearch
            api={api}
            base={base}
            query={reading.query}
            kind={reading.kind || undefined}
            storyId={reading.storyId || undefined}
            select={open}
            onError={onError}
          />
        </div>
      ) : (
        <>
          {value ? (
            <>
              <div className="free-info-heading">
                <p className="eyebrow">
                  {value.ref.type === "candidate"
                    ? "创作草稿"
                    : "正式资产 · 精确版本"}
                </p>
                {currentDraft && (
                  <p className="free-draft-status">
                    第 {currentDraft.ordinal} 稿
                    {currentDraft.id === versions.at(-1)?.draft_id
                      ? " · 最新"
                      : " · 历史稿"}
                    {info?.receipt
                      ? " · 已保存"
                      : !info?.claim
                        ? " · 未保存"
                        : ""}
                  </p>
                )}
                {info?.currentVersion !== undefined &&
                  value.ref.type === "asset" && (
                    <p>
                      正在看 v{value.ref.version} · 当前版本 v
                      {info.currentVersion}
                      {value.ref.version !== info.currentVersion
                        ? "（历史版本）"
                        : ""}
                      {info.currentDeleted ? " · 当前资产已删除" : ""}
                    </p>
                  )}
                {currentDraft && (
                  <>
                    <div className="free-version-controls">
                      <label>
                        草稿
                        <select
                          aria-label="草稿"
                          value={currentDraft.groupId}
                          onChange={(e) =>
                            choose(
                              drafts
                                .filter((d) => d.group_id === e.target.value)
                                .at(-1),
                            )
                          }
                        >
                          {groups.map((g) => (
                            <option key={g.id} value={g.id}>
                              {drafts.find((d) => d.group_id === g.id)?.title ??
                                kindLabel[g.artifactKind]}{" "}
                              · {kindLabel[g.artifactKind]} · {g.id.slice(0, 8)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        版本
                        <select
                          aria-label="版本"
                          value={currentDraft.id}
                          onChange={(e) =>
                            choose(
                              drafts.find((d) => d.draft_id === e.target.value),
                            )
                          }
                        >
                          {versions.map((d) => (
                            <option key={d.draft_id} value={d.draft_id}>
                              第 {d.ordinal} 稿
                              {d.draft_id === versions.at(-1)?.draft_id
                                ? " · 最新"
                                : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <p>
                      {actionLabel[currentDraft.payload.action]} ·{" "}
                      {materials
                        ? `${materials.story.content.name} · ${materials.members.length} 项资料`
                        : currentDraft.payload.draftContext.target
                          ? targetLabel(
                              currentDraft.payload.draftContext.target,
                            )
                          : "新建独立母版，发送保存请求后核验目标"}
                    </p>
                    {materials && (
                      <p className="muted">
                        仅保存列明的成员，引用资料仅供参考。
                      </p>
                    )}
                  </>
                )}
                {info?.receipt ? (
                  <p className="notice">
                    {receiptLabel[info.receipt.kind]} · 第{" "}
                    {info.receipt.revision} 版
                  </p>
                ) : (
                  info?.claim && (
                    <p className="notice">
                      {info.claim.status === "conflict"
                        ? "版本冲突 · 草稿已保留"
                        : info.claim.status === "revoked"
                          ? "保存授权已撤回"
                          : "保存结果待核实"}
                    </p>
                  )
                )}
                <details className="free-details">
                  <summary>版本与保存详情</summary>
                  <p className="free-identity">{refLabel(value.ref)}</p>
                  {currentDraft && (
                    <>
                      <p className="free-identity">
                        基础版本：
                        {currentDraft.payload.draftContext.baseRevision ??
                          "新建"}
                      </p>
                      {currentDraft.payload.draftContext.target && (
                        <pre className="free-identity">
                          {JSON.stringify(
                            currentDraft.payload.draftContext.target,
                            null,
                            2,
                          )}
                        </pre>
                      )}
                      <p>浏览此稿不代表保存授权。</p>
                    </>
                  )}
                  {info?.receipt && (
                    <p className="free-identity">
                      保存记录：{info.receipt.operation_id}
                    </p>
                  )}
                  {info?.claim && (
                    <p className="free-identity">
                      原保存操作：{info.claim.status} · {info.claim.operationId}
                    </p>
                  )}
                </details>
              </div>
              <div
                ref={pane}
                className="free-reading reading-pane"
                role="region"
                aria-label="信息正文"
                onScroll={(e) => {
                  if (
                    !e.currentTarget.clientHeight ||
                    !info ||
                    loadedKey !== loadKey
                  )
                    return;
                  const scroll = e.currentTarget.scrollTop;
                  setReading((r) => ({
                    ...r,
                    scroll,
                    scrollByRef: {
                      ...r.scrollByRef,
                      [refKey(value.ref)]: scroll,
                    },
                  }));
                }}
              >
                {error && (
                  <p role="alert" className="error">
                    {error}
                  </p>
                )}
                {!info && !error && <p role="status">正在读取精确内容…</p>}
                {info?.availability === "unavailable" && (
                  <p role="status">原版本不可取得，不会用当前新版代替。</p>
                )}
                {info?.availability === "exact" &&
                  (currentDraft?.artifactKind === "story_initialization" ? (
                    <InitializationReading
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
                {currentDraft?.payload.members?.map((m) => (
                  <details key={m.member_id}>
                    <summary>
                      {kindLabel[m.kind] ?? m.kind} · {m.content.name}
                    </summary>
                    {materials && (
                      <p>
                        {m.mode === "create"
                          ? "新增 · 无基础版本"
                          : `更新 · 基于 v${m.baseVersion}`}{" "}
                        ·{" "}
                        {info?.receipt?.assets?.find(
                          (a) => a.asset_id === m.member_id,
                        )
                          ? `已保存为 v${info.receipt.assets.find((a) => a.asset_id === m.member_id)!.revision}`
                          : "尚未保存"}
                      </p>
                    )}
                    {materials &&
                      (m.sourceRef ? (
                        <button
                          className="quiet"
                          onClick={() =>
                            open({
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
                  </details>
                ))}
                {currentDraft?.payload.business?.derivation != null && (
                  <details>
                    <summary>独立母版的保留、改写与排除</summary>
                    <pre className="free-identity">
                      {JSON.stringify(
                        currentDraft.payload.business.derivation,
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                )}
              </div>
              <footer className="free-info-actions">
                {value.ref.type === "candidate" && (
                  <div className="free-feedback-actions">
                    <button
                      className="secondary"
                      disabled={!canFeedback}
                      onClick={() =>
                        canFeedback && feedback(displayedReference!)
                      }
                    >
                      针对这一稿提意见
                    </button>
                    <button
                      className="quiet"
                      disabled={!canFeedback || !selectedText}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        if (canFeedback && selectedText)
                          feedback(displayedReference!, selectedText);
                      }}
                    >
                      针对选中段落提意见
                    </button>
                    <small className="muted">
                      {selectedText
                        ? `已选 ${Array.from(selectedText).length} 字 · 添加到消息后可编辑`
                        : "选中正文，可针对段落提意见"}
                    </small>
                  </div>
                )}
                <button
                  className="secondary"
                  disabled={!canFeedback}
                  onClick={() => attach(displayedReference!)}
                >
                  引用到对话
                </button>
                {value.ref.type === "asset" && value.ref.kind === "story" && (
                  <button
                    className="quiet"
                    onClick={() =>
                      setReading((r) => ({
                        ...r,
                        explorer: true,
                        storyId:
                          value.ref.type === "asset" ? value.ref.asset_id : "",
                        kind: "",
                      }))
                    }
                  >
                    浏览故事资料
                  </button>
                )}
              </footer>
            </>
          ) : (
            <p className="empty">
              从对话打开一份候选，或浏览资产。查看不会自动引用到消息。
            </p>
          )}
        </>
      )}
    </section>
  );
}
