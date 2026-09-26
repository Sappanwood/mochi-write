import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Store } from "./store.js";
import { AppError } from "../shared/model.js";
import {
  imageIdSchema,
  portraitSchema,
  portraitWidth,
  portraitHeight,
} from "../shared/portrait.js";
import { clean } from "./entities.js";

export interface PortraitStore {
  put(id: string, data: Buffer): Promise<void>;
  get(id: string): Promise<Buffer | undefined>;
}
export const imageHash = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");
export function requirePortraits(store?: PortraitStore): PortraitStore {
  if (!store) throw new AppError(503, "图片存储尚未配置；提示词仍可编辑保存");
  return store;
}
export function decodeImage(data: string, maxBytes = 512 * 1024) {
  if (
    !data ||
    data.length > Math.ceil(maxBytes / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  )
    throw new AppError(400, "图片编码或大小无效");
  const buffer = Buffer.from(data, "base64");
  if (buffer.length > maxBytes || buffer.toString("base64") !== data)
    throw new AppError(400, "图片编码或大小无效");
  return buffer;
}
export async function normalizePortrait(data: Buffer) {
  try {
    const jpeg = data[0] === 0xff && data[1] === 0xd8;
    const png = data
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const webp =
      data.toString("ascii", 0, 4) === "RIFF" &&
      data.toString("ascii", 8, 12) === "WEBP";
    if (!jpeg && !png && !webp) throw new Error();
    const source = sharp(data, {
      limitInputPixels: 16_000_000,
      failOn: "warning",
    });
    const meta = await source.metadata();
    if (
      !["png", "jpeg", "webp"].includes(meta.format ?? "") ||
      (meta.pages ?? 1) !== 1
    )
      throw new Error();
    const result = await source
      .rotate()
      .resize(portraitWidth, portraitHeight, { fit: "cover" })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 85 })
      .toBuffer();
    if (result.length > 512 * 1024) throw new Error();
    return result;
  } catch {
    throw new AppError(
      400,
      "请使用有效的静态 PNG、JPEG 或 WebP 图片（不超过 1600 万像素）",
    );
  }
}
export async function validateStoredPortrait(data: Buffer) {
  try {
    const source = sharp(data, {
      limitInputPixels: portraitWidth * portraitHeight,
      failOn: "warning",
    });
    const meta = await source.metadata();
    if (
      data.length > 512 * 1024 ||
      meta.format !== "jpeg" ||
      !(
        (meta.width === portraitWidth && meta.height === portraitHeight) ||
        (meta.width === 512 && meta.height === 512)
      ) ||
      meta.exif ||
      meta.xmp ||
      meta.icc ||
      (meta.pages ?? 1) !== 1
    )
      throw new Error();
    await source.raw().toBuffer();
  } catch {
    throw new AppError(
      400,
      "头像附件不是有效的 768×1024 JPEG（兼容旧版 512×512）",
    );
  }
}
export function registerPortraits(
  app: FastifyInstance,
  store: Store,
  images?: PortraitStore,
) {
  app.post(
    "/api/portraits",
    { bodyLimit: 1024 * 1024 },
    async (request, reply) => {
      const storage = requirePortraits(images);
      const { data } = z
        .object({ data: z.string().max(700000) })
        .strict()
        .parse(request.body);
      const jpeg = await normalizePortrait(decodeImage(data));
      const imageId = imageHash(jpeg);
      await storage.put(imageId, jpeg);
      return reply.code(201).send({ imageId });
    },
  );
  app.get("/api/portraits/:id", async (request) => {
    const { id } = z.object({ id: imageIdSchema }).parse(request.params);
    const data = await requirePortraits(images).get(id);
    if (!data) throw new AppError(404, "头像图片不存在");
    if (imageHash(data) !== id) throw new AppError(503, "头像图片校验失败");
    return { data: data.toString("base64") };
  });
  app.put("/api/library/:id/portrait", async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const body = z
      .object({
        revision: z.string().min(1),
        portrait: portraitSchema.nullable(),
      })
      .strict()
      .parse(request.body);
    const old = await store.get(id, null);
    if (!old || old.deleted || old.kind !== "character")
      throw new AppError(404, "角色不存在");
    if (old.revision !== body.revision)
      throw new AppError(409, "角色版本已变化，请保留头像草稿并读取最新版本");
    if (
      body.portrait?.imageId &&
      body.portrait.imageId !== old.portrait?.imageId
    ) {
      const data = await requirePortraits(images).get(body.portrait.imageId);
      if (!data || imageHash(data) !== body.portrait.imageId)
        throw new AppError(400, "头像图片不存在或校验失败，请重新上传");
    }
    const next = clean(old);
    if (body.portrait) next.portrait = body.portrait;
    else delete next.portrait;
    return store.commit(
      {
        ...next,
        currentVersion: old.currentVersion + 1,
        updatedAt: new Date().toISOString(),
      },
      body.revision,
    );
  });
}
