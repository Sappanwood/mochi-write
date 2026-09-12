export function ContentSummary({ markdown }: { markdown: string }) {
  const plain = markdown
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, " ")
    .replace(/^ {0,3}#{1,6}[\t ]+.*$/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/^[\t ]*(?:[-+*]|\d+\.)[\t ]+/gm, "")
    .replace(/[*_`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(plain);
  return (
    <p className="content-summary">
      {plain
        ? characters.slice(0, 96).join("") + (characters.length > 96 ? "…" : "")
        : "暂无内容摘要"}
    </p>
  );
}

export function UpdatedTime({ value }: { value: string }) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return <span>时间未知</span>;
  return (
    <time dateTime={value} title={date.toLocaleString("zh-CN")}>
      {new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(date)}
    </time>
  );
}
