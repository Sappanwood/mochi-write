import { useLayoutEffect, useRef, useState } from "react";

const key = "mochi-free:discussion-share";
const clamp = (value: number) => Math.max(30, Math.min(65, Math.round(value)));

export function FreeSplit() {
  const divider = useRef<HTMLDivElement>(null);
  const [share, setShare] = useState(() => {
    const stored = Number(sessionStorage.getItem(key) ?? 40);
    return Number.isFinite(stored) ? clamp(stored) : 40;
  });
  useLayoutEffect(() => {
    divider.current?.parentElement?.style.setProperty(
      "--free-discussion-share",
      String(share),
    );
    sessionStorage.setItem(key, String(share));
  }, [share]);
  return (
    <div
      ref={divider}
      className="free-split"
      role="separator"
      tabIndex={0}
      aria-label="调整讨论与稿件宽度"
      aria-orientation="vertical"
      aria-valuemin={30}
      aria-valuemax={65}
      aria-valuenow={share}
      aria-valuetext={`讨论 ${share}%，稿件 ${100 - share}%`}
      onKeyDown={(event) => {
        const next = {
          ArrowLeft: share - 2,
          ArrowRight: share + 2,
          Home: 30,
          End: 65,
        }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        setShare(clamp(next));
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const bounds =
          event.currentTarget.parentElement!.getBoundingClientRect();
        const width = event.currentTarget.getBoundingClientRect().width;
        setShare(
          clamp(
            ((event.clientX - bounds.left - width / 2) /
              (bounds.width - width)) *
              100,
          ),
        );
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
    />
  );
}
