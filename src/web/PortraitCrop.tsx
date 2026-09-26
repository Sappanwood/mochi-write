import { useEffect, useRef, useState } from "react";
import { message } from "./api.js";
import { portraitWidth, portraitHeight } from "../shared/portrait.js";

export function PortraitCrop({
  onCrop,
}: {
  onCrop: (data: string) => Promise<void>;
}) {
  const [source, setSource] = useState<ImageBitmap>();
  const [zoom, setZoom] = useState(1),
    [x, setX] = useState(50),
    [y, setY] = useState(50);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null);
  const selection = useRef(0);
  useEffect(
    () => () => {
      source?.close();
    },
    [source],
  );
  useEffect(
    () => () => {
      selection.current++;
    },
    [],
  );
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx || !source) return;
    const ratio = portraitWidth / portraitHeight;
    const width = Math.min(source.width, source.height * ratio) / zoom;
    const height = width / ratio;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, portraitWidth, portraitHeight);
    ctx.drawImage(
      source,
      ((source.width - width) * x) / 100,
      ((source.height - height) * y) / 100,
      width,
      height,
      0,
      0,
      portraitWidth,
      portraitHeight,
    );
  }, [source, zoom, x, y]);
  async function select(file?: File) {
    if (!file) return;
    const current = ++selection.current;
    setError("");
    try {
      if (
        !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
        file.size > 8 * 1024 * 1024
      )
        throw new Error("请选择不超过 8 MiB 的 PNG、JPEG 或 WebP 图片");
      const bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
      if (current !== selection.current) {
        bitmap.close();
        return;
      }
      if (bitmap.width * bitmap.height > 16_000_000) {
        bitmap.close();
        throw new Error("图片不能超过 1600 万像素");
      }
      setSource(bitmap);
      setZoom(1);
      setX(50);
      setY(50);
    } catch (e) {
      if (current === selection.current) setError(message(e));
    }
  }
  async function useCrop() {
    if (!canvas.current) return;
    setBusy(true);
    setError("");
    try {
      await onCrop(canvas.current.toDataURL("image/jpeg", 0.85).split(",")[1]!);
      setSource(undefined);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="portrait-crop">
      <label>
        上传头像
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          disabled={busy}
          onChange={(e) => {
            void select(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </label>
      <button
        type="button"
        className="secondary"
        aria-label="粘贴头像图片"
        disabled={busy}
        onPaste={(e) => {
          if (e.currentTarget.matches(":disabled")) return;
          const file = Array.from(e.clipboardData.files).find((item) =>
            item.type.startsWith("image/"),
          );
          if (!file) {
            setError("剪贴板中没有图片，请复制图片本身或截图后再粘贴");
            return;
          }
          e.preventDefault();
          void select(file);
        }}
      >
        点击此处，再按 Ctrl / ⌘ + V 粘贴图片
      </button>
      <p className="muted">3:4 竖幅头像，可调整缩放与位置。</p>
      {source && (
        <>
          <canvas
            ref={canvas}
            width={portraitWidth}
            height={portraitHeight}
            aria-label="头像裁剪预览"
          />
          <label>
            缩放
            <input
              type="range"
              min={1}
              max={3}
              step={0.05}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              disabled={busy}
            />
          </label>
          <label>
            水平位置
            <input
              type="range"
              min={0}
              max={100}
              value={x}
              onChange={(e) => setX(Number(e.target.value))}
              disabled={busy}
            />
          </label>
          <label>
            垂直位置
            <input
              type="range"
              min={0}
              max={100}
              value={y}
              onChange={(e) => setY(Number(e.target.value))}
              disabled={busy}
            />
          </label>
          <div className="actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => void useCrop()}
            >
              {busy ? "正在上传…" : "使用此裁剪"}
            </button>
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => setSource(undefined)}
            >
              取消裁剪
            </button>
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
