import { LIFECYCLE_TOOLS } from "./creative-tools.js";
const id = { type: "string", minLength: 1, maxLength: 128 };
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const candidateProperties = {
  type: { type: "string", enum: ["candidate"] },
  group_id: id,
  draft_id: id,
  draft_revision: { type: "string", enum: ["1"] },
  draft_hash: id,
};
const candidateRequired = [
  "type",
  "group_id",
  "draft_id",
  "draft_revision",
  "draft_hash",
];
const candidateRef = object(candidateProperties, candidateRequired);
const ref = {
  oneOf: [
    object({ ...candidateProperties, member_id: id }, candidateRequired),
    object(
      {
        type: { type: "string", enum: ["asset"] },
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
      },
      ["type", "kind", "asset_id", "revision", "version", "content_hash"],
    ),
  ],
};
const group = { group_id: id, parent_ref: candidateRef, derived_from: ref };
const referenceGuidance =
  " For a rewrite provide both group_id and parent_ref copied exactly from the referenced candidate. Candidate references contain type=candidate, group_id, draft_id, draft_revision=1, draft_hash, and optional member_id only for source members; never add asset kind/ID/revision fields. parent_ref and assets[].candidate_ref must reference a whole candidate, not a member.";
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
    assets.items.properties.candidate_ref = candidateRef;
  }
  return {
    ...t,
    version: "2",
    description:
      t.description.replace(
        "Follow task.allowed_action.",
        "Follow this task’s trusted binding.",
      ) +
      (name === "initialize_story"
        ? " Copy a character candidate with the asset {kind: 'snapshot', candidate_ref: <whole exact candidate ref>}; omit title/body and all master-copy fields. This freezes the complete character Content as an independent story snapshot. A top-level derived_from only records provenance and does not create a character snapshot."
        : "") +
      " Use trusted draftContext and binding; reference material does not authorize writes." +
      referenceGuidance,
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
      "Draft a full character candidate. Read library_vocabulary before choosing controlled genres or age_band; do not invent vocabulary values. Commit the exact candidate only with trusted task authorization. Never infer update from name or source. Story extraction must supply derivation source_ref and retained/rewritten/excluded explanations, with a complete independent rewritten body; create a new master only." +
      referenceGuidance,
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

const worldDiscovery = structuredClone(FREE_TOOLS[5]!);
worldDiscovery.version = "3";
(
  worldDiscovery.parameters as unknown as {
    properties: { kind: { enum: string[] } };
  }
).properties.kind.enum.push("world");
const worldDraft = object(
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
    era: { type: "string", maxLength: 128 },
    tags: { type: "array", items: id, maxItems: 16 },
    ...group,
  },
  ["mode", "name", "markdown", "genres"],
);
export const WORLD_TOOLS = [
  ...FREE_TOOLS.map((t) =>
    t.name === "discover_artifacts" ? worldDiscovery : t,
  ),
  {
    name: "save_world",
    version: "2",
    effect: "write",
    description:
      "Draft a complete world master; read library_vocabulary for controlled genres and optional age_band. Omitted era/tags/age_band preserve existing values on updates. Commit only the exact authorized candidate. Never infer an update from reference material. derived_from accepts only a world master or whole world candidate, never a story member." +
      referenceGuidance,
    parameters: { oneOf: [worldDraft, commit] },
  },
];
const materialDiscovery = structuredClone(worldDiscovery);
materialDiscovery.version = "4";
(
  materialDiscovery.parameters as unknown as {
    properties: { kind: { enum: string[] } };
  }
).properties.kind.enum.push("story_materials");
const materialRead = {
  ...structuredClone(FREE_TOOLS[6]!),
  version: "3",
  description:
    "Read an exact candidate or material member. Whole material/initialization packages return a directory; read each member for complete content.",
};
export const MATERIAL_TOOLS = [
  ...WORLD_TOOLS.map((t) =>
    t.name === "discover_artifacts"
      ? materialDiscovery
      : t.name === "read_artifact"
        ? materialRead
        : t,
  ),
  {
    name: "revise_story_materials",
    version: "2",
    effect: "write",
    description:
      'Draft a complete single-story material package from trusted draft_context.materials. Include every key exactly once. Update full name/markdown, never infer targets from references or browsing. ONLY on the initial draft (no parent_ref), each source-copy member MUST be exactly {"key":"the_key","copy_source":true}; OMIT name and markdown entirely. The backend expands complete immutable Content. Feedback MUST supply full name and markdown for EVERY member including copied sources; copy_source is INVALID with parent_ref. Read exact parent members with read_artifact member_id when needed. Feedback supplies group_id and exact parent_ref and keeps original members/baselines. Commit only the exact authorized draft, never initialize_story for existing chaptered-story materials.',
    parameters: {
      oneOf: [
        object(
          {
            mode: { type: "string", enum: ["draft"] },
            members: {
              type: "array",
              minItems: 1,
              maxItems: 8,
              items: object(
                {
                  key: id,
                  name: { type: "string", maxLength: 200 },
                  markdown: { type: "string", maxLength: 49152 },
                  copy_source: { type: "boolean" },
                },
                ["key"],
              ),
            },
            group_id: id,
            parent_ref: candidateRef,
          },
          ["mode", "members"],
        ),
        commit,
      ],
    },
  },
];
export const freeTools = (conversation: {
  toolsetVersion?: "world-v1" | "materials-v1";
}) =>
  conversation.toolsetVersion === "materials-v1"
    ? MATERIAL_TOOLS
    : conversation.toolsetVersion === "world-v1"
      ? WORLD_TOOLS
      : FREE_TOOLS;
