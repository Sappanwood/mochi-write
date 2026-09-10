import { LIFECYCLE_TOOLS } from "./creative-tools.js";
const id = { type: "string", minLength: 1, maxLength: 128 };
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const ref = object(
  {
    type: { type: "string", enum: ["asset", "candidate"] },
    kind: {
      type: "string",
      enum: [
        "character",
        "world",
        "story",
        "setting",
        "outline",
        "snapshot",
        "chapter",
      ],
    },
    asset_id: id,
    story_id: id,
    revision: id,
    version: { type: "integer", minimum: 1 },
    content_hash: id,
    group_id: id,
    draft_id: id,
    draft_revision: id,
    draft_hash: id,
    member_id: id,
  },
  ["type"],
);
const group = { group_id: id, parent_ref: ref, derived_from: ref };
const commit = object(
  {
    mode: { type: "string", enum: ["commit"] },
    draft_id: id,
    draft_revision: id,
    draft_hash: id,
  },
  ["mode", "draft_id", "draft_revision", "draft_hash"],
);
function old(name: string) {
  return structuredClone(LIFECYCLE_TOOLS.find((t) => t.name === name)!);
}
function storyRead(name: string) {
  const t = old(name);
  return {
    ...t,
    version: "2",
    parameters: {
      ...t.parameters,
      properties: {
        ...(t.parameters as { properties: Record<string, unknown> }).properties,
        story_id: id,
      },
      required: [
        ...(t.parameters as { required: string[] }).required,
        "story_id",
      ],
    },
  };
}
function writing(name: string) {
  const t = old(name);
  const branches = (
    t.parameters as {
      oneOf: { properties: Record<string, unknown>; required: string[] }[];
    }
  ).oneOf;
  const draft = structuredClone(branches[0]!);
  draft.properties = { ...draft.properties, ...group };
  if (name === "initialize_story") {
    const assets = draft.properties.assets as {
      items: { properties: Record<string, unknown> };
    };
    assets.items.properties.candidate_ref = ref;
  }
  return {
    ...t,
    version: "2",
    description:
      "Create immutable candidates within this task's trusted draftContext. Commit requires the exact server binding and candidate reference; material and initial context never authorize writes.",
    parameters: { oneOf: [draft, commit] },
  };
}
export const FREE_TOOLS = [
  old("library_vocabulary"),
  old("search_library"),
  old("read_library"),
  storyRead("search_assets"),
  storyRead("read_asset"),
  {
    name: "discover_artifacts",
    version: "2",
    effect: "read",
    description: "Discover immutable candidates in this conversation.",
    parameters: object(
      {
        query: { type: "string", maxLength: 128 },
        kind: {
          type: "string",
          enum: ["character", "story_initialization", "chapter"],
        },
        limit: { type: "integer", minimum: 1, maximum: 20 },
        cursor: { type: "string", maxLength: 4096 },
      },
      ["query"],
    ),
  },
  {
    name: "read_artifact",
    version: "2",
    effect: "read",
    description: "Read the exact candidate or initialization member.",
    parameters: object(
      { draft_id: id, draft_revision: id, draft_hash: id, member_id: id },
      ["draft_id", "draft_revision", "draft_hash"],
    ),
  },
  {
    name: "save_character",
    version: "2",
    effect: "write",
    description:
      "Draft a full character candidate. Commit the exact candidate only with trusted task authorization. Never infer update from name or source. Story extraction must supply derivation source_ref and retained/rewritten/excluded explanations, with a complete independent rewritten body; create a new master only.",
    parameters: {
      oneOf: [
        object(
          {
            mode: { type: "string", enum: ["draft"] },
            name: { type: "string", minLength: 1, maxLength: 200 },
            markdown: { type: "string", minLength: 1, maxLength: 49152 },
            genres: {
              type: "array",
              items: { type: "string", maxLength: 40 },
              maxItems: 30,
            },
            age_band: { type: "string", maxLength: 40 },
            gender: { type: "string", maxLength: 128 },
            occupation: { type: "string", maxLength: 128 },
            era: { type: "string", maxLength: 128 },
            traits: { type: "array", items: id, maxItems: 16 },
            tags: { type: "array", items: id, maxItems: 16 },
            ...group,
            derivation: object(
              {
                source_ref: ref,
                retained: {
                  type: "array",
                  items: { type: "string", maxLength: 256 },
                  maxItems: 16,
                },
                rewritten: {
                  type: "array",
                  items: { type: "string", maxLength: 256 },
                  maxItems: 16,
                },
                excluded: {
                  type: "array",
                  items: { type: "string", maxLength: 256 },
                  maxItems: 16,
                },
              },
              ["source_ref", "retained", "rewritten", "excluded"],
            ),
          },
          ["mode", "name", "markdown", "genres", "age_band"],
        ),
        commit,
      ],
    },
  },
  writing("initialize_story"),
  writing("create_chapter"),
];
