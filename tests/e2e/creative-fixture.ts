import { resolve } from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import fastifyStatic from "@fastify/static";
import { createApp } from "../../src/server/app.js";
import { createVerifier } from "../../src/server/auth.js";
import { loadConfig } from "../../src/server/config.js";
import { registerBusiness } from "../../src/server/routes.js";
import { registerCreative } from "../../src/server/creative-routes.js";
import { AppError } from "../../src/shared/model.js";
import { Creative } from "../../src/server/creative.js";
import { MemoryStore } from "../support/memory-store.js";
import { MemoryCreativeStore } from "../support/creative-store.js";
import { FakeCreativeMochi } from "../support/creative-mochi.js";
import { importFiles } from "../../src/server/import.js";
import { readBundle } from "../../src/server/filesystem.js";
import { randomUUID } from "node:crypto";
export class BrowserMochi extends FakeCreativeMochi {
  toolEvents: {
    cursor: number;
    type: string;
    data: Record<string, unknown>;
    created_at: string;
  }[] = [];
  paginateEvents = false;
  failCancel = false;
  verification: { operation_id: string; status: string }[] = [];
  override async request<T>(path: string, body?: unknown): Promise<T> {
    if (path.includes("/events?")) {
      this.calls.push({ path });
      if (this.paginateEvents) {
        const after = Number(
          new URL(path, "https://mochi.invalid").searchParams.get("after") ?? 0,
        );
        const events = this.toolEvents
          .filter((event) => event.cursor > after)
          .slice(0, 100);
        return { events, next_cursor: events.at(-1)?.cursor ?? after } as T;
      }
      // Deliberately replay the overlap to exercise cursor/invocation deduplication.
      return {
        events: this.toolEvents,
        next_cursor: this.toolEvents.at(-1)?.cursor ?? 0,
      } as T;
    }
    if (path.endsWith("/cancel") && this.failCancel) {
      this.calls.push({ path, body: body as Record<string, unknown> });
      throw new AppError(503, "synthetic unavailable");
    }
    if (path.endsWith("/operations/verify")) {
      this.calls.push({ path, body: body as Record<string, unknown> });
      return { operations: this.verification } as T;
    }
    return super.request<T>(path, body);
  }
}
export async function creativeFixture() {
  const config = loadConfig({
    ENTRA_TENANT_ID: "11111111-1111-4111-8111-111111111111",
    ENTRA_OWNER_OID: "22222222-2222-4222-8222-222222222222",
    ENTRA_SPA_CLIENT_ID: "33333333-3333-4333-8333-333333333333",
    ENTRA_API_CLIENT_ID: "44444444-4444-4444-8444-444444444444",
    APP_ORIGIN: "http://127.0.0.1:18080",
    COSMOS_ENDPOINT: "https://example.documents.azure.com/",
  });
  const keys = await generateKeyPair("RS256");
  const jwk = await exportJWK(keys.publicKey);
  const token = await new SignJWT({
    tid: config.auth.tenantId,
    oid: config.auth.ownerOid,
    azp: config.auth.spaClientId,
    scp: "Write.Access",
    ver: "2.0",
  })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(`https://login.microsoftonline.com/${config.auth.tenantId}/v2.0`)
    .setAudience(config.auth.apiClientId)
    .setIssuedAt()
    .setExpirationTime("20m")
    .sign(keys.privateKey);
  const store = new MemoryStore();
  const server = await createApp({
    config,
    verify: createVerifier(
      config.auth,
      createLocalJWKSet({ keys: [{ ...jwk, kid: "fixture" }] }),
    ),
    checkStorage: async () => {},
  });
  registerBusiness(server, store);
  const records = new MemoryCreativeStore(store);
  const mochi = new BrowserMochi();
  const creative = new Creative(store, records, mochi, { pollMs: 10 });
  registerCreative(server, creative);
  server.get("/api/writing/models", async () => mochi.request("/v1/models"));
  server.get("/fixture-token", async (_request, reply) =>
    reply.header("cache-control", "no-store").send({ token }),
  );
  await server.register(fastifyStatic, {
    root: resolve(".data/browser"),
    wildcard: false,
  });
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  config.origin = address;
  await importFiles(
    store,
    await readBundle("tests/fixtures/novel"),
    randomUUID(),
  );
  const story = (await store.list({ kind: "story" })).items[0]!;
  return {
    address,
    server,
    store,
    records,
    mochi,
    creative,
    story,
    close: async () => {
      await creative.close();
      server.server.closeAllConnections();
      await server.close();
    },
  };
}
