import { useEffect, useRef, useState } from "react";
import type { Api } from "./api.js";
import { message } from "./api.js";
import { FreeCandidateReading } from "./FreeCandidateReading.js";
import {
  readInformation,
  summaryRef,
  type Information,
  type Summary,
} from "./free-client.js";
import "./free-comparison.css";

function ComparisonBody({
  api,
  base,
  draft,
  side,
}: {
  api: Api;
  base: string;
  draft: Summary;
  side: string;
}) {
  const [info, setInfo] = useState<Information>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void readInformation(api, base, {
      ref: summaryRef(draft),
      title: draft.title,
      recorded: true,
    })
      .then((value) => {
        if (active) setInfo(value);
      })
      .catch((error) => {
        if (active) setError(message(error));
      });
    return () => {
      active = false;
    };
  }, [api, base, draft]);
  return (
    <div
      className="free-comparison-body reading-pane"
      role="region"
      aria-label={`${side}稿件`}
    >
      {error ? (
        <p role="alert" className="error">
          此稿暂不可取得：{error}
        </p>
      ) : !info ? (
        <p role="status">正在读取精确内容…</p>
      ) : info.availability !== "exact" ? (
        <p role="alert">原版本不可取得，不会用其他稿件代替。</p>
      ) : (
        <FreeCandidateReading info={info} expanded />
      )}
    </div>
  );
}

export function FreeComparison({
  api,
  base,
  versions,
  currentId,
  close,
}: {
  api: Api;
  base: string;
  versions: Summary[];
  currentId: string;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [left, setLeft] = useState(currentId);
  const [right, setRight] = useState(() => {
    const index = versions.findIndex((draft) => draft.draft_id === currentId);
    return versions[index > 0 ? index - 1 : 1]!.draft_id;
  });
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => {
      element.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="free-comparison"
      aria-labelledby="free-comparison-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header>
        <div>
          <p className="eyebrow">
            {versions.find((draft) => draft.draft_id === currentId)?.title}
          </p>
          <h2 id="free-comparison-title">稿件版本对照</h2>
        </div>
        <button className="quiet" onClick={close} autoFocus>
          关闭对照
        </button>
      </header>
      <div className="free-comparison-columns">
        {[
          { side: "左侧", id: left, change: setLeft },
          { side: "右侧", id: right, change: setRight },
        ].map(({ side, id, change }) => (
          <section className="free-comparison-version" key={side}>
            <label>
              {side}版本
              <select
                aria-label={`${side}版本`}
                value={id}
                onChange={(event) => change(event.target.value)}
              >
                {versions.map((draft) => (
                  <option key={draft.draft_id} value={draft.draft_id}>
                    {draft.title} · 第 {draft.ordinal} 稿
                  </option>
                ))}
              </select>
            </label>
            <ComparisonBody
              key={id}
              api={api}
              base={base}
              draft={versions.find((draft) => draft.draft_id === id)!}
              side={side}
            />
          </section>
        ))}
      </div>
    </dialog>
  );
}
