import { z } from "zod";
import { AppError, type BundleFile, type Entity } from "../shared/model.js";
import {
  decodeImage,
  imageHash,
  requirePortraits,
  validateStoredPortrait,
  type PortraitStore,
} from "./portraits.js";

const imageFile = z
  .object({
    schema: z.literal("mochi-write/portrait@1"),
    data: z.string().max(700000),
  })
  .strict();
export const portraitPath = (id: string) => `portraits/${id}.json`;
export function bundlePortraits(files: BundleFile[], docs: Entity[]) {
  const result = new Map<string, Buffer>();
  for (const doc of docs) {
    const id = doc.portrait?.imageId;
    if (!id || result.has(id)) continue;
    const file = files.find((f) => f.path === portraitPath(id));
    if (!file) throw new AppError(400, "导出包缺少头像附件");
    const parsed = imageFile.parse(JSON.parse(file.text));
    const data = decodeImage(parsed.data);
    if (imageHash(data) !== id) throw new AppError(400, "头像附件校验失败");
    result.set(id, data);
  }
  return result;
}
export async function exportPortraits(
  docs: Entity[],
  images?: PortraitStore,
): Promise<BundleFile[]> {
  const ids = [
    ...new Set(
      docs.flatMap((doc) =>
        doc.portrait?.imageId ? [doc.portrait.imageId] : [],
      ),
    ),
  ];
  const files: BundleFile[] = [];
  for (const id of ids) {
    const data = await requirePortraits(images).get(id);
    if (!data || imageHash(data) !== id)
      throw new AppError(503, "头像附件缺失或损坏，无法完整导出");
    await validateStoredPortrait(data);
    files.push({
      path: portraitPath(id),
      text: JSON.stringify({
        schema: "mochi-write/portrait@1",
        data: data.toString("base64"),
      }),
    });
  }
  return files;
}
