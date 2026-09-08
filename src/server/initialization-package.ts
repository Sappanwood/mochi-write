import { z } from "zod";
import { hash } from "./entities.js";
import type { InitializationPackage } from "../shared/creative.js";
import { ToolError } from "../shared/creative-tools.js";
const title = z
  .string()
  .trim()
  .min(1)
  .refine(
    (s) =>
      s.trim().length > 0 &&
      [...s].length <= 200 &&
      Buffer.byteLength(s) <= 512,
  );
const body = (max: number) =>
  z.string().refine((s) => Buffer.byteLength(s) <= max);
const asset = z
  .object({
    kind: z.enum(["setting", "outline", "snapshot"]),
    title: title.optional(),
    body: body(8192).optional(),
    asset_id: z.uuid().optional(),
    base_revision: z.string().min(1).max(128).optional(),
    source_id: z.uuid().optional(),
    source_version: z.number().int().positive().optional(),
    source_hash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .superRefine((v, c) => {
    const source =
      v.source_id !== undefined ||
      v.source_version !== undefined ||
      v.source_hash !== undefined;
    const target = v.asset_id !== undefined || v.base_revision !== undefined;
    if (
      source
        ? v.kind !== "snapshot" ||
          !v.source_id ||
          !v.source_version ||
          !v.source_hash ||
          target ||
          v.title !== undefined ||
          v.body !== undefined
        : v.title === undefined ||
          v.body === undefined ||
          (target && (!v.asset_id || !v.base_revision))
    )
      c.addIssue({
        code: "custom",
        message:
          "Exactly one generated, updated, or read-source asset is required",
      });
  });
export const initializationArgs = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("draft"),
      title,
      body: body(8192).optional(),
      assets: z.array(asset).max(8),
      chapter: z
        .object({ title, body: body(49152).refine((s) => s.length > 0) })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("commit"),
      draft_id: z.uuid(),
      draft_revision: z.literal("1"),
      draft_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    })
    .strict(),
]);
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function packageHash(value: unknown) {
  return "sha256:" + hash(canonicalJson(value));
}
export function checkPackageSize(value: InitializationPackage) {
  if (Buffer.byteLength(canonicalJson(value)) > 256 * 1024)
    throw new ToolError("result_too_large");
}
export function initializationSummary(value: InitializationPackage) {
  return value.assets.map(({ entity, baseRevision }) => ({
    asset_id: entity.id,
    kind: entity.kind,
    title: entity.content.name,
    action: baseRevision === null ? "create" : "update",
    ...(entity.sourceAssetId
      ? {
          source_id: entity.sourceAssetId,
          source_version: entity.sourceVersion,
        }
      : {}),
  }));
}
