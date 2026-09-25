import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { FreeSession } from "../src/server/free-session.js";
import { freeTaskDto } from "../src/server/free-routes.js";
import { entity } from "../src/server/entities.js";
import { AppError } from "../src/shared/model.js";
import type { FreeTask } from "../src/shared/free.js";
import { MemoryStore } from "./support/memory-store.js";
import { MemoryFreeStore } from "./support/free-store.js";

type Driver = {
  run(
    task: FreeTask,
    field: "executionRun" | "intentRun",
    sessionId: string,
    phase: "execute" | "intent",
  ): Promise<unknown>;
};
async function fixture() {
  const content = new MemoryStore();
  const id = randomUUID();
  const story = await content.commit(
    {
      ...entity(
        "story",
        {
          name: "灯塔",
          markdown: "",
          genres: [],
          ageBand: "",
          sourceMetadata: {},
        },
        id,
        id,
      ),
      status: "ready",
    },
    null,
  );
  content.heads.set(`${id}:${id}`, {
    ...story,
    guidance: "慢热；不要提前揭晓身份。",
  });
  const free = new FreeSession(
    content,
    new MemoryFreeStore(content),
    {
      async request<T>(path: string, body?: unknown): Promise<T> {
        if (!body) throw new AppError(404, "not_found");
        return {
          session_id: path.split("/")[3],
          run_id: randomUUID(),
          status: "succeeded",
          result: { text: "草稿" },
        } as T;
      },
    },
    { autoStart: false },
  );
  const input = () => ({
    clientRequestId: randomUUID(),
    message: "预览下一章",
    provider: "fake",
    model: "fake",
  });
  const start = await free.start(input());
  const bind = (task: FreeTask) =>
    free.change(task.id, (t) => {
      t.storyAllowlist = [id];
      t.draftContext = {
        mode: "existing_story",
        target: { kind: "story", story_id: id },
        baseRevision: story.revision,
      };
    });
  const run = (task: FreeTask, phase: "execute" | "intent" = "execute") =>
    (free.workflow as unknown as Driver).run(
      task,
      phase === "execute" ? "executionRun" : "intentRun",
      randomUUID(),
      phase,
    );
  return { content, story, free, input, start, bind, run };
}

it("free writing freezes guidance for its target and exposes the exact injected snapshot", async () => {
  const f = await fixture();
  const task = await f.bind(f.start.task);
  await f.run(task);
  const saved = await f.free.task(task.id);
  const prompt = JSON.parse(saved.executionRun!.payload.prompt as string);
  expect(prompt.story_guidance).toEqual({
    story_id: f.story.id,
    story_version: 1,
    text: "慢热；不要提前揭晓身份。",
  });
  expect(prompt.guidance_policy).toContain("不授予");
  expect(freeTaskDto(saved).storyGuidance).toEqual(prompt.story_guidance);
  f.content.heads.set(`${f.story.id}:${f.story.id}`, {
    ...f.story,
    currentVersion: 2,
    guidance: "加快节奏",
  });
  await f.run(await f.free.task(task.id));
  expect((await f.free.task(task.id)).executionRun!.payload).toEqual(
    saved.executionRun!.payload,
  );
  const next = await f.free.start(f.input());
  await f.run(await f.bind(next.task));
  expect(
    JSON.parse(
      (await f.free.task(next.task.id)).executionRun!.payload.prompt as string,
    ).story_guidance.text,
  ).toBe("加快节奏");
});

it("does not send guidance to the intent interpreter or unrelated asset creation", async () => {
  const f = await fixture();
  await f.run(await f.bind(f.start.task), "intent");
  expect(
    (await f.free.task(f.start.task.id)).intentRun!.payload.prompt,
  ).not.toContain("慢热");
  const task = await f.free.change(f.start.task.id, (t) => {
    t.draftContext = { mode: "new_character", baseRevision: null };
  });
  await f.run(task);
  expect(
    JSON.parse(
      (await f.free.task(task.id)).executionRun!.payload.prompt as string,
    ).story_guidance,
  ).toBeNull();
});

it("does not guess a story across multiple contexts and enforces the story allowlist", async () => {
  const f = await fixture();
  const task = await f.free.change(f.start.task.id, (t) => {
    t.storyAllowlist = [f.story.id, randomUUID()];
  });
  await f.run(task);
  expect(
    JSON.parse(
      (await f.free.task(task.id)).executionRun!.payload.prompt as string,
    ).story_guidance,
  ).toBeNull();
  const next = await f.free.start(f.input());
  await f.bind(next.task);
  const invalid = await f.free.change(next.task.id, (t) => {
    t.storyAllowlist = [];
  });
  await expect(f.run(invalid)).rejects.toMatchObject({ statusCode: 403 });
});

it("sends an empty current snapshot after clearing instead of inheriting historical guidance", async () => {
  const f = await fixture();
  f.content.heads.set(`${f.story.id}:${f.story.id}`, {
    ...f.story,
    guidance: "",
  });
  await f.run(await f.bind(f.start.task));
  const task = await f.free.task(f.start.task.id);
  expect(
    JSON.parse(task.executionRun!.payload.prompt as string).story_guidance.text,
  ).toBe("");
});
