import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
export interface ToolAuthConfig {
  tenantId: string;
  apiClientId: string;
  clientId: string;
  principalId: string;
}
export function createToolVerifier(
  config: ToolAuthConfig,
  key?: JWTVerifyGetKey,
) {
  const issuer = `https://login.microsoftonline.com/${config.tenantId}/v2.0`;
  const jwks =
    key ??
    createRemoteJWKSet(
      new URL(
        `https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`,
      ),
    );
  return async (authorization: string | undefined): Promise<"mochi-write"> => {
    if (!authorization?.startsWith("Bearer ") || authorization.length > 16384)
      throw new Error("Unauthorized");
    const { payload } = await jwtVerify(authorization.slice(7), jwks, {
      algorithms: ["RS256"],
      issuer,
      audience: config.apiClientId,
      requiredClaims: ["exp", "iat", "tid", "oid", "azp", "ver", "roles"],
    });
    if (
      payload.ver !== "2.0" ||
      payload.tid !== config.tenantId ||
      payload.oid !== config.principalId ||
      payload.azp !== config.clientId ||
      payload.scp !== undefined ||
      (payload.idtyp !== undefined && payload.idtyp !== "app") ||
      !Array.isArray(payload.roles) ||
      !payload.roles.includes("Write.Tools.Invoke")
    )
      throw new Error("Unauthorized");
    return "mochi-write";
  };
}
