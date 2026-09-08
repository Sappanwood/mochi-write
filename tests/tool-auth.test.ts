import { beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createToolVerifier } from "../src/server/tool-auth.js";
const tenantId = "11111111-1111-4111-8111-111111111111";
const apiClientId = "22222222-2222-4222-8222-222222222222";
const clientId = "33333333-3333-4333-8333-333333333333";
const principalId = "44444444-4444-4444-8444-444444444444";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let verify: ReturnType<typeof createToolVerifier>;
async function token(claims: Record<string, unknown> = {}) {
  return new SignJWT({
    iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    aud: apiClientId,
    tid: tenantId,
    azp: clientId,
    oid: principalId,
    ver: "2.0",
    roles: ["Write.Tools.Invoke"],
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuedAt()
    .setExpirationTime(typeof claims.exp === "number" ? claims.exp : "5m")
    .sign(keys.privateKey);
}
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  verify = createToolVerifier(
    { tenantId, apiClientId, clientId, principalId },
    createLocalJWKSet({
      keys: [{ ...(await exportJWK(keys.publicKey)), kid: "test" }],
    }),
  );
});
describe("Mochi callback identity", () => {
  it("maps signed role-bearing app-only credentials to the fixed application", async () => {
    await expect(verify(`Bearer ${await token()}`)).resolves.toBe(
      "mochi-write",
    );
  });
  it.each([
    { scp: "Write.Access" },
    { scp: "" },
    { roles: [] },
    { oid: "foreign" },
    { azp: "foreign" },
    { tid: "foreign" },
    { aud: "foreign" },
    { iss: "https://foreign.example" },
    { ver: "1.0" },
    { exp: 1 },
  ])("rejects mismatched/delegated/expired identity %j", async (claims) => {
    await expect(verify(`Bearer ${await token(claims)}`)).rejects.toThrow();
  });
  it("rejects malformed and unsigned credentials", async () => {
    for (const value of [undefined, "Basic x", "Bearer x"])
      await expect(verify(value)).rejects.toThrow();
  });
});
