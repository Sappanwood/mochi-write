import assert from "node:assert/strict";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import console from "node:console";
import { FREE_TOOLS } from "../../src/server/free-tools.ts";
import { exactRefSchema } from "../../src/shared/free.ts";
assert.ok(
  process.env.MOCHI_REPO_ROOT && isAbsolute(process.env.MOCHI_REPO_ROOT),
);
const { AppTools } = await import(
  pathToFileURL(join(process.env.MOCHI_REPO_ROOT, "src/app-tools.ts"))
);
const tools = new AppTools({
  "mochi-write": {
    endpoint: "https://write.test/api/agent/tools",
    operations_endpoint: "https://write.test/api/agent/operations",
    audience: "api://write",
    tools: FREE_TOOLS.map(({ name, version, effect }) => ({
      name,
      version,
      effect,
    })),
  },
});
tools.validate("mochi-write", FREE_TOOLS, 2);
const save = FREE_TOOLS.find((tool) => tool.name === "save_character");
const candidate = {
  type: "candidate",
  group_id: "group",
  draft_id: "draft",
  draft_revision: "1",
  draft_hash: "sha256:" + "a".repeat(64),
};
const draft = {
  mode: "draft",
  name: "合成角色",
  markdown: "合成正文",
  genres: [],
  age_band: "",
};
assert.equal(exactRefSchema.safeParse(candidate).success, true);
tools.validateArguments(save, {
  ...draft,
  group_id: candidate.group_id,
  parent_ref: candidate,
});
const invalid = { ...candidate, kind: "character" };
assert.equal(exactRefSchema.safeParse(invalid).success, false);
assert.throws(
  () =>
    tools.validateArguments(save, {
      ...draft,
      group_id: candidate.group_id,
      parent_ref: invalid,
    }),
  /invalid_arguments/,
);
for (const ref of [
  candidate,
  { ...candidate, member_id: "member" },
  {
    type: "asset",
    kind: "character",
    asset_id: "b963f759-d0d9-41cf-973c-f03e45b13948",
    revision: "rev",
    version: 1,
    content_hash: "sha256:" + "b".repeat(64),
  },
]) {
  assert.equal(exactRefSchema.safeParse(ref).success, true);
  tools.validateArguments(save, { ...draft, derived_from: ref });
}
for (const ref of [
  { ...candidate, asset_id: "wrong" },
  { type: "candidate" },
  { ...candidate, draft_revision: "2" },
]) {
  assert.equal(exactRefSchema.safeParse(ref).success, false);
  assert.throws(
    () => tools.validateArguments(save, { ...draft, derived_from: ref }),
    /invalid_arguments/,
  );
}
console.log(
  "free reference schema: actual Mochi validation preserves asset/candidate/member refs and rejects mixed or incomplete identities",
);
