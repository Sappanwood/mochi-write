import { z } from "zod";
import { freeId, exactRefSchema } from "./free.js";
import type { Document, Entity } from "./model.js";
export const materialMemberSchema = z
  .object({
    key: freeId,
    kind: z.enum(["snapshot", "setting", "outline"]),
    mode: z.enum(["create", "update"]),
    asset_id: z.uuid(),
    base_revision: freeId.nullable(),
    base_version: z.number().int().nonnegative(),
  })
  .strict();
export const materialSpecSchema = materialMemberSchema.extend({
  source_ref: exactRefSchema.optional(),
});
export type MaterialSpec = z.infer<typeof materialSpecSchema>;
export type MaterialMember = z.infer<typeof materialMemberSchema>;
export const materialMembers = (specs: MaterialSpec[]) =>
  specs.map(({ source_ref: _source, ...member }) => {
    void _source;
    return member;
  });
export interface MaterialPackage {
  story: Document;
  members: {
    spec: MaterialSpec;
    entity: Entity;
    baseRevision: string | null;
  }[];
}
