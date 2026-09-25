import { CreativeTurn } from "./CreativeResults.js";
import { Markdown } from "./Markdown.js";
import { ReferenceChips } from "./FreeReferences.js";
import {
  assetPath,
  blocksMessage,
  actionLabel,
  receiptLabel,
  targetLabel,
  taskStatusLabel,
  refLabel,
  summaryRef,
  type Reference,
  type TaskDetail,
} from "./free-client.js";
export function FreeTimeline({
  details,
  navigate,
  open,
  operate,
  busy,
}: {
  details: TaskDetail[];
  navigate: (path: string) => void;
  open: (r: Reference) => void;
  operate: (id: string, action: "cancel" | "verify") => void;
  busy: boolean;
}) {
  return (
    <>
      {details.map(({ task, candidates, sources }) => (
        <CreativeTurn
          key={task.id}
          id={task.id}
          message={task.input.message}
          status={
            <span
              role="status"
              className={`creative-status ${["failed", "interrupted", "cancel_pending", "conflict", "verifying", "clarifying"].includes(task.state) ? "free-status-attention" : ["succeeded", "revoked"].includes(task.state) ? "free-status-settled" : ""}`}
            >
              {task.state === "revoked" &&
              task.executionRun?.status === "succeeded"
                ? "本轮已完成 · 后续授权已撤回"
                : taskStatusLabel(task)}
            </span>
          }
          references={
            <>
              <small>本消息显式引用（已固定）</small>
              <ReferenceChips
                values={task.refs.map((ref) => ({
                  ref,
                  title: refLabel(ref),
                  recorded: true,
                }))}
                open={open}
              />
            </>
          }
        >
          {task.output && <Markdown text={task.output} />}
          {task.storyGuidance && (
            <details className="free-details">
              <summary>本轮写作指引</summary>
              <p className="muted">
                执行前固定 · 故事第 {task.storyGuidance.story_version} 版
              </p>
              {task.storyGuidance.text ? (
                <Markdown text={task.storyGuidance.text} />
              ) : (
                <p>本轮未设置写作指引。</p>
              )}
              <button
                className="quiet"
                onClick={() =>
                  navigate(`story/${task.storyGuidance!.story_id}/chapter`)
                }
              >
                查看故事与当前指引
              </button>
            </details>
          )}
          {task.error && (
            <p role="alert" className="error">
              {task.error === "world_creation_unavailable"
                ? "此会话尚不支持生成或保存世界观，请使用上方的新建会话入口。"
                : task.error}
            </p>
          )}
          {task.state === "clarifying" &&
            task.error !== "world_creation_unavailable" && (
              <p>
                请明确要讨论或保存的对象、范围和版本；当前阅读不会作为保存目标。
              </p>
            )}
          {task.target && (
            <p className="notice free-identity">
              保存目标：{task.action && actionLabel[task.action]} ·{" "}
              {targetLabel(task.target)}
            </p>
          )}
          {task.target && (
            <details className="free-details">
              <summary>目标详情</summary>
              <pre className="free-identity">
                {JSON.stringify(task.target, null, 2)}
              </pre>
            </details>
          )}
          {candidates.map((d) => (
            <div key={d.draft_id} className="creative-draft-card">
              <strong>
                {d.title} · 第 {d.ordinal} 稿
              </strong>
              <p className="muted">草稿 · {d.group_id.slice(0, 8)}</p>
              <button
                className="secondary"
                onClick={() =>
                  open({
                    ref: summaryRef(d),
                    title: `${d.title} · 第 ${d.ordinal} 稿`,
                    recorded: true,
                  })
                }
              >
                查看：{d.title} · 第 {d.ordinal} 稿 · 组{" "}
                {d.group_id.slice(0, 8)}
              </button>
            </div>
          ))}
          <details className="creative-sources">
            <summary>本轮参考资料 · {sources.length}</summary>
            <p className="muted">
              用户显式引用与 Agent
              实际全文读取分别记录。仅搜索命中不代表已读取。参考资料不会自动成为资料包成员。
            </p>
            {sources.map((s) => (
              <div key={s.id}>
                <p>
                  {s.origin === "agent_read"
                    ? "Agent 自主实际读取"
                    : s.origin === "initial"
                      ? "初始上下文"
                      : "用户显式引用"}
                </p>
                <button
                  className="quiet free-identity"
                  onClick={() =>
                    open({ ref: s.ref, title: refLabel(s.ref), recorded: true })
                  }
                >
                  {refLabel(s.ref)}
                </button>
              </div>
            ))}
          </details>
          {task.receipt && (
            <div className="notice creative-receipt">
              <strong>{receiptLabel[task.receipt.kind]}</strong>
              <button
                className="secondary"
                onClick={() => {
                  sessionStorage.setItem(
                    "mochi-free:return",
                    task.conversationId,
                  );
                  const member =
                    task.receipt!.kind === "story_materials_saved"
                      ? task.receipt!.assets?.[0]
                      : undefined;
                  navigate(
                    member && task.receipt!.target.kind === "story"
                      ? `story/${task.receipt!.target.story_id}/${member.kind}/${member.asset_id}`
                      : assetPath(task.receipt!.target, task.receipt!.chapter) +
                          (task.receipt!.target.kind !== "story"
                            ? "/read"
                            : ""),
                  );
                }}
              >
                打开正式内容
              </button>
              <p>第 {task.receipt.revision} 版</p>
              {task.receipt.kind === "story_materials_saved" &&
                task.receipt.assets?.map((a) => (
                  <button
                    className="quiet"
                    key={a.asset_id}
                    onClick={() => {
                      sessionStorage.setItem(
                        "mochi-free:return",
                        task.conversationId,
                      );
                      if (task.receipt!.target.kind === "story")
                        navigate(
                          `story/${task.receipt!.target.story_id}/${a.kind}/${a.asset_id}`,
                        );
                    }}
                  >
                    {a.mode === "create" ? "新增" : "更新"}{" "}
                    {a.kind === "snapshot"
                      ? "角色快照"
                      : a.kind === "setting"
                        ? "设定"
                        : "大纲"}{" "}
                    · v{a.revision}
                  </button>
                ))}
              <details className="free-details">
                <summary>保存详情</summary>
                <p className="free-identity">
                  {JSON.stringify(task.receipt.target)}
                </p>
                <p className="free-identity">
                  {task.receipt.operation_id} · {task.receipt.draft_id}
                </p>
              </details>
              <button
                className="quiet"
                onClick={() => {
                  const d = candidates.find(
                    (d) => d.draft_id === task.receipt!.draft_id,
                  );
                  const ref = d
                    ? summaryRef(d)
                    : task.refs.find(
                        (r) =>
                          r.type === "candidate" &&
                          r.draft_id === task.receipt!.draft_id,
                      );
                  if (ref)
                    open({ ref, title: "已保存的精确候选", recorded: true });
                }}
              >
                查看保存版本
              </button>
            </div>
          )}
          {(blocksMessage(task) || (task.target && !task.receipt)) && (
            <div className="creative-navigation">
              <button
                className="secondary"
                disabled={busy}
                onClick={() => operate(task.id, "verify")}
              >
                核实原任务与保存结果
              </button>
              <button
                className="quiet"
                disabled={busy}
                onClick={() => operate(task.id, "cancel")}
              >
                {task.stopPending ? "重试停止" : "停止并撤回授权"}
              </button>
            </div>
          )}
        </CreativeTurn>
      ))}
    </>
  );
}
