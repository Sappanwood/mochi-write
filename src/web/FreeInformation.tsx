import { useEffect, useRef, useState } from "react";
import type { Api } from "./api.js";
import { message } from "./api.js";
import type { CandidateGroup } from "../shared/free-candidates.js";
import type {
  CreativeDraft,
  InitializationPackage,
} from "../shared/creative.js";
import { Markdown } from "./Markdown.js";
import { InitializationReading } from "./InitializationReading.js";
import { ReferenceSearch } from "./FreeReferences.js";
import {
  readInformation,
  root,
  refKey,
  refLabel,
  summaryRef,
  actionLabel,
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
  open: (ref: Reference) => void;
  onError: (error: string) => void;
}) {
  const [info, setInfo] = useState<Information>(),
    [error, setError] = useState("");
  const pane = useRef<HTMLDivElement>(null);
  const value = reading.current;
  useEffect(() => {
    setInfo(undefined);
    setError("");
    if (!value) return;
    let active = true;
    void readInformation(api, base, value)
      .then((v) => {
        if (active) setInfo(v);
      })
      .catch((e) => {
        if (active) setError(message(e));
      });
    return () => {
      active = false;
    };
  }, [api, base, value && refKey(value.ref), reading.loadId, receiptsVersion]);
  useEffect(() => {
    if (info && pane.current) pane.current.scrollTop = reading.scroll;
  }, [info, reading.explorer]);
  const currentDraft = info?.draft;
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
        <h2>信息阅览</h2>
        <button
          className="quiet"
          onClick={() => setReading((r) => ({ ...r, explorer: !r.explorer }))}
        >
          {reading.explorer ? "返回详情" : "打开 explorer"}
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
          <h3>explorer · 资产与候选</h3>
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
                    ? "候选 · 尚非正式资产"
                    : "正式资产 · 精确版本"}
                </p>
                <h3>{info?.content?.name ?? value.title}</h3>
                <p className="muted free-identity">{refLabel(value.ref)}</p>
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
                        成果组
                        <select
                          aria-label="成果组"
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
                              · 组 {g.id.slice(0, 8)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        组内版本
                        <select
                          aria-label="组内版本"
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
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <p>
                      {actionLabel[currentDraft.payload.action]} ·{" "}
                      {currentDraft.payload.draftContext.target
                        ? JSON.stringify(
                            currentDraft.payload.draftContext.target,
                          )
                        : "新建独立母版，发送保存请求后核验目标"}
                    </p>
                    <p className="muted">
                      基础版本：
                      {currentDraft.payload.draftContext.baseRevision ?? "新建"}
                      。浏览此稿不代表保存授权。
                    </p>
                  </>
                )}
                {info?.receipt ? (
                  <p className="notice">
                    已由真实收据确认 · {info.receipt.kind} · v
                    {info.receipt.revision} · {info.receipt.operation_id}
                  </p>
                ) : (
                  info?.claim && (
                    <p className="notice">
                      原保存操作：{info.claim.status} · {info.claim.operationId}
                    </p>
                  )
                )}
              </div>
              <div
                ref={pane}
                className="free-reading reading-pane"
                role="region"
                aria-label="信息正文"
                onScroll={(e) => {
                  const scroll = e.currentTarget.scrollTop;
                  setReading((r) => ({ ...r, scroll }));
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
                  ) : (
                    <Markdown text={info.content?.markdown ?? ""} />
                  ))}
                {currentDraft?.payload.members?.map((m) => (
                  <details key={m.member_id}>
                    <summary>
                      {kindLabel[m.kind] ?? m.kind} · {m.content.name}
                    </summary>
                    <Markdown text={m.content.markdown} />
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
                <button
                  className="secondary"
                  disabled={info?.availability !== "exact" || !!error}
                  onClick={() => attach(value)}
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
