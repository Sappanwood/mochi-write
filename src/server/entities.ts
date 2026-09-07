import { createHash, randomUUID } from "node:crypto";
import {
  AppError,
  entitySchema,
  type Entity,
  type Document,
  type Content,
} from "../shared/model.js";
export function hash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
export function stableId(key: string) {
  const h = hash(key);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function entity(
  kind: Entity["kind"],
  content: Content,
  projectId: string | null = null,
  id: string = randomUUID(),
): Entity {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id,
    kind,
    projectId,
    ...(projectId === null ? { scopeId: "library" as const } : {}),
    createdAt: now,
    updatedAt: now,
    currentVersion: 1,
    content,
  };
}
export function clean(doc: Entity | Document): Entity {
  const value = { ...doc } as Record<string, unknown>;
  for (const key of [
    "revision",
    "_etag",
    "_rid",
    "_self",
    "_attachments",
    "_ts",
  ])
    delete value[key];
  const parsed = entitySchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(parsed)) > 768 * 1024)
    throw new AppError(400, "对象超过 768 KiB，无法安全保存完整版本事务");
  return parsed;
}
