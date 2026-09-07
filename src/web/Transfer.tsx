import { bundleLimits, bundleFileByteLimit } from "../shared/bundle-limits.js";
import { useState } from "react";
import { strToU8, zipSync } from "fflate";
import type { BundleFile } from "../shared/model.js";
import { type Api, message } from "./api.js";
export function Transfer({ api }: { api: Api }) {
  const [files, setFiles] = useState<BundleFile[]>([]),
    [batch, setBatch] = useState(""),
    [preview, setPreview] = useState<{
      count: number;
      counts: Record<string, number>;
    }>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function select(selected: FileList | null) {
    if (!selected) return;
    setBusy(true);
    setError("");
    setPreview(undefined);
    setFiles([]);
    setNotice("");
    try {
      const input = [...selected];
      const manifest = input.some(
        (f) =>
          f.webkitRelativePath.split("/").slice(1).join("/") ===
          "manifest.json",
      );
      const accepted = input.filter(
        (f) =>
          manifest || /^[^/]+\/(library|projects)\//.test(f.webkitRelativePath),
      );
      if (
        accepted.length > bundleLimits.files ||
        accepted.reduce((n, f) => n + f.size, 0) > bundleLimits.batchBytes ||
        accepted.some(
          (f) =>
            f.size >
            bundleFileByteLimit(
              f.webkitRelativePath.split("/").slice(1).join("/"),
            ),
        )
      )
        throw new Error(
          "超出导入限制：最多 1000 个文件，Markdown 单篇 1 MiB，清单及整个包均不超过 16 MiB",
        );
      const bundle = await Promise.all(
        accepted.map(async (file) => ({
          path: file.webkitRelativePath.split("/").slice(1).join("/"),
          text: new TextDecoder("utf-8", { fatal: true }).decode(
            await file.arrayBuffer(),
          ),
        })),
      );
      setFiles(bundle);
      setBatch(crypto.randomUUID());
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function inspect() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      setPreview(await api("/import/preview", { files, batchId: batch }));
    } catch (e) {
      setPreview(undefined);
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function commit() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ created: number; skipped: number }>(
        "/import",
        { files, batchId: batch },
      );
      setNotice(
        `导入完成：新增 ${result.created} 项，已存在 ${result.skipped} 项。`,
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ files: BundleFile[] }>("/export", {});
      const zip = zipSync(
        Object.fromEntries(result.files.map((f) => [f.path, strToU8(f.text)])),
      );
      const blob = new Blob([new Uint8Array(zip)], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `mochi-write-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("导出包已生成。");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const labels: Record<string, string> = {
    character: "角色",
    world: "世界观",
    story: "故事",
    chapter: "章节",
    setting: "设定",
    outline: "大纲",
    snapshot: "故事快照",
    vocabulary: "词表",
  };
  return (
    <>
      <header className="page-heading">
        <div>
          <p className="eyebrow">资料迁移</p>
          <h1>导入与导出</h1>
          <p>保留原始 Markdown，让资料可以带走。</p>
        </div>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <div className="transfer-grid">
        <section className="transfer-panel">
          <h2>导入 Markdown 目录</h2>
          <p>
            选择包含 library、projects 的旧素材目录，或已解压的 Mochi Write
            导出包。先预检，确认无误后导入。
          </p>
          <label className="file-label">
            选择资料目录
            <input
              type="file"
              {...{ webkitdirectory: "", directory: "" }}
              multiple
              disabled={busy}
              onChange={(e) => void select(e.target.files)}
            />
          </label>
          <p className="muted">
            仅读取源文件。最多 1000 个文件，Markdown 单篇 1
            MiB；清单及整个包均不超过 16 MiB。
          </p>
          {files.length > 0 && (
            <>
              <p>已选择 {files.length} 个文件</p>
              <label>
                导入批次标识
                <input
                  value={batch}
                  disabled={busy}
                  onChange={(e) => {
                    setBatch(e.target.value);
                    setPreview(undefined);
                  }}
                />
              </label>
              <p className="muted">
                失败后沿用相同标识与文件重试；输入变化需要新批次。
              </p>
              <button
                className="secondary"
                disabled={busy || !batch}
                onClick={() => void inspect()}
              >
                预检资料
              </button>
            </>
          )}
          {preview && (
            <div className="preview">
              <h3>预检通过 · {preview.count} 项</h3>
              <dl>
                {Object.entries(preview.counts).map(([kind, count]) => (
                  <div key={kind}>
                    <dt>{labels[kind] ?? kind}</dt>
                    <dd>{count}</dd>
                  </div>
                ))}
              </dl>
              <button disabled={busy} onClick={() => void commit()}>
                确认导入
              </button>
            </div>
          )}
        </section>
        <section className="transfer-panel">
          <h2>导出当前资料</h2>
          <p>
            下载包含 Markdown、原始字段与校验清单的
            ZIP。故事快照保持独立，解压后可再次导入。
          </p>
          <p className="muted">
            包含当前内容及导入溯源，不包含全部历史版本或 Agent 会话。
          </p>
          <button disabled={busy} onClick={() => void download()}>
            下载 Markdown 导出包
          </button>
        </section>
      </div>
    </>
  );
}
