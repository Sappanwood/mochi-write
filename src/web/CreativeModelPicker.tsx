import type {
  CreativeConfiguration,
  ThinkingLevel,
} from "../shared/creative.js";
export interface CreativeModel {
  provider: string;
  id: string;
  name?: string;
  thinking_levels?: ThinkingLevel[];
}
const thinkingLabels: Record<ThinkingLevel, string> = {
  off: "关闭",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};
export function CreativeModelPicker({
  models,
  model,
  thinking,
  onModel,
  onThinking,
  locked,
  disabled,
}: {
  models: CreativeModel[];
  model: string;
  thinking: ThinkingLevel | "";
  onModel: (value: string) => void;
  onThinking: (value: ThinkingLevel | "") => void;
  locked?: CreativeConfiguration;
  disabled: boolean;
}) {
  const choice = models.find((m) => `${m.provider}/${m.id}` === model);
  if (locked)
    return (
      <div
        className="creative-model-locked"
        aria-label="会话模型设置"
        title="本会话的模型与思考强度已固定，更换请新建会话"
      >
        <span>
          {models.find(
            (m) => m.provider === locked.provider && m.id === locked.model,
          )?.name ?? locked.model}
        </span>
        <span>
          思考：
          {locked.thinkingLevel
            ? thinkingLabels[locked.thinkingLevel]
            : "原默认"}{" "}
          · 已固定
        </span>
      </div>
    );
  return (
    <div className="creative-model-settings">
      <label className="creative-model">
        <span className="sr-only">创作模型</span>
        <select
          aria-label="创作模型"
          value={model}
          disabled={disabled}
          onChange={(e) => {
            onModel(e.target.value);
            if (
              thinking &&
              !models
                .find((m) => `${m.provider}/${m.id}` === e.target.value)
                ?.thinking_levels?.includes(thinking)
            )
              onThinking("");
          }}
        >
          {models.map((m) => (
            <option
              key={`${m.provider}/${m.id}`}
              value={`${m.provider}/${m.id}`}
            >
              {m.name ?? m.id} · {m.provider}
            </option>
          ))}
        </select>
      </label>
      <label className="creative-thinking">
        <span className="sr-only">思考强度</span>
        <select
          aria-label="思考强度"
          value={thinking}
          disabled={disabled}
          onChange={(e) => onThinking(e.target.value as ThinkingLevel | "")}
        >
          <option value="">思考：默认</option>
          {choice?.thinking_levels?.map((level) => (
            <option key={level} value={level}>
              思考：{thinkingLabels[level]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
