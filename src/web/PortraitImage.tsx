import { useEffect, useState } from "react";
import type { Api } from "./api.js";
import "./portrait.css";

export function PortraitImage({
  api,
  imageId,
  name,
  large = false,
}: {
  api: Api;
  imageId?: string;
  name: string;
  large?: boolean;
}) {
  const [image, setImage] = useState<{ id: string; src: string }>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setFailed(false);
    if (imageId)
      void api<{ data: string }>(`/portraits/${imageId}`)
        .then((result) => {
          if (active)
            setImage({
              id: imageId,
              src: `data:image/jpeg;base64,${result.data}`,
            });
        })
        .catch(() => {
          if (active) setFailed(true);
        });
    return () => {
      active = false;
    };
  }, [api, imageId]);
  return (
    <span className={`portrait-image${large ? " portrait-large" : ""}`}>
      {imageId && image?.id === imageId && !failed ? (
        <img
          src={image.src}
          alt={`${name}的头像`}
          onError={() => setFailed(true)}
        />
      ) : (
        <span
          role="img"
          aria-label={failed ? "头像读取失败" : `${name}暂无头像`}
        >
          {failed ? "!" : name.slice(0, 1) || "人"}
        </span>
      )}
    </span>
  );
}
