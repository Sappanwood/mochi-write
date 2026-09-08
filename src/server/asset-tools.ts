import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import {
  assetKindSchema,
  readAssetSchema,
  searchAssetsSchema,
  ToolError,
  TOOL_RESPONSE_BYTES,
  type AssetRead,
  type AssetSource,
} from "../shared/creative-tools.js";
import type { Document } from "../shared/model.js";
import type { Store } from "./store.js";

export interface AssetContext {
  storyId: string;
  librarySources?: () => Promise<AssetSource[]>;
  recordSource: (source: AssetSource) => Promise<void>;
  readDraft?: (id: string, revision: string) => Promise<AssetRead | undefined>;
}
const cursorSchema = z
  .object({
    story: z.string(),
    query: z.string(),
    kind: assetKindSchema.optional(),
    limit: z.number().int(),
    revision: z.string(),
    offset: z.number().int().positive(),
  })
  .strict();
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ToolError("invalid_arguments");
  return result.data;
}
function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function summary(content: string, query: string) {
  const index = query ? content.toLowerCase().indexOf(query.toLowerCase()) : 0;
  return [...content.slice(Math.max(0, index - 100))].slice(0, 512).join("");
}
export class AssetTools {
  private readonly cursorKey = randomBytes(32);
  constructor(private readonly store: Store) {}
  private encode(value: z.infer<typeof cursorSchema>) {
    const body = Buffer.from(JSON.stringify(value)).toString("base64url");
    return `${body}.${createHmac("sha256", this.cursorKey).update(body).digest("base64url")}`;
  }
  private decode(token: string) {
    try {
      const parts = token.split(".");
      if (parts.length !== 2) throw new Error();
      const [body, signature] = parts as [string, string];
      const expected = createHmac("sha256", this.cursorKey)
        .update(body)
        .digest();
      const actual = Buffer.from(signature, "base64url");
      if (
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual)
      )
        throw new Error();
      return cursorSchema.parse(
        JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
      );
    } catch {
      throw new ToolError("invalid_cursor");
    }
  }
  private async scan(storyId: string) {
    const docs: Document[] = [];
    let cursor: string | undefined;
    let bytes = 0;
    let pages = 0;
    do {
      if (++pages > 50) throw new ToolError("result_too_large");
      const page = await this.store.list({
        projectId: storyId,
        limit: 40,
        cursor,
      });
      for (const doc of page.items) {
        if (doc.projectId !== storyId) throw new ToolError("forbidden_scope");
        if (!assetKindSchema.safeParse(doc.kind).success || doc.deleted)
          continue;
        bytes +=
          Buffer.byteLength(doc.content.markdown) +
          Buffer.byteLength(doc.content.name);
        docs.push(doc);
        if (docs.length > 1000 || bytes > 8 * 1024 * 1024)
          throw new ToolError("result_too_large");
      }
      cursor = page.cursor;
    } while (cursor);
    return docs.sort((a, b) =>
      a.kind < b.kind
        ? -1
        : a.kind > b.kind
          ? 1
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0,
    );
  }
  async search(context: AssetContext, input: unknown) {
    const args = parse(searchAssetsSchema, input);
    const previous = args.cursor ? this.decode(args.cursor) : undefined;
    if (
      previous &&
      (previous.story !== context.storyId ||
        previous.query !== args.query ||
        previous.kind !== args.kind ||
        previous.limit !== args.limit)
    )
      throw new ToolError("invalid_cursor");
    const all = await this.scan(context.storyId);
    const revision = digest(all.map((doc) => [doc.id, doc.kind, doc.revision]));
    if (previous && previous.revision !== revision)
      throw new ToolError("revision_conflict");
    const query = args.query.toLowerCase();
    const matches = all.filter(
      (doc) =>
        (!args.kind || doc.kind === args.kind) &&
        (!query ||
          doc.content.name.toLowerCase().includes(query) ||
          doc.content.markdown.toLowerCase().includes(query)),
    );
    const offset = previous?.offset ?? 0;
    if (previous && offset >= matches.length)
      throw new ToolError("invalid_cursor");
    const items = matches.slice(offset, offset + args.limit).map((doc) => ({
      asset_id: doc.id,
      kind: assetKindSchema.parse(doc.kind),
      title: doc.content.name,
      summary: summary(doc.content.markdown, args.query),
      revision: doc.revision,
    }));
    return {
      items,
      next_cursor:
        offset + args.limit < matches.length
          ? this.encode({
              story: context.storyId,
              query: args.query,
              kind: args.kind,
              limit: args.limit,
              revision,
              offset: offset + args.limit,
            })
          : null,
    };
  }
  async read(context: AssetContext, input: unknown): Promise<AssetRead> {
    const args = parse(readAssetSchema, input);
    const doc = await this.store.get(args.asset_id, context.storyId);
    let result: AssetRead;
    if (!doc) {
      const draft = await context.readDraft?.(args.asset_id, args.revision);
      if (draft) result = draft;
      else {
        const scopes = await this.store.assetScopes(args.asset_id);
        if (scopes.some((scope) => scope !== context.storyId))
          throw new ToolError("forbidden_scope");
        throw new ToolError("not_found");
      }
    } else {
      if (
        doc.projectId !== context.storyId ||
        !assetKindSchema.safeParse(doc.kind).success
      )
        throw new ToolError("forbidden_scope");
      if (doc.deleted) throw new ToolError("not_found");
      if (doc.revision !== args.revision)
        throw new ToolError("revision_conflict");
      result = {
        asset_id: doc.id,
        kind: assetKindSchema.parse(doc.kind),
        title: doc.content.name,
        revision: doc.revision,
        content: doc.content.markdown,
      };
    }
    // Leave room for the callback envelope and the maximum invocation identifier.
    if (Buffer.byteLength(JSON.stringify(result)) > TOOL_RESPONSE_BYTES - 1024)
      throw new ToolError("result_too_large");
    await context.recordSource({
      asset_id: result.asset_id,
      kind: result.kind,
      title: result.title,
      revision: result.revision,
    });
    return result;
  }
}
