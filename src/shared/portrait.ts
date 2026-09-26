import { z } from "zod";

export const portraitWidth = 768;
export const portraitHeight = 1024;
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
头像默认 3:4 竖幅构图、半身或头肩肖像，面部清晰，留出适当环境空间，避免证件照式正面站姿和僵硬摆拍；避免文字和水印。
本次画面加入生活、学习或工作氛围背景：根据角色已有的时代、身份、性格和世界观，选择一个合适的场景，并提供另外两类场景的可选替换句。例如生活中的窗边小憩或街巷漫步、学习时的书桌阅读或图书馆、工作中的案头整理或工坊操作；场景与道具须符合设定，不把现代校园或办公室强加给不适用的角色。
用自然动作、放松表情和符合场景的光线营造日常感；背景适度虚化、简洁但有环境细节，不遮挡面部、不喧宾夺主。场景、动作和道具如无资料依据，明确标为画面建议，不当作角色事实。
先给基于已知设定的版本，缺失外貌项不要擅自确定。`;
