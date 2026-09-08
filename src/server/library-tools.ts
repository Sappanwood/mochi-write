import { z } from "zod";
import { createHash } from "node:crypto";
import { AppError, type Content, type LibraryEntry } from "../shared/model.js";
import {
  ToolError,
  readAssetSchema,
  type AssetSource,
} from "../shared/creative-tools.js";
import { Library } from "./library.js";
import type { Store } from "./store.js";
import type { AssetContext } from "./asset-tools.js";
const text = z.string().min(1).max(128);
const searchSchema = z
  .object({
    kind: z.enum(["character", "world"]),
    name: text.optional(),
    genre: z.string().min(1).max(40).optional(),
    age_band: z.string().min(1).max(40).optional(),
    gender: text.optional(),
    occupation: text.optional(),
    trait: text.optional(),
    era: text.optional(),
    tag: text.optional(),
    limit: z.number().int().min(1).max(20).default(10),
    cursor: z
      .string()
      .min(1)
      .refine((s) => Buffer.byteLength(s) <= 4096)
      .optional(),
  })
  .strict();
export function libraryContentHash(content: Content) {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return (
    "sha256:" +
    createHash("sha256")
      .update(JSON.stringify(canonical(content)))
      .digest("hex")
  );
}
function parse<T>(schema: z.ZodType<T>, args: unknown) {
  const result = schema.safeParse(args);
  if (!result.success) throw new ToolError("invalid_arguments");
  return result.data;
}
function metadata(row: LibraryEntry): LibraryEntry {
  const { asset_id, kind, name, revision, version, genres, age_band } = row;
  return {
    asset_id,
    kind,
    name,
    revision,
    version,
    genres,
    age_band,
    ...Object.fromEntries(
      ["gender", "occupation", "era"]
        .filter((k) => typeof row[k as keyof LibraryEntry] === "string")
        .map((k) => [k, row[k as keyof LibraryEntry]]),
    ),
    ...Object.fromEntries(
      ["traits", "tags"]
        .filter((k) => Array.isArray(row[k as keyof LibraryEntry]))
        .map((k) => [
          k,
          row[k as "traits" | "tags"]!.filter((v) => typeof v === "string"),
        ]),
    ),
  };
}
export class LibraryTools {
  constructor(private readonly store: Store) {}
  async vocabulary(args: unknown = {}) {
    parse(z.object({}).strict(), args);
    return {
      ...(await new Library(this.store).vocabulary()),
      dimensions: {
        name: "case-insensitive substring",
        gender: "exact",
        occupation: "case-insensitive substring",
        trait: "array element substring",
        era: "case-insensitive substring",
        tag: "exact array member",
      },
    };
  }
  async search(input: unknown) {
    const { cursor, age_band, ...args } = parse(searchSchema, input),
      vocabulary = await this.vocabulary();
    if (
      (args.genre && !vocabulary.genres.includes(args.genre)) ||
      (age_band && !vocabulary.ageBands.includes(age_band))
    )
      throw new ToolError("invalid_arguments");
    const binding = JSON.stringify({ scope: "library", ...args, age_band });
    let continuation: string | undefined;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (decoded.binding !== binding || typeof decoded.cursor !== "string")
          throw Error();
        continuation = decoded.cursor;
      } catch {
        throw new ToolError("invalid_cursor");
      }
    }
    let page;
    try {
      page = await this.store.searchLibrary({
        ...args,
        ageBand: age_band,
        cursor: continuation,
      });
    } catch (e) {
      if (e instanceof AppError && e.statusCode === 400)
        throw new ToolError("invalid_cursor");
      throw e;
    }
    const next_cursor = page.cursor
      ? Buffer.from(JSON.stringify({ binding, cursor: page.cursor })).toString(
          "base64url",
        )
      : null;
    const result = { items: page.items.map(metadata), next_cursor };
    if (
      (next_cursor && Buffer.byteLength(next_cursor) > 4096) ||
      Buffer.byteLength(JSON.stringify(result)) > 63 * 1024
    )
      throw new ToolError("result_too_large");
    return result;
  }
  async read(context: AssetContext, input: unknown) {
    const args = parse(readAssetSchema, input);
    const prior = ((await context.librarySources?.()) ?? []).find(
      (s) =>
        s.scope === "library" &&
        s.asset_id === args.asset_id &&
        s.revision === args.revision,
    );
    const doc = prior
      ? await this.store.getVersion(args.asset_id, null, prior.version!)
      : await this.store.get(args.asset_id, null);
    if (!doc || doc.deleted) throw new ToolError("not_found");
    if (doc.projectId !== null || !["character", "world"].includes(doc.kind))
      throw new ToolError("forbidden_scope");
    if (!prior && (!("revision" in doc) || doc.revision !== args.revision))
      throw new ToolError("revision_conflict");
    const content_hash = libraryContentHash(doc.content);
    if (
      prior &&
      (prior.version !== doc.currentVersion ||
        prior.content_hash !== content_hash)
    )
      throw new ToolError("revision_conflict");
    const source: AssetSource = {
      asset_id: doc.id,
      kind: doc.kind as "character" | "world",
      title: doc.content.name,
      revision: args.revision,
      version: doc.currentVersion,
      content_hash,
      scope: "library",
    };
    const result = { ...source, content: doc.content };
    if (Buffer.byteLength(JSON.stringify(result)) > 60 * 1024)
      throw new ToolError("result_too_large");
    await context.recordSource(source);
    return result;
  }
}
