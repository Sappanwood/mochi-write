import { CreativeTurn } from "./CreativeResults.js";
import { Markdown } from "./Markdown.js";
import { ReferenceChips } from "./FreeReferences.js";
import {
  assetPath,
  blocksMessage,
  actionLabel,
  refLabel,
  summaryRef,
  type Reference,
  type TaskDetail,
} from "./free-client.js";
const labels: Record<string, string> = {
  unresolved: "待解析 · 尚未绑定保存目标",
  resolving: "检索与核验目标 · 尚无正式写权限",
  binding: "正在核验绑定",
  authorized: "准备创作",
  running: "正在创作",
  succeeded: "讨论已完成",
  failed: "本轮失败",
  interrupted: "执行中断 · 待核实原任务",
  cancel_pending: "取消待确认",
  revoked: "已撤回",
  conflict: "版本冲突 · 原稿保留",
  committed: "保存已确认",
  verifying: "保存结果待核实",
  clarifying: "需要澄清目标",
};
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
            <span role="status" className="creative-status">
              {task.state === "revoked" &&
              task.executionRun?.status === "succeeded"
                ? "本轮已完成 · 后续授权已撤回"
                : (labels[task.state] ?? task.state)}
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
              已绑定：{task.action && actionLabel[task.action]} ·{" "}
              {task.target.kind !== "story"
                ? `${task.target.kind === "world" ? "世界观" : "角色"} ${task.target.asset_id}`
                : `故事 ${task.target.story_id}`}
            </p>
          )}
          {candidates.map((d) => (
            <div key={d.draft_id} className="creative-draft-card">
              <strong>
                {d.title} · 第 {d.ordinal} 稿
              </strong>
              <p className="muted">候选 · 组 {d.group_id.slice(0, 8)}</p>
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
              实际全文读取分别记录。仅搜索命中不代表已读取。
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
              <strong>
                {
                  {
                    world_created: "独立世界观母版已新建",
                    world_updated: "世界观母版已更新",
                    character_created: "独立角色母版已新建",
                    character_updated: "角色母版已更新",
                    story_initialized: "作品已建立",
                    first_chapter_saved: "作品与首章已保存",
                    chapter_created: "章节已保存",
                  }[task.receipt.kind]
                }
              </strong>
              <button
                className="secondary"
                onClick={() => {
                  sessionStorage.setItem(
                    "mochi-free:return",
                    task.conversationId,
                  );
                  navigate(
                    assetPath(task.receipt!.target, task.receipt!.chapter) +
                      (task.receipt!.target.kind !== "story" ? "/read" : ""),
                  );
                }}
              >
                打开正式内容
              </button>
              <p>真实收据 · 第 {task.receipt.revision} 版</p>
              <p className="free-identity">
                {task.receipt.operation_id} · {task.receipt.draft_id}
              </p>
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
