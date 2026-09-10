import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { FreeSession } from "../src/server/free-session.js";
import { candidateTool } from "../src/server/free-candidate-tools.js";
import { MemoryStore } from "./support/memory-store.js";
import { MemoryFreeStore } from "./support/free-store.js";
async function fixture() {
  const free = new FreeSession(
    new MemoryStore(),
    new MemoryFreeStore(),
    {
      async request() {
        throw Error("No model");
      },
    },
    { autoStart: false },
  );
  const { task } = await free.start({
    clientRequestId: randomUUID(),
    message: "讨论角色",
    provider: "fake",
    model: "fake",
  });
  await free.change(task.id, (t) => {
    t.state = "authorized";
    t.draftContext = { mode: "new_character", baseRevision: null };
  });
  const current = await free.task(task.id);
  const content = {
    name: "甲",
    markdown: "正文",
    genres: [],
    ageBand: "",
    sourceMetadata: {},
  };
  const draft = await free.candidates.freeze(
    current,
    { artifactKind: "character", content },
    "draft",
  );
  return {
    free,
    task: current,
    draft,
    content,
    ref: free.candidates.ref(draft),
  };
}
it("rechecks the 20-source limit when another read commits after a stale 19-source query", async () => {
  const { free, task, ref } = await fixture();
  for (let i = 0; i < 19; i++)
    await free.references.recordRead(task, ref, "existing-" + i);
  const original = free.references.sources.bind(free.references);
  let interleave = true;
  free.references.sources = async (id) => {
    const snapshot = await original(id);
    if (interleave) {
      interleave = false;
      await free.references.recordRead(task, ref, "read-b");
    }
    return snapshot;
  };
  await expect(free.references.recordRead(task, ref, "read-a")).rejects.toThrow(
    "result_too_large",
  );
  const sources = await original(task.conversationId);
  expect(sources).toHaveLength(20);
  expect(sources.filter((s) => s.invocation_id === "read-b")).toHaveLength(1);
});
it("deduplicates the same invocation when another read commits after the source query", async () => {
  const { free, task, ref } = await fixture();
  const original = free.references.sources.bind(free.references);
  let interleave = true;
  free.references.sources = async (id) => {
    const snapshot = await original(id);
    if (interleave) {
      interleave = false;
      await free.references.recordRead(task, ref, "same-read");
    }
    return snapshot;
  };
  await free.references.recordRead(task, ref, "same-read");
  expect(await original(task.conversationId)).toHaveLength(1);
});
it("keeps discovered parent and derivation provenance without claiming Agent full-text reads", async () => {
  const { free, task, ref, draft, content } = await fixture();
  await candidateTool(
    free,
    task,
    "discover_artifacts",
    { query: "甲" },
    "discover",
  );
  const rewrite = await free.candidates.freeze(
    task,
    {
      artifactKind: "character",
      content,
      group_id: draft.groupId,
      parent_ref: ref,
    },
    "rewrite",
  );
  const derived = await free.candidates.freeze(
    task,
    { artifactKind: "character", content, derived_from: ref },
    "derived",
  );
  await candidateTool(
    free,
    task,
    "save_character",
    {
      mode: "draft",
      name: "派生",
      markdown: "重写正文",
      genres: [],
      age_band: "",
      derivation: {
        source_ref: ref,
        retained: [],
        rewritten: ["正文"],
        excluded: [],
      },
    },
    "derivation",
  );
  expect(rewrite.payload.parentRef).toEqual(ref);
  expect(derived.payload.derivedFrom).toEqual(ref);
  expect(await free.references.sources(task.conversationId)).toHaveLength(0);
  await candidateTool(
    free,
    task,
    "read_artifact",
    { draft_id: draft.id, draft_revision: "1", draft_hash: draft.draftHash },
    "actual-read",
  );
  expect(await free.references.sources(task.conversationId)).toMatchObject([
    { origin: "agent_read", invocation_id: "actual-read", ref },
  ]);
});
