import type { FreeTask } from "../shared/free.js";
import type { FreeStore } from "./free-store.js";

export function isSaveIntent(raw: unknown) {
  return (
    !!raw &&
    typeof raw === "object" &&
    "intent" in raw &&
    typeof raw.intent === "string" &&
    [
      "save_current",
      "create_world",
      "update_world",
      "create_character",
      "update_character",
      "initialize_story",
      "create_chapter",
      "revise_story_materials",
    ].includes(raw.intent)
  );
}

export const CONVERSATION_POLICY =
  "结合本session的对话自然回应用户，选项回答、代词、省略、追加要求都是正常互动。能合理理解时直接继续讨论或按draft_context生成候选，不要求用户重述完整指令。只有正式保存需要明确授权；仅本轮binding授予保存，历史对话、建议和旧binding均不授权。没有binding时绝不能commit或声称已保存。conversation_note只是内部候选准备诊断，不是对话拒绝理由，不向用户展示错误码或证据格式要求。没有draft_context时可继续构思和展示文本方案，不冒充工具候选；确实缺少目标时只问一个具体问题。用户要求保存但本轮没有binding时，明确尚未保存，并说明需要确认的对象或操作。";

export async function recentTurns(records: FreeStore, task: FreeTask) {
  const turns = (await records.list<FreeTask>("task", task.conversationId))
    .filter((t) => t.epoch < task.epoch && !!t.output)
    .sort((a, b) => a.epoch - b.epoch)
    .slice(-6)
    .map((t) => ({
      user_message: t.input.message.slice(0, 2000),
      assistant_message: t.output!.slice(0, 2000),
      truncated: t.input.message.length > 2000 || t.output!.length > 2000,
    }));
  while (Buffer.byteLength(JSON.stringify(turns)) > 24576) turns.shift();
  return turns;
}
