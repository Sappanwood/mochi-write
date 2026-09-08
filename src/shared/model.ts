import { z } from "zod";
export const genres = [
  "都市",
  "现代日常",
  "奇幻",
  "修仙",
  "科幻",
  "灵异怪谈",
  "悬疑",
  "历史",
];
export const ageBands = ["少年", "青年", "成年", "中年", "老年", "特殊"];
export const contentSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    markdown: z.string().max(262144),
    genres: z.array(z.string().min(1).max(40)).max(30).default([]),
    ageBand: z.string().max(40).default(""),
    sourceMetadata: z.record(z.string(), z.json()).default({}),
  })
  .strict();
export type Content = z.infer<typeof contentSchema>;
export const entitySchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    kind: z.enum([
      "character",
      "world",
      "vocabulary",
      "import",
      "story",
      "setting",
      "outline",
      "snapshot",
      "chapter",
    ]),
    projectId: z.uuid().nullable(),
    scopeId: z.literal("library").optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    currentVersion: z.number().int().positive(),
    content: contentSchema,
    order: z.number().int().positive().optional(),
    status: z.enum(["building", "ready"]).optional(),
    deleted: z.boolean().optional(),
    sourceAssetId: z.uuid().optional(),
    sourceVersion: z.number().int().positive().optional(),
    source: z
      .object({
        path: z.string(),
        hash: z.string(),
        raw: z.string(),
        base: z.string().optional(),
        delta: z.string().optional(),
      })
      .optional(),
  })
  .strict();
export type Entity = z.infer<typeof entitySchema>;
export type Document = Entity & { revision: string };
export interface LibraryFilter {
  kind: "character" | "world";
  name?: string;
  genre?: string;
  ageBand?: string;
  gender?: string;
  occupation?: string;
  trait?: string;
  era?: string;
  tag?: string;
  cursor?: string;
  limit?: number;
}
export interface LibraryEntry {
  asset_id: string;
  kind: "character" | "world";
  name: string;
  revision: string;
  version: number;
  genres: string[];
  age_band: string;
  gender?: string;
  occupation?: string;
  traits?: string[];
  era?: string;
  tags?: string[];
}
export interface Filter extends Omit<LibraryFilter, "kind"> {
  kind?: Entity["kind"];
  projectId?: string | null;
  name?: string;
  genre?: string;
  ageBand?: string;
  cursor?: string;
  limit?: number;
}
export interface Page {
  items: Document[];
  cursor?: string;
}
export interface BundleFile {
  path: string;
  text: string;
}
export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public diagnostics?: string[],
  ) {
    super(message);
  }
}
