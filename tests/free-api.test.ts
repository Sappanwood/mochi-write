import { it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { registerFree } from "../src/server/free-routes.js";
import { FreeSession } from "../src/server/free-session.js";
import { MemoryStore } from "./support/memory-store.js";
import { MemoryFreeStore } from "./support/free-store.js";
import type { FastifyInstance } from "fastify";
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
async function fixture() {
  const origin = "http://localhost:18080";
  const config = loadConfig({
    ENTRA_TENANT_ID: randomUUID(),
    ENTRA_OWNER_OID: randomUUID(),
    ENTRA_SPA_CLIENT_ID: randomUUID(),
    ENTRA_API_CLIENT_ID: randomUUID(),
    APP_ORIGIN: origin,
    COSMOS_ENDPOINT: "https://example.documents.azure.com",
  });
  const app = await createApp({
    config,
    checkStorage: async () => {},
    verify: async (h) => {
      if (h !== "Bearer person") throw Error();
    },
  });
  apps.push(app);
  const free = new FreeSession(
    new MemoryStore(),
    new MemoryFreeStore(),
    {
      async request() {
        throw Error("No model call");
      },
    },
    { autoStart: false },
  );
  registerFree(app, free);
  return {
    app,
    free,
    headers: { authorization: "Bearer person", origin },
    root: "/api/creative/free",
    input: {
      clientRequestId: randomUUID(),
      message: "讨论角色",
      provider: "fake",
      model: "fake",
    },
  };
}
it("serves the accepted scoped task wire and rejects cross-conversation access", async () => {
  const f = await fixture();
  const { conversation, task } = (
    await f.app.inject({
      method: "POST",
      url: f.root + "/conversations",
      headers: f.headers,
      payload: f.input,
    })
  ).json();
  const get = await f.app.inject({
    url: `${f.root}/conversations/${conversation.id}/tasks/${task.id}`,
    headers: f.headers,
  });
  expect(get.statusCode).toBe(200);
  expect(get.json().task.id).toBe(task.id);
  const descriptor = (
    await f.app.inject({
      url: `${f.root}/conversations/${conversation.id}`,
      headers: f.headers,
    })
  ).json();
  expect(descriptor.conversation.id).toBe(conversation.id);
  expect(
    (
      await f.app.inject({
        url: `${f.root}/conversations/${randomUUID()}/tasks/${task.id}`,
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(403);
});
it("cancel stays HTTP202 while original remote stop is unknown", async () => {
  const f = await fixture();
  const { conversation, task } = await f.free.start(f.input);
  await f.free.change(task.id, (t) => {
    t.executionRun = {
      key: "original",
      sessionId: randomUUID(),
      dispatchStarted: true,
      payload: {},
    };
  });
  const response = await f.app.inject({
    method: "POST",
    url: `${f.root}/conversations/${conversation.id}/tasks/${task.id}/cancel`,
    headers: f.headers,
    payload: {},
  });
  expect(response.statusCode).toBe(202);
  expect(response.json().state).toBe("cancel_pending");
});
it("new API rejects authority claims and honors person authentication", async () => {
  const f = await fixture();
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: f.root + "/conversations",
        headers: f.headers,
        payload: {
          ...f.input,
          target: { kind: "character", asset_id: randomUUID() },
        },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await f.app.inject({ url: f.root + "/conversations" })).statusCode,
  ).toBe(401);
});
it("discovers scoped candidates and opens precise versions through person API", async () => {
  const f = await fixture();
  const { conversation, task } = await f.free.start(f.input);
  await f.free.change(task.id, (t) => {
    t.draftContext = { mode: "new_character", baseRevision: null };
    t.state = "authorized";
  });
  const d = await f.free.candidates.freeze(
    await f.free.task(task.id),
    {
      artifactKind: "character",
      content: {
        name: "同名",
        markdown: "old",
        genres: [],
        ageBand: "",
        sourceMetadata: {},
      },
    },
    "one",
  );
  const base = `${f.root}/conversations/${conversation.id}`;
  const response = await f.app.inject({
    url: base + "/groups",
    headers: f.headers,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().items[0].id).toBe(d.groupId);
  const found = await f.app.inject({
    url: base + "/discover?kind=candidate&query=同名",
    headers: f.headers,
  });
  expect(found.statusCode).toBe(200);
  expect(found.json().items[0].draft_id).toBe(d.id);
  const selected = await f.app.inject({
    method: "POST",
    url: base + "/references/resolve",
    headers: f.headers,
    payload: f.free.candidates.ref(d),
  });
  expect(selected.statusCode).toBe(200);
  expect(selected.json().ref).toEqual(f.free.candidates.ref(d));
  expect(await f.free.references.sources(conversation.id)).toHaveLength(0);
  expect((await f.free.task(task.id)).binding).toBeUndefined();
});
it("discovers same names without bodies, rejects stale selections, and returns exact or unavailable history", async () => {
  const f = await fixture();
  const { conversation, task } = await f.free.start(f.input);
  const { entity, clean } = await import("../src/server/entities.js");
  const first = await f.free.content.commit(
    entity("character", {
      name: "同名",
      markdown: "v1",
      genres: [],
      ageBand: "",
      sourceMetadata: {},
    }),
    null,
  );
  await f.free.content.commit(
    entity("character", { ...first.content, markdown: "other" }),
    null,
  );
  const base = `${f.root}/conversations/${conversation.id}`;
  const found = await f.app.inject({
    url: base + "/discover?kind=character&query=同名",
    headers: f.headers,
  });
  expect(found.statusCode).toBe(200);
  expect(found.json().items).toHaveLength(2);
  expect(JSON.stringify(found.json())).not.toContain("markdown");
  const selection = found
    .json()
    .items.find((r: { asset_id: string }) => r.asset_id === first.id);
  const { name: _name, ...locator } = selection;
  void _name;
  const selected = await f.app.inject({
    method: "POST",
    url: base + "/references/resolve",
    headers: f.headers,
    payload: locator,
  });
  expect(selected.statusCode).toBe(200);
  const ref = selected.json().ref;
  expect(await f.free.references.sources(conversation.id)).toHaveLength(0);
  await f.free.references.agentRead(
    await f.free.conversation(conversation.id),
    task.id,
    { asset_id: first.id, revision: first.revision },
    "read-first",
  );
  const changed = await f.free.content.commit(
    {
      ...clean(first),
      currentVersion: 2,
      content: { ...first.content, markdown: "changed" },
    },
    first.revision,
  );
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: base + "/references/resolve",
        headers: f.headers,
        payload: locator,
      })
    ).statusCode,
  ).toBe(409);
  await f.free.content.commit(
    {
      ...clean(changed),
      deleted: true,
      currentVersion: 3,
      content: { ...first.content, markdown: "v3" },
    },
    changed.revision,
  );
  const stale = await f.app.inject({
    method: "POST",
    url: base + "/references/resolve",
    headers: f.headers,
    payload: locator,
  });
  expect(stale.statusCode).toBe(404);
  const url =
    base + "/references?ref=" + encodeURIComponent(JSON.stringify(ref));
  const old = await f.app.inject({ url, headers: f.headers });
  expect(old.json()).toMatchObject({
    availability: "exact",
    content: { markdown: "v1" },
  });
  (f.free.content as MemoryStore).history.delete(first.id + ":1");
  const missing = await f.app.inject({ url, headers: f.headers });
  expect(missing.json()).toEqual({ ref, availability: "unavailable" });
  const unknown = { ...ref, asset_id: randomUUID() };
  expect(
    (
      await f.app.inject({
        url:
          base +
          "/references?ref=" +
          encodeURIComponent(JSON.stringify(unknown)),
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(403);
});
it("allows asset completion before the first message without exposing any conversation drafts", async () => {
  const f = await fixture();
  const { entity } = await import("../src/server/entities.js");
  const asset = await f.free.content.commit(
    entity("character", {
      name: "初始",
      markdown: "body",
      genres: [],
      ageBand: "",
      sourceMetadata: {},
    }),
    null,
  );
  const found = await f.app.inject({
    url: f.root + "/discover?kind=character",
    headers: f.headers,
  });
  expect(found.statusCode).toBe(200);
  expect(found.json().items[0].asset_id).toBe(asset.id);
  expect(
    (
      await f.app.inject({
        url: f.root + "/discover?kind=candidate",
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(400);
  const resolved = await f.app.inject({
    method: "POST",
    url: f.root + "/references/resolve",
    headers: f.headers,
    payload: {
      type: "asset",
      kind: "character",
      asset_id: asset.id,
      revision: asset.revision,
      version: 1,
    },
  });
  expect(resolved.statusCode).toBe(200);
  const started = await f.free.start({
    ...f.input,
    initialRefs: [resolved.json().ref],
  });
  expect(
    (await f.free.references.sources(started.conversation.id))[0]?.origin,
  ).toBe("initial");
});
it("discovers world, stories and story materials with their own identity and no source side effects", async () => {
  const f = await fixture();
  const { entity } = await import("../src/server/entities.js");
  const c = {
    name: "同名",
    markdown: "private body",
    genres: [],
    ageBand: "",
    sourceMetadata: {},
  };
  await f.free.content.commit(entity("world", c), null);
  const id = randomUUID();
  await f.free.content.commit(
    { ...entity("story", c, id, id), status: "ready" },
    null,
  );
  const setting = await f.free.content.commit(entity("setting", c, id), null);
  for (const query of [
    "kind=world",
    "kind=story",
    `kind=setting&story_id=${id}`,
  ]) {
    const response = await f.app.inject({
      url: f.root + "/discover?" + query,
      headers: f.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect(response.body).not.toContain("private body");
    if (query.startsWith("kind=setting"))
      expect(response.json().items[0]).toMatchObject({
        asset_id: setting.id,
        story_id: id,
      });
  }
  expect(
    (
      await f.app.inject({
        url: f.root + "/discover?kind=setting",
        headers: f.headers,
      })
    ).statusCode,
  ).toBe(400);
  expect(await f.free.records.list("source")).toHaveLength(0);
});
