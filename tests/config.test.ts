import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";

const env = {
  ENTRA_TENANT_ID: "11111111-1111-4111-8111-111111111111",
  ENTRA_OWNER_OID: "22222222-2222-4222-8222-222222222222",
  ENTRA_SPA_CLIENT_ID: "33333333-3333-4333-8333-333333333333",
  ENTRA_API_CLIENT_ID: "44444444-4444-4444-8444-444444444444",
  APP_ORIGIN: "http://127.0.0.1:18080",
  COSMOS_ENDPOINT: "https://example.documents.azure.com:443/",
};

describe("startup configuration", () => {
  it("enables service identity only with an explicit client/principal pair", () => {
    expect(loadConfig(env).toolAuth).toBeUndefined();
    for (const field of ["MOCHI_TOOLS_CLIENT_ID", "MOCHI_TOOLS_PRINCIPAL_ID"])
      expect(() =>
        loadConfig({ ...env, [field]: env.ENTRA_SPA_CLIENT_ID }),
      ).toThrow(/together/);
    expect(
      loadConfig({
        ...env,
        MOCHI_TOOLS_CLIENT_ID: env.ENTRA_SPA_CLIENT_ID,
        MOCHI_TOOLS_PRINCIPAL_ID: env.ENTRA_OWNER_OID,
      }).toolAuth,
    ).toEqual({
      tenantId: env.ENTRA_TENANT_ID,
      apiClientId: env.ENTRA_API_CLIENT_ID,
      clientId: env.ENTRA_SPA_CLIENT_ID,
      principalId: env.ENTRA_OWNER_OID,
    });
  });
  it("requires explicit identity, origin and database configuration", () => {
    expect(() => loadConfig({})).toThrow();
    for (const key of Object.keys(env)) {
      expect(() => loadConfig({ ...env, [key]: undefined })).toThrow();
    }
  });
  it("defaults to loopback and the application database", () => {
    const config = loadConfig(env);
    expect(config.host).toBe("127.0.0.1");
    expect(config.cosmosDatabase).toBe("mochi-write");
    expect(config.auth.ownerOid).toBe(env.ENTRA_OWNER_OID);
  });
  it.each([
    "http://public.example",
    "https://example.com/path",
    "https://user:secret@example.com",
    "https://example.com?x=1",
  ])("rejects an insecure or non-origin application URL: %s", (origin) => {
    expect(() => loadConfig({ ...env, APP_ORIGIN: origin })).toThrow();
  });
  it.each(["-1", "65536", "8080x", ""])(
    "rejects invalid listening ports: %s",
    (port) => {
      expect(() => loadConfig({ ...env, PORT: port })).toThrow();
    },
  );
  it("accepts an ephemeral port for isolated tests", () => {
    expect(loadConfig({ ...env, PORT: "0" }).port).toBe(0);
  });
  it("does not leak configuration values through validation errors", () => {
    expect(() =>
      loadConfig({ ...env, ENTRA_TENANT_ID: "private-invalid-value" }),
    ).toThrow(/ENTRA_TENANT_ID/);
    try {
      loadConfig({ ...env, ENTRA_TENANT_ID: "private-invalid-value" });
    } catch (error) {
      expect(String(error)).not.toContain("private-invalid-value");
    }
  });
});
