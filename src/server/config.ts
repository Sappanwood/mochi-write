import { z } from "zod";

const origin = z.url().refine((value) => {
  const url = new URL(value);
  return (
    value === url.origin &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
  );
});
const schema = z.object({
  ENTRA_TENANT_ID: z.uuid(),
  ENTRA_OWNER_OID: z.uuid(),
  ENTRA_SPA_CLIENT_ID: z.uuid(),
  ENTRA_API_CLIENT_ID: z.uuid(),
  APP_ORIGIN: origin,
  COSMOS_ENDPOINT: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }),
  COSMOS_DATABASE: z
    .string()
    .regex(/^[a-zA-Z0-9-]+$/)
    .default("mochi-write"),
  AZURE_CLIENT_ID: z.uuid().optional(),
  HOST: z.enum(["127.0.0.1", "0.0.0.0", "::1"]).default("127.0.0.1"),
  PORT: z
    .string()
    .regex(/^\d+$/)
    .default("8080")
    .transform(Number)
    .pipe(z.number().int().min(0).max(65535)),
});

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(
      `Invalid configuration: ${[...new Set(result.error.issues.map((issue) => issue.path.join(".")))].join(", ")}`,
    );
  }
  const value = result.data;
  return {
    auth: {
      tenantId: value.ENTRA_TENANT_ID,
      ownerOid: value.ENTRA_OWNER_OID,
      spaClientId: value.ENTRA_SPA_CLIENT_ID,
      apiClientId: value.ENTRA_API_CLIENT_ID,
    },
    origin: value.APP_ORIGIN,
    cosmosEndpoint: value.COSMOS_ENDPOINT,
    cosmosDatabase: value.COSMOS_DATABASE,
    managedIdentityClientId: value.AZURE_CLIENT_ID,
    host: value.HOST,
    port: value.PORT,
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
