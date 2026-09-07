import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface AuthConfig {
  tenantId: string;
  ownerOid: string;
  spaClientId: string;
  apiClientId: string;
}

export function createVerifier(config: AuthConfig, key?: JWTVerifyGetKey) {
  const issuer = `https://login.microsoftonline.com/${config.tenantId}/v2.0`;
  const jwks =
    key ??
    createRemoteJWKSet(
      new URL(
        `https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`,
      ),
    );
  return async (authorization: string | undefined): Promise<void> => {
    if (!authorization?.startsWith("Bearer ") || authorization.length > 16384)
      throw new Error("Unauthorized");
    const { payload } = await jwtVerify(authorization.slice(7), jwks, {
      algorithms: ["RS256"],
      issuer,
      audience: config.apiClientId,
      requiredClaims: ["exp", "iat", "tid", "oid", "azp", "scp", "ver"],
    });
    if (
      payload.ver !== "2.0" ||
      payload.tid !== config.tenantId ||
      payload.oid !== config.ownerOid ||
      payload.azp !== config.spaClientId ||
      payload.idtyp === "app" ||
      typeof payload.scp !== "string" ||
      !payload.scp.split(" ").includes("Write.Access")
    ) {
      throw new Error("Unauthorized");
    }
  };
}
