import { z } from "zod";
import { randomUUID } from "node:crypto";
import type {
  Action,
  DraftContext,
  FreeConversation,
  FreeTask,
  ResolutionEvidence,
  Target,
} from "../shared/free.js";
import type { Document, LibraryEntry } from "../shared/model.js";
import type { Store } from "./store.js";
import { LibraryTools } from "./library-tools.js";
import { freeDigest, type FreeReferences } from "./free-references.js";
const evidence = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    text: z.string().min(1),
  })
  .strict();
const predicate = z
  .object({
    field: z.enum([
      "name",
      "occupation",
      "gender",
      "age_band",
      "genre",
      "trait",
      "era",
      "tag",
    ]),
    operator: z.enum(["eq", "contains"]),
    value: z.string().min(1).max(128),
    evidence,
  })
  .strict();
export const classifierSchema = z
  .object({
    intent: z.enum([
      "discuss",
      "draft",
      "save_current",
      "create_character",
      "update_character",
      "initialize_story",
      "create_chapter",
      "revoke",
      "unclear",
    ]),
    evidence,
    target: z
      .object({
        mode: z.enum(["new", "explicit", "search", "unclear"]),
        kind: z.enum(["character", "world", "story"]),
        predicates: z.array(predicate).max(8),
      })
      .strict(),
    changeEvidence: evidence.optional(),
  })
  .strict();
type Classification = z.infer<typeof classifierSchema>;
function matches(
  row: LibraryEntry,
  predicates: Classification["target"]["predicates"],
) {
  return predicates.every((p) => {
    const values =
      p.field === "genre"
        ? row.genres
        : p.field === "trait"
          ? row.traits
          : p.field === "tag"
            ? row.tags
            : row[p.field as keyof LibraryEntry];
    const match = (v: unknown) =>
      typeof v === "string" &&
      (p.operator === "eq"
        ? v === p.value
        : v.toLowerCase().includes(p.value.toLowerCase()));
    return Array.isArray(values) ? values.some(match) : match(values);
  });
}
function summary(d: Document): LibraryEntry {
  return {
    ...d.content.sourceMetadata,
    asset_id: d.id,
    kind: d.kind as "character",
    name: d.content.name,
    revision: d.revision,
    version: d.currentVersion,
    genres: d.content.genres,
    age_band: d.content.ageBand,
  };
}
export interface TargetResolution {
  evidence: ResolutionEvidence;
  target?: Target;
  baseRevision?: string | null;
  action?: Action;
  draftContext?: DraftContext;
  clarify?: string;
}
export async function resolveTarget(
  content: Store,
  references: FreeReferences,
  conversation: FreeConversation,
  task: FreeTask,
  raw: unknown,
  classifierRunId: string,
): Promise<TargetResolution> {
  const parsed = classifierSchema.safeParse(raw);
  const empty: ResolutionEvidence = {
    originalMessageHash: freeDigest(task.input.message),
    classifierResult: raw,
    classifierRunId,
    predicates: [],
    queryDigest: freeDigest([]),
    candidateIds: [],
    candidateRevisions: [],
    complete: false,
    policyVersion: "target-v2",
    verifiedAt: new Date().toISOString(),
  };
  const reject = (reason: string): TargetResolution => ({
    evidence: empty,
    clarify: reason,
  });
  if (!parsed.success) return reject("intent_unavailable");
  const c = parsed.data;
  empty.predicates = c.target.predicates;
  const evs = [
    c.evidence,
    ...c.target.predicates.map((p) => p.evidence),
    ...(c.changeEvidence ? [c.changeEvidence] : []),
  ];
  if (
    evs.some(
      (e) =>
        task.input.message.slice(e.start, e.end) !== e.text ||
        e.end > task.input.message.length,
    )
  )
    return reject("invalid_intent_evidence");
  const saving = [
    "save_current",
    "create_character",
    "update_character",
    "initialize_story",
    "create_chapter",
  ].includes(c.intent);
  if (
    saving &&
    /(?:不要|不许|别|不想|无需|不必).{0,12}(?:保存|更新|建立)|[“「『"].*(?:保存|更新).*[”」』"]|(?:分别|各自|两个|两份|多章|批量).*(?:保存|更新)/u.test(
      task.input.message,
    )
  )
    return reject("conflicting_intent");
  if (c.intent === "unclear" || c.intent === "revoke") return reject(c.intent);
  if (c.intent === "discuss") return { evidence: { ...empty, complete: true } };
  if (
    c.intent === "update_character" &&
    (!c.changeEvidence ||
      c.target.kind !== "character" ||
      c.target.mode === "new")
  )
    return reject("invalid_update_intent");
  if (c.target.kind === "world" && saving)
    return reject("unsupported_write_scope");
  if (
    (c.intent === "create_character" &&
      (c.target.kind !== "character" || c.target.mode !== "new")) ||
    (["initialize_story", "create_chapter"].includes(c.intent) &&
      c.target.kind !== "story")
  )
    return reject("invalid_action_kind");
  if (
    c.intent === "save_current" ||
    (c.intent === "draft" &&
      task.input.refs.some((r) => r.type === "candidate"))
  ) {
    const refs = task.input.refs.filter((r) => r.type === "candidate");
    if (refs.length !== 1 || !references.candidates)
      return reject("select_exact_candidate");
    const candidate = await references.candidates.read(
      conversation.id,
      refs[0]!,
    );
    const context = candidate.draftContext;
    const target = context.target ?? {
      kind: "character" as const,
      asset_id: randomUUID(),
    };
    if (
      c.target.kind !== target.kind ||
      c.target.mode === "search" ||
      (c.target.mode === "new" && context.baseRevision !== null)
    )
      return reject("candidate_target_conflict");
    const terms = await new LibraryTools(content).vocabulary();
    if (
      c.target.predicates.some(
        (p) =>
          !p.evidence.text.includes(p.value) ||
          (p.field === "genre" && !terms.genres.includes(p.value)) ||
          (p.field === "age_band" && !terms.ageBands.includes(p.value)) ||
          (["gender", "age_band", "genre", "tag"].includes(p.field) &&
            p.operator !== "eq"),
      ) ||
      !matches(
        {
          ...candidate.content.sourceMetadata,
          asset_id:
            target.kind === "character" ? target.asset_id : target.story_id,
          kind: "character",
          name: candidate.content.name,
          revision: refs[0]!.draft_revision,
          version: 1,
          genres: candidate.content.genres,
          age_band: candidate.content.ageBand,
        },
        c.target.predicates,
      )
    )
      return reject("candidate_target_conflict");
    if (saving && context.target) {
      const head = await content.get(
        target.kind === "character" ? target.asset_id : target.story_id,
        target.kind === "character" ? null : target.story_id,
      );
      if ((head?.revision ?? null) !== context.baseRevision || head?.deleted)
        return reject("revision_conflict");
    }
    empty.complete = true;
    return {
      evidence: empty,
      ...(saving
        ? {
            target,
            baseRevision: context.baseRevision,
            action: candidate.action,
          }
        : {}),
      draftContext: {
        ...context,
        ...(context.target || saving ? { target } : {}),
        reference: refs[0],
      },
    };
  }
  if (c.target.mode === "new") {
    if (c.target.kind === "world" || c.intent === "create_chapter")
      return reject("target_required");
    const target: Target =
      c.target.kind === "character"
        ? { kind: "character", asset_id: randomUUID() }
        : { kind: "story", story_id: randomUUID() };
    empty.complete = true;
    return {
      evidence: empty,
      ...(saving
        ? { target, baseRevision: null, action: c.intent as Action }
        : {}),
      draftContext: {
        mode: target.kind === "character" ? "new_character" : "new_story",
        ...(target.kind === "story" || saving ? { target } : {}),
        baseRevision: null,
      },
    };
  }
  if (c.target.mode === "unclear") return reject("target_required");
  const vocabulary = await new LibraryTools(content).vocabulary();
  if (
    c.target.predicates.some(
      (p) =>
        !p.evidence.text.includes(p.value) ||
        (p.field === "genre" && !vocabulary.genres.includes(p.value)) ||
        (p.field === "age_band" && !vocabulary.ageBands.includes(p.value)) ||
        (["gender", "age_band", "genre", "tag"].includes(p.field) &&
          p.operator !== "eq"),
    )
  )
    return reject("unsupported_predicates");
  const filters = Object.fromEntries(
    c.target.predicates.map((p) => [p.field, p.value]),
  );
  if (
    new Set(c.target.predicates.map((p) => p.field)).size !==
    c.target.predicates.length
  )
    return reject("unsupported_predicates");
  let candidates: LibraryEntry[] = [];
  let head: Document | undefined;
  if (c.target.mode === "explicit") {
    const refs = [
      ...new Map(
        [...task.input.refs, ...conversation.initialRefs]
          .filter((r) => r.type === "asset" && r.kind === c.target.kind)
          .map((r) => [r.type === "asset" ? r.asset_id : "", r]),
      ).values(),
    ];
    if (refs.length !== 1) return reject("ambiguous_explicit_target");
    const ref = refs[0]!;
    if (ref.type !== "asset") return reject("target_required");
    head = await content.get(ref.asset_id, ref.story_id ?? null);
    if (!head || head.deleted) return reject("revision_conflict");
    candidates = [summary(head)];
    empty.candidateIds = candidates.map((r) => r.asset_id);
    empty.candidateRevisions = candidates.map((r) => r.revision);
    empty.queryDigest = freeDigest({ kind: c.target.kind, filters });
    empty.complete = true;
    if (!matches(summary(head), c.target.predicates))
      return reject("explicit_predicate_mismatch");
  } else {
    if (!c.target.predicates.length || c.target.kind === "world")
      return reject("unsupported_predicates");
    empty.queryDigest = freeDigest({ kind: c.target.kind, filters });
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      if (c.target.kind === "story") {
        if (c.target.predicates.some((p) => p.field !== "name"))
          return reject("unsupported_predicates");
        const result = await content.list({
          kind: "story",
          name: filters.name,
          limit: 20,
          cursor,
        });
        candidates.push(...result.items.map(summary));
        cursor = result.cursor;
      } else {
        const result = await content.searchLibrary({
          kind: "character",
          ...filters,
          ageBand: filters.age_band,
          limit: 20,
          cursor,
        });
        candidates.push(...result.items);
        cursor = result.cursor;
      }
      if (
        candidates.length > 20 ||
        Buffer.byteLength(JSON.stringify(candidates)) > 60 * 1024
      )
        break;
      if (!cursor) {
        empty.complete = true;
        break;
      }
    }
    empty.candidateIds = candidates.map((r) => r.asset_id);
    empty.candidateRevisions = candidates.map((r) => r.revision);
    if (
      !empty.complete ||
      candidates.length > 20 ||
      candidates.some((r) => !matches(r, c.target.predicates))
    )
      return reject("incomplete_or_unverified_candidates");
    if (candidates.length !== 1) return reject("ambiguous_or_missing_target");
    const row = candidates[0]!;
    if (/之前|那个|先前|上次/.test(task.input.message)) {
      const history = [
        ...conversation.initialRefs,
        ...(await references.sources(conversation.id)).map((s) => s.ref),
      ];
      const known =
        history.some(
          (r) => r.type === "asset" && r.asset_id === row.asset_id,
        ) ||
        conversation.associatedAssets.some((t) =>
          t.kind === "character"
            ? t.asset_id === row.asset_id
            : t.story_id === row.asset_id,
        );
      if (!known) return reject("relative_target_without_history");
    }
    head = await content.get(
      row.asset_id,
      c.target.kind === "story" ? row.asset_id : null,
    );
    if (
      !head ||
      head.deleted ||
      head.kind !== c.target.kind ||
      head.revision !== row.revision ||
      !matches(summary(head), c.target.predicates)
    )
      return reject("revision_conflict");
  }
  if (!head || head.kind !== c.target.kind || head.deleted)
    return reject("target_unavailable");
  empty.candidateIds = candidates.map((r) => r.asset_id);
  empty.candidateRevisions = candidates.map((r) => r.revision);
  empty.matchedId = head.id;
  empty.headRevision = head.revision;
  const target: Target =
    head.kind === "character"
      ? { kind: "character", asset_id: head.id }
      : { kind: "story", story_id: head.id };
  let action: Action | undefined;
  if (saving) action = c.intent as Action;
  if (target.kind === "story") {
    const chapters = await content.list({
      kind: "chapter",
      projectId: target.story_id,
      limit: 1,
    });
    if (c.intent === "initialize_story" && chapters.items.length)
      return reject("story_already_has_chapters");
    if (
      c.intent === "create_chapter" &&
      (!chapters.items.length || head.initializationPending)
    )
      action = "save_first_chapter";
  }
  return {
    evidence: empty,
    ...(saving ? { target, baseRevision: head.revision, action } : {}),
    draftContext: {
      mode:
        target.kind === "character" ? "existing_character" : "existing_story",
      target,
      baseRevision: head.revision,
      ...(target.kind === "story" ? { chapterId: randomUUID() } : {}),
    },
  };
}
