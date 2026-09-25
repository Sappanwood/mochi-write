import { z } from "zod";

export const imageIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const portraitSchema = z
  .object({
    imageId: imageIdSchema.optional(),
    prompt: z.string().max(8000),
  })
  .strict();
export type Portrait = z.infer<typeof portraitSchema>;
export const portraitFilePattern = /^portraits\/[a-f0-9]{64}\.json$/;
export const portraitRequest = `请根据初始引用的角色资料，整理可复制到外部生图工具的头像提示词，不生成图片，不修改或保存角色资料。
默认画风：2.5D 风格化人物插画，风格化五官、柔和体积光影、适度立体感，避免真人摄影质感。画风可按我的后续要求调整。
先列出资料明确写出的视觉锚点：发型、发色、脸型、眼型与瞳色、年龄感、标志性配饰。将缺失外貌的建议补充单独列出，明确等待我选择，不能冒充已有设定。
将提示词分为统一画风、固定视觉锚点、本次画面三部分。服饰风格可稳定沿用，具体服装、表情、姿势、背景和光照可随场景变化。
头像默认干净背景、头肩肖像、面部清晰、适合正方形裁剪；避免文字和水印。先给基于已知设定的版本，缺失项不要擅自确定。`;
