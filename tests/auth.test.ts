import { beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createVerifier } from "../src/server/auth.js";

const tenant = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
const spa = "33333333-3333-4333-8333-333333333333";
const audience = "44444444-4444-4444-8444-444444444444";
const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let verify: ReturnType<typeof createVerifier>;

async function token(claims: Record<string, unknown> = {}, expired = false) {
  return new SignJWT({
    iss: issuer,
    aud: audience,
    tid: tenant,
    oid: owner,
    azp: spa,
    scp: "Write.Access",
    ver: "2.0",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuedAt()
    .setExpirationTime(expired ? "0s" : "5m")
    .sign(keys.privateKey);
}

beforeAll(async () => {
  keys = await generateKeyPair("RS256");
  const jwk = await exportJWK(keys.publicKey);
  verify = createVerifier(
    {
      tenantId: tenant,
      ownerOid: owner,
      spaClientId: spa,
      apiClientId: audience,
    },
    createLocalJWKSet({ keys: [{ ...jwk, kid: "test" }] }),
  );
});

describe("personal API access", () => {
  it("accepts the owner delegated access token", async () => {
    await expect(verify(`Bearer ${await token()}`)).resolves.toBeUndefined();
  });
  it.each([undefined, "", "Basic arbitrary", "Bearer arbitrary"])(
    "rejects missing or malformed credentials: %s",
    async (header) => {
      await expect(verify(header)).rejects.toThrow();
    },
  );
  it.each([
    { oid: "another-user" },
    { tid: "another-tenant" },
    { azp: "another-client" },
    { aud: "another-api" },
    { iss: "https://attacker.example" },
    { scp: "Other.Access" },
    { scp: undefined, roles: ["Write.Access"], idtyp: "app" },
    { idtyp: "app" },
    { ver: "1.0" },
  ])("rejects identity or permission mismatch: %j", async (claims) => {
    await expect(verify(`Bearer ${await token(claims)}`)).rejects.toThrow();
  });
  it("rejects expired tokens", async () => {
    await expect(verify(`Bearer ${await token({}, true)}`)).rejects.toThrow();
  });
  it("rejects a signature from an untrusted key", async () => {
    const rogue = await generateKeyPair("RS256");
    const forged = await new SignJWT({
      tid: tenant,
      oid: owner,
      azp: spa,
      scp: "Write.Access",
      ver: "2.0",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime("5m")
      .sign(rogue.privateKey);
    await expect(verify(`Bearer ${forged}`)).rejects.toThrow();
  });
});
